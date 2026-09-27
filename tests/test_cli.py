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


class CLITests(unittest.TestCase):
    def test_discovery_none_single_multiple(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            root = Path(directory)
            self.assertIsNone(app.choose_zip(root))
            (root / 'a.zip').touch()
            self.assertEqual(app.choose_zip(root).name, 'a.zip')
            (root / 'b.ZIP').touch()
            with patch('builtins.input', side_effect=['bad', '9', '2']):
                self.assertEqual(app.choose_zip(root).name, 'b.ZIP')

    def run_app(self, root: Path, arguments: list[str], api_key: str = '',
                extra_env: dict | None = None) -> int:
        environment = {'GEMINI_API_KEY': api_key, 'MAX_CONTEXT_CHARS': '300000', 'GEMINI_FALLBACK_MODELS': '',
                       'GEMINI_MODEL': 'gemini-flash-latest'}
        environment.update(extra_env or {})
        with patch.object(app, 'ROOT', root), patch.object(app.Path, 'cwd', return_value=root), \
                patch('sys.argv', ['app.py'] + arguments), \
                patch.dict(os.environ, environment), \
                contextlib.redirect_stdout(io.StringIO()):
            return app.main()

    def prepare(self, root: Path) -> None:
        (root / 'prompts').mkdir()
        for name in ('analyst.txt', 'writer.txt'):
            (root / 'prompts' / name).write_text('Synthetic prompt', encoding='utf-8')
        with ZipFile(root / 'synthetic.zip', 'w') as archive:
            archive.writestr('ratings.csv', 'Name,Year,Rating\nSynthetic,2000,4\n')

    def test_without_key_and_dry_run_never_call_gemini(self):
        with tempfile.TemporaryDirectory() as directory, patch('src.generation.analyze_semantically') as call, patch('src.generation.write_beat') as writer:
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, []), 0)
            self.assertEqual(self.run_app(root, ['--dry-run'], 'synthetic-key'), 0)
            call.assert_not_called()
            writer.assert_not_called()
            self.assertIn('Nenhum julgamento', (root / 'output' / 'judgment.txt').read_text(encoding='utf-8'))
            self.assertEqual(json.loads((root / 'output' / 'run_status.json').read_text())['gemini'], 'skipped')

    def test_exact_text_and_request_and_stale_response(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.prepare(root)
            response = '{"lines": ["Uma linha curta."]}'
            with patch('src.generation.analyze_semantically', return_value=('{"semantic_findings": []}', {})) as call, \
                    patch('src.generation.write_beat', return_value=(response, {'text': response})):
                self.assertEqual(self.run_app(root, [], 'synthetic-key'), 0)
                saved = json.loads((root / 'output' / 'ai_request.json').read_text(encoding='utf-8'))
                self.assertEqual(saved, call.call_args.args[1])
                audit = json.loads((root / 'output' / 'writer_inputs.json').read_text(encoding='utf-8'))
                self.assertEqual(audit[0]['raw_response'], response)
                self.assertEqual(audit[0]['parsed_lines'], ['Uma linha curta.'])
                self.assertTrue((root / 'output' / 'judgment.txt').read_text(encoding='utf-8').endswith('Uma linha curta.'))
            self.assertEqual(self.run_app(root, ['--dry-run']), 0)
            self.assertFalse((root / 'output' / 'ai_response.json').exists())

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

    def test_analyze_only_never_calls_writer(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', return_value=('{"semantic_findings": []}', {})) as analyst, \
                patch('src.generation.write_beat') as writer:
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, ['--analyze-only'], 'synthetic-key'), 0)
            analyst.assert_called_once()
            writer.assert_not_called()
            self.assertTrue((root / 'output' / 'script.json').exists())

    def test_analyst_failure_preserves_local_script(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', side_effect=RuntimeError('synthetic failure')), \
                patch('src.generation.write_beat') as writer:
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, [], 'synthetic-key'), 1)
            writer.assert_not_called()
            status = json.loads((root / 'output' / 'run_status.json').read_text())
            self.assertEqual(status['analyst'], 'failed')
            self.assertTrue((root / 'output' / 'script.json').exists())
            self.assertNotIn('synthetic-key', (root / 'output' / 'run_status.json').read_text())

    def test_invalid_writer_output_never_enters_judgment(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', return_value=('{"semantic_findings": []}', {})), \
                patch('src.generation.write_beat', return_value=('{"lines": ["999 inventados"]}', {})):
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, [], 'synthetic-key'), 1)
            self.assertNotIn('999', (root / 'output' / 'judgment.txt').read_text())
            audit = json.loads((root / 'output' / 'writer_inputs.json').read_text(encoding='utf-8'))
            self.assertIn('999', audit[0]['raw_response'])
            self.assertEqual(audit[0]['status'], 'rejected')
            self.assertEqual(audit[0]['parsed_lines'], ['999 inventados'])
            self.assertEqual(audit[0]['accepted_lines'], [])

    def test_quota_failure_stops_remaining_calls(self):
        class QuotaError(Exception):
            code = 429
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', return_value=('{"semantic_findings": []}', {})), \
                patch('src.generation.write_beat', side_effect=QuotaError()) as writer:
            root = Path(directory)
            self.prepare(root)
            with ZipFile(root / 'synthetic.zip', 'w') as archive:
                archive.writestr('ratings.csv', 'Name,Year,Rating\n' + ''.join(f'Film {i},2000,5\n' for i in range(8)))
            self.assertEqual(self.run_app(root, [], 'synthetic-key'), 1)
            writer.assert_called_once()
            audits = json.loads((root / 'output' / 'writer_inputs.json').read_text(encoding='utf-8'))
            self.assertGreater(len(audits), 1)
            self.assertEqual(audits[0]['error_code'], 429)
            self.assertTrue(all(a['status'] == 'skipped' for a in audits[1:]))

    def test_429_is_explained_and_previous_judgment_archived(self):
        class QuotaError(Exception):
            code = 429
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', side_effect=QuotaError()), \
                patch('src.generation.write_beat') as writer:
            root = Path(directory)
            self.prepare(root)
            output = root / 'output'
            output.mkdir()
            (output / 'judgment.txt').write_text('Resultado anterior real.', encoding='utf-8')
            self.assertEqual(self.run_app(root, [], 'synthetic-key'), 1)
            writer.assert_not_called()
            status = json.loads((output / 'run_status.json').read_text(encoding='utf-8'))
            self.assertFalse(status['judgment_generated'])
            self.assertEqual(status['error']['reason'], 'rate_limit_or_quota_exhausted')
            self.assertIn('429', (output / 'judgment.txt').read_text(encoding='utf-8'))
            self.assertEqual((output / status['previous_run'] / 'judgment.txt').read_text(encoding='utf-8'), 'Resultado anterior real.')

    def test_validated_cache_avoids_repeating_calls_and_tracks_prompt_changes(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', return_value=('{"semantic_findings": []}', {})) as analyst, \
                patch('src.generation.write_beat', return_value=('{"lines": ["Uma linha curta."]}', {})) as writer:
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, [], 'synthetic-key'), 0)
            self.assertEqual(self.run_app(root, [], 'synthetic-key'), 0)
            analyst.assert_called_once()
            writer.assert_called_once()
            (root / 'prompts' / 'writer.txt').write_text('Changed prompt', encoding='utf-8')
            self.assertEqual(self.run_app(root, [], 'synthetic-key'), 0)
            self.assertEqual(writer.call_count, 2)
            analyst.assert_called_once()

    def test_no_analyst_flag_writes_judgment_from_deterministic_findings(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically') as analyst, \
                patch('src.generation.write_beat', return_value=('{"lines": ["Uma linha curta."]}', {})):
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, ['--no-analyst'], 'synthetic-key'), 0)
            analyst.assert_not_called()
            output = root / 'output'
            status = json.loads((output / 'run_status.json').read_text(encoding='utf-8'))
            self.assertEqual(status['analyst'], 'skipped_by_flag')
            self.assertIn('--no-analyst', status['analyst_skip_reason'])
            self.assertNotIn('gemini', status)
            self.assertTrue(status['judgment_generated'])
            self.assertEqual(json.loads((output / 'semantic_findings.json').read_text(encoding='utf-8')), [])
            self.assertTrue((output / 'judgment.txt').read_text(encoding='utf-8').endswith('Uma linha curta.'))

    def test_fallback_models_from_env_enter_both_requests(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically',
                      return_value=('{"semantic_findings": []}', {})) as analyst, \
                patch('src.generation.write_beat', return_value=('{"lines": ["Uma linha curta."]}', {})):
            root = Path(directory)
            self.prepare(root)
            environment = {'GEMINI_FALLBACK_MODELS': 'reserve-one, reserve-two'}
            self.assertEqual(self.run_app(root, [], 'synthetic-key', environment), 0)
            self.assertEqual(analyst.call_args.args[1]['fallback_models'], ['reserve-one', 'reserve-two'])
            self.assertTrue(callable(analyst.call_args.args[2]))
            audits = json.loads((root / 'output' / 'writer_inputs.json').read_text(encoding='utf-8'))
            self.assertEqual(audits[0]['request']['fallback_models'], ['reserve-one', 'reserve-two'])
            status = json.loads((root / 'output' / 'run_status.json').read_text(encoding='utf-8'))
            self.assertEqual(status['model'], 'gemini-flash-latest')
            self.assertEqual(status['fallback_models'], ['reserve-one', 'reserve-two'])

    def test_quota_on_primary_model_is_answered_by_the_fallback_model(self):
        class QuotaError(Exception):
            code = 429

        def fake_call(api_key: str, model: str, request: dict):
            if model == 'gemini-flash-latest':
                raise QuotaError()
            return '{"lines": ["Uma linha curta."]}', {}

        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', return_value=('{"semantic_findings": []}', {})), \
                patch('src.gemini_client._call', side_effect=fake_call):
            root = Path(directory)
            self.prepare(root)
            environment = {'GEMINI_FALLBACK_MODELS': 'gemini-flash-lite-latest'}
            self.assertEqual(self.run_app(root, [], 'synthetic-key', environment), 0)
            audits = json.loads((root / 'output' / 'writer_inputs.json').read_text(encoding='utf-8'))
            self.assertEqual(audits[0]['served_model'], 'gemini-flash-lite-latest')
            self.assertEqual(audits[0]['model_attempts'][0]['model'], 'gemini-flash-latest')
            self.assertEqual(audits[0]['model_attempts'][0]['code'], 429)
            status = json.loads((root / 'output' / 'run_status.json').read_text(encoding='utf-8'))
            self.assertTrue(status['judgment_generated'])
            self.assertEqual(status['writer'], 'complete')

    def test_line_repeating_the_python_display_is_dropped_and_audited(self):
        def echo_display(api_key: str, request: dict, note=None):
            payload = json.loads(request['contents'])
            return json.dumps({'lines': payload['display']['lines']}, ensure_ascii=False), {}

        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', return_value=('{"semantic_findings": []}', {})), \
                patch('src.generation.write_beat', side_effect=echo_display):
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, [], 'synthetic-key'), 0)
            output = root / 'output'
            audits = json.loads((output / 'writer_inputs.json').read_text(encoding='utf-8'))
            opening = audits[0]
            self.assertEqual(opening['status'], 'validated')
            self.assertEqual(opening['accepted_lines'], [])
            self.assertEqual(opening['dropped_display_repeats'], opening['parsed_lines'])
            self.assertEqual((output / 'judgment.txt').read_text(encoding='utf-8').count(opening['parsed_lines'][0]), 1)

    def test_429_explanation_carries_actionable_hint(self):
        class QuotaError(Exception):
            code = 429
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.analyze_semantically', side_effect=QuotaError()), \
                patch('src.generation.write_beat') as writer:
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, [], 'synthetic-key'), 1)
            writer.assert_not_called()
            explanation = (root / 'output' / 'judgment.txt').read_text(encoding='utf-8')
            self.assertIn('429', explanation)
            self.assertIn('--no-analyst', explanation)
            self.assertIn('GEMINI_FALLBACK_MODELS', explanation)


if __name__ == '__main__':
    unittest.main()
