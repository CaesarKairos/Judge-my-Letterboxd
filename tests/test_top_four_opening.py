"""Regression: a malformed Writer archetype never deletes the opening joke."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import test_cli
from src.final_writer import validate_opening, validate_archetype_phrase
from src.opening import build_events, build_plan
from src.resources import bundle

LOCALE = bundle('pt-BR')
FILMS = [{'film_key': f'film_{i}', 'title': f'Film {i}', 'year': '2000', 'tags': []} for i in range(4)]


class Profile:
    handle = 'fixture_user'
    display_name = 'Fixture Name'
    films = {}


def texts(events):
    return [e['segments'][0]['text'] for e in events if e['type'] == 'message']


class TopFourOpeningTests(unittest.TestCase):
    def setUp(self):
        self.plan = build_plan(Profile(), {'rated_films': 4}, LOCALE)
        self.plan['archetype_requested'] = True
        self.overview = {'username': 'fixture_user'}

    def opening(self, concepts, phrase):
        return {'salutation': LOCALE.salutations()[0],
                'negative_adjective': LOCALE.adjective_pairs()[0]['negative'],
                'positive_adjective': LOCALE.adjective_pairs()[0]['positive'],
                'archetype_concepts': concepts, 'archetype_phrase': phrase,
                'profile_reaction': []}

    def test_composed_phrase_and_connectors_remain_literal(self):
        concepts = ['caubói do deserto', 'engenharia genética', 'androide da cidade', 'filme de matinê']
        for phrase in ('caubói-genético-e-androide-da-matinê', 'androide de matinê do deserto'):
            with self.subTest(phrase=phrase):
                opening, warnings = validate_opening(self.opening(concepts, phrase), self.plan, LOCALE, self.overview)
                self.assertEqual(warnings, [])
                self.assertEqual(opening['archetype_phrase'], phrase)
                self.assertEqual(opening['archetype'], concepts)
                self.assertTrue(opening['top_four_archetype']['valid'])
                self.assertFalse(opening['top_four_archetype']['fallback_used'])

    def test_concept_audit_cannot_discard_a_safe_phrase(self):
        opening, warnings = validate_opening(self.opening(['one', 'two', 'three'], 'androide-de-matinê'),
                                             self.plan, LOCALE, self.overview)
        self.assertTrue(any('exactly four' in w for w in warnings))
        self.assertEqual(opening['archetype_phrase'], 'androide-de-matinê')
        self.assertNotIn('one or two plain words', str(warnings))

    def test_repair_and_oversized_phrase(self):
        phrase = '  “caubói genético\n e androide da matinê.”  '
        opening, _ = validate_opening(self.opening(['a', 'b', 'c', 'd'], phrase), self.plan, LOCALE, self.overview)
        self.assertEqual(opening['archetype_phrase'], 'caubói genético e androide da matinê')
        self.assertTrue(opening['top_four_archetype']['repaired'])
        long = 'androide da estrada ' * 5
        cleaned, problems = validate_archetype_phrase(long, self.overview)
        self.assertFalse(problems)
        self.assertLessEqual(len(cleaned), 70)
        self.assertFalse(cleaned.endswith('-'))

    def test_sensitive_phrase_falls_back_but_scene_survives(self):
        for phrase in ('diagnóstico-de-androide', 'raça-e-matinê', '<script>x</script>', 'x' * 71):
            with self.subTest(phrase=phrase):
                opening, warnings = validate_opening(self.opening(['a', 'b', 'c', 'd'], phrase),
                                                     self.plan, LOCALE, self.overview)
                self.assertFalse(opening['archetype_phrase'])
                self.assertTrue(warnings)
                self.assertTrue(opening['top_four_archetype']['fallback_used'])
                events = build_events(self.plan, opening['archetype_phrase'], [], LOCALE)
                lines = texts(events)
                self.assertLess(lines.index('Você deve ser o...'), lines.index('...'))
                self.assertLess(lines.index('Tá, deixa pra lá.'), lines.index('Pode ser só fixture_user.'))
                self.assertLess(lines.index('Pode ser só fixture_user.'), lines.index('Me falaram que você tem um'))
                self.assertNotIn('-'.join(opening['archetype']), lines)

    def test_without_favorites_opening_stays_short(self):
        plan = build_plan(Profile(), {}, LOCALE)
        self.assertNotIn('Você deve ser o...', texts(build_events(plan, None, [], LOCALE)))
        self.assertIn('Você deve ser o...', texts(build_events(self.plan, None, [], LOCALE)))

    def test_missing_username_uses_localized_generic_copy(self):
        class Anonymous(Profile):
            handle = ''
            display_name = ''
        plan = build_plan(Anonymous(), {}, LOCALE)
        plan['archetype_requested'] = True
        self.assertIn('Vou ficar com um nome mais simples.', texts(build_events(plan, None, [], LOCALE)))
        self.assertNotIn('Pode ser só .', texts(build_events(plan, None, [], LOCALE)))

    def test_cli_presentation_preserves_scene_with_elaborate_concepts(self):
        cli = test_cli.CLITests()
        def writer(api_key, request, note=None):
            def mutate(body):
                body['opening']['archetype_concepts'] = ['caubói do deserto', 'genes de ficção',
                                                           'androide noturno', 'matinê de verão']
                body['opening']['archetype_phrase'] = 'androide-caubói-de-matinê'
            return test_cli.valid_response(request, mutate=mutate)
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.top_four_favorites', return_value=FILMS), \
                patch('src.generation.analyze_semantically', side_effect=test_cli.analyst_side_effect()), \
                patch('src.generation.write_final', side_effect=writer):
            root = Path(directory)
            cli.prepare(root)
            self.assertEqual(cli.run_app(root, [], 'synthetic-key'), 0)
            script = cli.read(root, 'presentation_script.json')
            opening = script['opening']['top_four_archetype']
            self.assertTrue(opening['requested'])
            self.assertTrue(opening['valid'])
            self.assertEqual(opening['phrase'], 'androide-caubói-de-matinê')
            messages = texts(script['events'])
            sequence = ['Você deve ser o...', 'androide-caubói-de-matinê', '...?',
                        'Grande demais.', 'Pode ser só synthetic.', 'Me falaram que você tem um']
            self.assertEqual([messages.index(s) for s in sequence], sorted(messages.index(s) for s in sequence))
            self.assertNotIn('archetype concept must be one or two plain words',
                             str(cli.read(root, 'final_writer_response.json')))

    def test_cli_writer_skipped_still_preserves_scene(self):
        cli = test_cli.CLITests()
        with tempfile.TemporaryDirectory() as directory, \
                patch('src.generation.top_four_favorites', return_value=FILMS):
            root = Path(directory)
            cli.prepare(root)
            self.assertEqual(cli.run_app(root, ['--dry-run'], 'synthetic-key'), 0)
            script = cli.read(root, 'presentation_script.json')
            self.assertTrue(script['opening']['top_four_archetype']['fallback_used'])
            self.assertIn('Você deve ser o...', texts(script['events']))
            self.assertIn('Tá, deixa pra lá.', texts(script['events']))


if __name__ == '__main__':
    unittest.main()
