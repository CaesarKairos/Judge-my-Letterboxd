"""End-to-end CLI: at most two AI calls, auditable outputs, never a disguised fallback."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from zipfile import ZipFile

import app
from src.gemini_client import analyze_semantically

ARCHETYPE = ['espacial', 'adolescente', 'existencial', 'romântico']


def writer_payload(request: dict) -> dict:
    return json.loads(request['contents'])


def valid_response(request: dict, line: str = 'Reação curta.', mutate=None) -> tuple[str, dict]:
    """A contract-valid Final Writer response for exactly the moments the Script Engine selected."""
    payload = writer_payload(request)
    pair = payload['opening_slots']['adjective_pairs_allowed'][0]
    body = {'opening': {'salutation': payload['opening_slots']['salutation_allowed'][0],
                        'top_four_archetype': list(ARCHETYPE),
                        'negative_adjective': pair['negative'], 'positive_adjective': pair['positive'],
                        'profile_reaction': []},
            'beats': [{'beat_id': moment['beat_id'], 'lines': [{'text': line, 'effect': 'none'}]}
                      for moment in payload['moments']],
            'closer': {'lines': []}}
    if mutate:
        mutate(body)
    return json.dumps(body, ensure_ascii=False), {'served_model': 'synthetic-model'}


def writer_side_effect(line: str = 'Reação curta.', mutate=None):
    """Adapt the client signature (api_key, request, note) to the response builder."""
    return lambda api_key, request, note=None: valid_response(request, line=line, mutate=mutate)


def analyst_side_effect(count: int = 2):
    def respond(api_key, request, note=None):
        payload = json.loads(request['contents'])
        films = payload['films']
        findings = []
        for index in range(min(count, len(films))):
            film = films[index]
            findings.append({
                'id': f'semantic_{index:03}',
                'type': 'meaningful_exception',
                'interestingness': .9,
                'confidence': .95,
                'observation': 'Este filme cria um momento editorial específico.',
                'why_interesting': 'É concreto o bastante para receber uma reação curta.',
                'cultural_angle': '',
                'evidence': [{'source_type': 'film', 'source_id': film['key'], 'focus_text': ''}],
                'film_keys': [film['key']],
                'related_tags': [],
                'related_lists': [],
            })
        return json.dumps({'semantic_findings': findings}, ensure_ascii=False), {'served_model': 'synthetic-analyst'}
    return respond


class CLITests(unittest.TestCase):
    def prepare(self, root: Path, films: int = 8) -> None:
        (root / 'prompts').mkdir()
        for name in ('analyst.txt', 'writer.txt'):
            (root / 'prompts' / name).write_text('Synthetic prompt', encoding='utf-8')
        with ZipFile(root / 'synthetic.zip', 'w') as archive:
            archive.writestr('profile.csv', 'Username,Name,Favorite Films,Email Address\nsynthetic,Synthetic,,\n')
            archive.writestr('ratings.csv', 'Name,Year,Rating\n' +
                             ''.join(f'Film {i},2000,5\n' for i in range(films)))
            archive.writestr('deleted/reviews.csv', 'Name,Year,Rating,Review\nOld Film,1999,1,old\n')

    def run_app(self, root: Path, arguments: list[str], api_key: str = '',
                extra_env: dict | None = None) -> int:
        environment = {'GEMINI_API_KEY': api_key, 'MAX_CONTEXT_CHARS': '300000', 'GEMINI_FALLBACK_MODELS': '',
                       'GEMINI_MODEL': 'gemini-flash-latest', 'MODEL_DISCOVERY': '0'}
        environment.update(extra_env or {})
        with patch.object(app, 'ROOT', root), patch.object(app.Path, 'cwd', return_value=root), \
                patch('sys.argv', ['app.py'] + arguments), \
                patch.dict(os.environ, environment), \
                contextlib.redirect_stdout(io.StringIO()):
            return app.main()

    def read(self, root: Path, name: str):
        return json.loads((root / 'output' / name).read_text(encoding='utf-8'))

    def test_discovery_none_single_multiple(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            root = Path(directory)
            self.assertIsNone(app.choose_zip(root))
            (root / 'a.zip').touch()
            self.assertEqual(app.choose_zip(root).name, 'a.zip')
            (root / 'b.ZIP').touch()
            with patch('builtins.input', side_effect=['bad', '9', '2']):
                self.assertEqual(app.choose_zip(root).name, 'b.ZIP')

    def test_without_key_and_dry_run_build_structural_presentation(self):
        with tempfile.TemporaryDirectory() as directory, patch('src.generation.analyze_semantically') as analyst, \
                patch('src.generation.write_final') as writer:
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, []), 0)
            self.assertEqual(self.run_app(root, ['--dry-run'], 'synthetic-key'), 0)
            analyst.assert_not_called()
            writer.assert_not_called()
            script = self.read(root, 'presentation_script.json')
            self.assertEqual(script['render']['ai_generation'], 'skipped')
            self.assertEqual(self.read(root, 'run_status.json')['status'], 'local_only')
            self.assertIn('SEM REAÇÃO DE IA', (root / 'output' / 'judgment.txt').read_text(encoding='utf-8'))
            self.assertGreaterEqual(self.read(root, 'editorial_moments.json')['count'], 0)
            raw = self.read(root, 'raw_export.json')
            self.assertEqual(raw['file_count'], 3)
            self.assertIn('deleted/reviews.csv', [item['path'] for item in raw['files']])

    def test_full_run_makes_at_most_two_ai_calls(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', side_effect=analyst_side_effect()) as analyst, \
                patch('src.generation.write_final', side_effect=writer_side_effect()) as writer:
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, [], 'synthetic-key'), 0)
            self.assertEqual(analyst.call_count, 1)
            self.assertEqual(writer.call_count, 1)
            status = self.read(root, 'run_status.json')
            self.assertEqual(status['calls'], 2)
            self.assertEqual(status['status'], 'complete')
            self.assertTrue(status['judgment_generated'])
            self.assertEqual(writer.call_args.args[1]['fallback_models'], [])
            script = self.read(root, 'presentation_script.json')
            self.assertEqual(script['render']['ai_generation'], 'complete')
            self.assertTrue(any(event['type'] == 'message' for event in script['events']))
            analyst_payload = json.loads(analyst.call_args.args[1]['contents'])
            self.assertIn('raw_export', analyst_payload)
            self.assertEqual(analyst_payload['raw_export']['file_count'], 3)
    def test_writer_cannot_add_beats_or_events(self):
        def add_beat(body):
            body['beats'].append({'beat_id': 'beat_99', 'lines': [{'text': 'Beat fantasma.', 'effect': 'none'}]})

        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', side_effect=analyst_side_effect()), \
                patch('src.generation.write_final', side_effect=writer_side_effect(mutate=add_beat)):
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, [], 'synthetic-key'), 1)
            script = self.read(root, 'presentation_script.json')
            self.assertNotIn('Beat fantasma.', json.dumps(script, ensure_ascii=False))
            self.assertEqual(script['render']['ai_generation'], 'failed')
            self.assertEqual(self.read(root, 'run_status.json')['error']['reason'], 'final_writer_contract')

    def test_adjectives_outside_the_pool_fall_back_to_the_plan(self):
        def odd_pair(body):
            body['opening']['negative_adjective'] = 'chato'
            body['opening']['positive_adjective'] = 'podre'

        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', side_effect=analyst_side_effect()), \
                patch('src.generation.write_final', side_effect=writer_side_effect(mutate=odd_pair)):
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, [], 'synthetic-key'), 0)
            script = self.read(root, 'presentation_script.json')
            self.assertEqual(script['render']['ai_generation'], 'complete')
            self.assertTrue(any('adjective pair' in warning for warning in script['ai']['warnings']))
            self.assertNotIn('chato', json.dumps(script, ensure_ascii=False))

    def test_archetype_needs_exactly_four_concepts(self):
        def three(body):
            body['opening']['top_four_archetype'] = ARCHETYPE[:3]

        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', side_effect=analyst_side_effect()), \
                patch('src.generation.write_final', side_effect=writer_side_effect(mutate=three)):
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, [], 'synthetic-key'), 0)
            script = self.read(root, 'presentation_script.json')
            self.assertEqual(script['opening']['archetype'], [])
            self.assertTrue(any('exactly four' in warning for warning in script['ai']['warnings']))

    def test_quota_still_produces_a_valid_local_presentation(self):
        class QuotaError(Exception):
            code = 429

        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', side_effect=QuotaError()), \
                patch('src.generation.write_final') as writer:
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, [], 'synthetic-key'), 1)
            writer.assert_not_called()
            script = self.read(root, 'presentation_script.json')
            self.assertEqual(script['render']['ai_generation'], 'skipped')
            self.assertIn('SEM REAÇÃO DE IA', (root / 'output' / 'judgment.txt').read_text(encoding='utf-8'))
            self.assertIn('fallback', (root / 'output' / 'judgment.txt').read_text(encoding='utf-8').casefold())

    def test_analyze_only_never_calls_the_writer(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', side_effect=analyst_side_effect()) as analyst, \
                patch('src.generation.write_final') as writer:
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, ['--analyze-only'], 'synthetic-key'), 0)
            analyst.assert_called_once()
            writer.assert_not_called()
            self.assertEqual(self.read(root, 'run_status.json')['writer'], 'skipped')
            self.assertTrue(self.read(root, 'final_writer_request.json')['request'])
    def test_no_analyst_flag_is_debug_only_and_never_fakes_a_judgment(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically') as analyst, \
                patch('src.generation.write_final') as writer:
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, ['--no-analyst'], 'synthetic-key'), 0)
            analyst.assert_not_called()
            writer.assert_not_called()
            status = self.read(root, 'run_status.json')
            self.assertEqual(status['analyst'], 'skipped_by_flag')
            self.assertFalse(status['judgment_generated'])

    def test_model_discovery_runs_once_and_is_audited(self):
        listing = [{'name': 'models/gemini-flash-latest', 'supportedGenerationMethods': ['generateContent']},
                   {'name': 'models/text-embedding-004', 'supportedGenerationMethods': ['embedContent']},
                   {'name': 'models/gemini-2.5-flash-preview-tts', 'supportedGenerationMethods': ['generateContent']}]
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.list_models', return_value=listing) as discovery, \
                patch('src.generation.analyze_semantically', side_effect=analyst_side_effect()), \
                patch('src.generation.write_final', side_effect=writer_side_effect()):
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, [], 'synthetic-key', {'MODEL_DISCOVERY': '1'}), 0)
            discovery.assert_called_once()
            record = self.read(root, 'model_discovery.json')
            self.assertEqual(record['discovery']['status'], 'ok')
            self.assertEqual(record['discovered_models'], ['gemini-flash-latest'])
            self.assertEqual({item['model'] for item in record['rejected']},
                             {'text-embedding-004', 'gemini-2.5-flash-preview-tts'})
            self.assertEqual(record['writer_chain'], ['gemini-flash-latest'])
            self.assertEqual(record['analyst_chain'], ['gemini-flash-latest'])

    def test_validated_cache_avoids_repeating_calls(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', side_effect=analyst_side_effect()) as analyst, \
                patch('src.generation.write_final', side_effect=writer_side_effect()) as writer:
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, [], 'synthetic-key'), 0)
            self.assertEqual(self.run_app(root, [], 'synthetic-key'), 0)
            self.assertEqual(analyst.call_count, 1)
            self.assertEqual(writer.call_count, 1)
            self.assertEqual(self.read(root, 'final_writer_response.json')['response_origin'], 'cache')

    def test_sdk_configuration_without_network(self):
        from google.genai import types
        request = {'model': 'synthetic-model', 'contents': '{}',
                   'config': {'system_instruction': 'test', 'temperature': .8}}
        response = MagicMock(text='ok')
        response.model_dump.return_value = {'text': 'ok'}
        with patch('google.genai.Client') as client:
            client.return_value.__enter__.return_value.models.generate_content.return_value = response
            self.assertEqual(analyze_semantically('synthetic-key', request),
                             ('ok', {'text': 'ok', 'served_model': 'synthetic-model'}))
            arguments = client.return_value.__enter__.return_value.models.generate_content.call_args.kwargs
            self.assertIsInstance(arguments['config'], types.GenerateContentConfig)
            self.assertEqual(arguments['contents'], '{}')

    def test_context_over_budget_is_reported_and_keeps_the_local_presentation(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically') as analyst, \
                patch('src.generation.write_final') as writer:
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, [], 'synthetic-key', {'MAX_CONTEXT_CHARS': '500'}), 1)
            analyst.assert_not_called()
            writer.assert_not_called()
            status = self.read(root, 'run_status.json')
            self.assertEqual(status['status'], 'context_too_large')
            self.assertEqual(status['error']['reason'], 'context_too_large')
            self.assertIn('MAX_CONTEXT_CHARS', status['error']['message'])
            self.assertIn('ANALYST_RAW_EXPORT=0', status['error']['hint'])
            script = self.read(root, 'presentation_script.json')
            self.assertEqual(script['render']['ai_generation'], 'skipped')
            self.assertGreaterEqual(len(script['events']), 10)
            explanation = (root / 'output' / 'judgment.txt').read_text(encoding='utf-8')
            self.assertIn('SEM REAÇÃO DE IA', explanation)
            self.assertIn('MAX_CONTEXT_CHARS', explanation)
            self.assertEqual(self.read(root, 'debug_report.txt')['coverage']['reason'], 'context_over_budget')

    def test_raw_export_can_be_disabled_for_huge_exports(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', side_effect=analyst_side_effect()) as analyst, \
                patch('src.generation.write_final', side_effect=writer_side_effect()):
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, [], 'synthetic-key', {'ANALYST_RAW_EXPORT': '0'}), 0)
            payload = json.loads(analyst.call_args.args[1]['contents'])
            self.assertNotIn('raw_export', payload)
            self.assertFalse(payload['coverage']['raw_export_included'])
            self.assertEqual(self.read(root, 'run_status.json')['status'], 'complete')


if __name__ == '__main__':
    unittest.main()