"""Presentation contract: events, durations, effects, silence and a valid script without any AI text."""
import unittest

from src.opening import ARCHETYPE_COUNT, build_events, build_plan
from src.presentation import (DURATIONS, EVENT_TYPES, build_presentation, correction, display_events, event_errors,
                              line_events, message, pause, script_text, strike, typing, validate_presentation)
from src.resources import bundle, resolve_locale

LOCALE = bundle('pt-BR')
OVERVIEW = {'watched_films': 106, 'rated_films': 92, 'reviews': 103, 'diary_entries': 110,
            'explicit_rewatches': 9, 'watchlist': 236, 'own_lists': 2}


class Profile:
    handle, display_name, films = 'synthetic', 'Synthetic', {}


def plan(**overrides):
    built = build_plan(Profile(), OVERVIEW, LOCALE)
    built.update(overrides)
    return built


def moment(display, **extra):
    return {'beat_id': 'beat_01', 'moment_id': 'moment_01', 'position': 1, 'role': 'moment',
            'moment_type': extra.get('moment_type', 'rating_contrast'), 'finding_ids': ['rating_group_001'],
            'origin': 'deterministic', 'finding_type': 'rating_group', 'writer_mode': 'contrast', 'max_lines': 2,
            'render_strategy': 'ai', 'allow_silence': True, 'display': dict(display, moment_type='rating_contrast'),
            'observation': '', 'evidence': [], **extra}


class OpeningTests(unittest.TestCase):
    def test_web_favorites_cue_precedes_archetype_and_metadata_survives(self):
        built = plan(top_four=[{'film_key': 'synthetic', 'title': 'Fixture', 'year': '2000'}])
        built['opening_events'] = build_events(built, 'synthetic archetype', [], LOCALE)
        events = built['opening_events']
        self.assertEqual(events[3]['cue'], 'top_four_reveal')
        self.assertEqual(events[4]['role'], 'archetype_phrase')
        result = build_presentation(built, [], None, {}, {}, LOCALE)
        self.assertEqual(result['opening']['top_four'], built['top_four'])
        self.assertEqual(validate_presentation(result), [])
        short = build_events(built, None, [], LOCALE)
        self.assertEqual(short[1]['cue'], 'top_four_reveal')

    def test_opening_sequence_is_typing_message_strike_correction_and_stats(self):
        events = build_events(plan(), 'espacial-adolescente', [], LOCALE)
        kinds = [event['type'] for event in events]
        self.assertEqual(kinds[:5], ['typing', 'message', 'typing', 'message', 'message'])
        self.assertIn('strike', kinds)
        self.assertIn('correction', kinds)
        self.assertEqual(kinds[-1], 'profile_stats')
        self.assertLessEqual(len([e for e in events if e['type'] == 'profile_stats']), 1)
        self.assertTrue(all(event['duration'] in DURATIONS for event in events if event['type'] in {'typing', 'pause'}))

    def test_archetype_block_is_optional_and_never_invents_a_title(self):
        without = build_events(plan(), None, [], LOCALE)
        texts = [''.join(s['text'] for s in e['segments']) for e in without if e['type'] == 'message']
        self.assertNotIn('Você deve ser o...', texts)
        with_archetype = build_events(plan(), 'espacial-adolescente', [], LOCALE)
        self.assertIn('espacial-adolescente',
                      [''.join(s['text'] for s in e['segments']) for e in with_archetype if e['type'] == 'message'])

    def test_negative_adjective_is_struck_before_the_positive_one(self):
        events = build_events(plan(), None, [], LOCALE)
        index = next(i for i, event in enumerate(events) if event['type'] == 'strike')
        struck = events[index]
        self.assertEqual(struck['text'], plan()['adjective_pair']['negative'])
        self.assertEqual(events[index + 1]['type'], 'pause')
        self.assertEqual(events[index + 2], correction(struck['text'], plan()['adjective_pair']['positive']))

    def test_reveal_shows_three_to_five_numbers_and_optional_reaction(self):
        self.assertEqual(ARCHETYPE_COUNT, 4)
        self.assertTrue(3 <= len(plan()['stats']) <= 5)
        self.assertEqual(plan()['stats'][0]['label'], 'filmes vistos')
        with_reaction = build_events(plan(), None, [{'text': 'Números.', 'effect': 'none'}], LOCALE)
        self.assertEqual(with_reaction[-1]['segments'][0]['text'], 'Números.')


class EventTests(unittest.TestCase):
    def test_supported_vocabulary_includes_the_frontend_contract(self):
        for kind in ('typing', 'pause', 'message', 'correction', 'strike', 'profile_stats', 'film', 'film_pair',
                     'film_group', 'review_quote', 'tag', 'list', 'rating', 'rewatch'):
            self.assertIn(kind, EVENT_TYPES)

    def test_durations_are_enums_and_never_milliseconds(self):
        self.assertEqual(DURATIONS, ('instant', 'short', 'medium', 'long'))
        self.assertEqual(typing('long'), {'type': 'typing', 'duration': 'long'})
        self.assertTrue(event_errors([typing('300ms')]))
        self.assertTrue(event_errors([pause('2 seconds')]))

    def test_line_effects_become_structured_events(self):
        events = line_events([{'text': 'chato', 'effect': 'strike'}, {'text': 'incrível', 'effect': 'correction'},
                              {'text': 'de novo.', 'effect': 'none'}])
        self.assertEqual([event['type'] for event in events], ['strike', 'pause', 'correction', 'message'])
        self.assertEqual(events[2], correction('chato', 'incrível'))
        self.assertFalse(event_errors(events))

    def test_display_events_come_before_any_reaction(self):
        data = moment({'kind': 'rating_pair', 'moment_type': 'rating_contrast',
                       'films': [{'film_key': 'f1', 'title': 'Gattaca', 'year': '1997', 'rating': 5},
                                 {'film_key': 'f2', 'title': 'Akira', 'year': '1988', 'rating': 4}],
                       'stats': [{'key': 'count', 'value': 3, 'label': 'filmes'}]})
        events = display_events(data)
        self.assertEqual([event['type'] for event in events], ['film_pair', 'stat'])
        self.assertEqual(events[0]['films'][0]['film_key'], 'f1')

    def test_markup_and_duplicate_beats_are_contract_errors(self):
        self.assertTrue(event_errors([message('~~péssimo~~')]))
        self.assertTrue(event_errors([message('*correção')]))
        self.assertTrue(event_errors([{'type': 'message', 'segments': [{'text': 'x', 'effect': 'nope'}]}]))


class PresentationTests(unittest.TestCase):
    def build(self, lines, render=None):
        data = moment({'kind': 'rating_pair', 'moment_type': 'rating_contrast',
                       'films': [{'film_key': 'f1', 'title': 'Gattaca', 'year': '1997', 'rating': 5},
                                 {'film_key': 'f2', 'title': 'Akira', 'year': '1988', 'rating': 4}], 'stats': []})
        opened = plan()
        opened['opening_events'] = build_events(opened, 'espacial', [], LOCALE)
        entry = {'moment': data, 'lines': lines, 'render_strategy': 'ai', 'source': 'ai' if lines else 'none',
                 'status': 'written' if lines else 'silence'}
        script = build_presentation(opened, [entry], None,
                                    render or {'ai_generation': 'complete', 'model': 'm', 'served_model': 'm',
                                               'fallback_models': []},
                                    {'origin': 'api', 'attempts': [], 'warnings': [], 'calls': 2}, LOCALE)
        return script

    def test_silence_is_a_valid_script_decision(self):
        script = self.build([])
        self.assertEqual(validate_presentation(script), [])
        opening_length = len(build_events(plan(), 'espacial', [], LOCALE))
        self.assertEqual([event['type'] for event in script['events'][opening_length:]], ['film_pair', 'stat', 'pause'])
        self.assertEqual(script['beats'][0]['status'], 'silence')

    def test_presentation_is_valid_without_any_ai_response(self):
        script = self.build([], {'ai_generation': 'skipped', 'model': 'm', 'served_model': None, 'fallback_models': []})
        self.assertEqual(validate_presentation(script), [])
        self.assertEqual(script['beats'][0]['source'], 'none')
        self.assertEqual(script['render']['ai_generation'], 'skipped')
        self.assertTrue(script_text(script).strip())

    def test_complete_run_without_messages_is_an_error(self):
        script = self.build([])
        script['render']['ai_generation'] = 'complete'
        script['events'] = [event for event in script['events'] if event['type'] != 'message']
        self.assertTrue(validate_presentation(script))

    def test_locales_are_files_not_runtime_translation(self):
        self.assertEqual(resolve_locale('pt-BR'), 'pt-BR')
        self.assertEqual(resolve_locale('en-US'), 'en-US')
        self.assertEqual(resolve_locale('xx-YY'), 'pt-BR')
        self.assertTrue(bundle('pt-BR').salutations())
        self.assertTrue(bundle('en-US').adjective_pairs())
        self.assertEqual(bundle('en-US').phrase('opening.look'), 'Let me take a look.')
        with self.assertRaises(KeyError):
            bundle('pt-BR').phrase('opening.nao_existe')


if __name__ == '__main__':
    unittest.main()
