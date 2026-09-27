import json
import unittest

from src.final_writer import absolute_language_flags, validate_archetype_phrase, validate_lines
from src.presentation import event_text, review_event, event_errors
from src.run_quality import writer_quality
from src.script_engine import build_script


class EditorialPolishTests(unittest.TestCase):
    def moment(self, numerator, denominator):
        return {'beat_id': 'beat_01', 'max_lines': 4, 'display': {'phrase': 'Outros dados'},
                'evidence': [{'source_type': 'finding', 'data': {'summary': f'{numerator} de {denominator} reviews'}}]}

    def test_partial_measurements_block_absolute_language(self):
        for count, total, phrase in [(86, 103, 'Você sempre comenta.'),
                                     (86, 103, 'Você nunca deixa passar.'),
                                     (4, 5, 'Isso acontece obrigatoriamente.')]:
            with self.subTest(phrase=phrase):
                lines, errors = validate_lines([{'text': phrase}], self.moment(count, total), 4, 14)
                self.assertEqual(lines, [])
                self.assertIn('absolute language', errors[0])

    def test_complete_measurement_accepts_supported_absolute(self):
        lines, errors = validate_lines([{'text': 'Você sempre comenta.'}], self.moment(5, 5), 4, 14)
        self.assertFalse(errors)
        self.assertEqual(len(lines), 1)
        self.assertFalse(absolute_language_flags('Nunca gostei de um final', {'evidence': []}))

    def test_phrase_accepts_connectors_and_checks_length(self):
        phrase, errors = validate_archetype_phrase('caubói-e-androide-da-estrada', {'username': 'guest'})
        self.assertFalse(errors)
        self.assertEqual(phrase, 'caubói-e-androide-da-estrada')
        self.assertTrue(validate_archetype_phrase('a' * 71, {})[1])
        self.assertTrue(validate_archetype_phrase('guest', {'username': 'guest'})[1])

    def test_review_preserves_blockquote_without_raw_html(self):
        event = review_event({'type': 'review_quote', 'text': 'Dito isso:<blockquote>outro trecho</blockquote>',
                              'title': 'Filme', 'year': '2000', 'rating': None})
        self.assertEqual([part['type'] for part in event['segments']], ['text', 'blockquote'])
        self.assertIn('> outro trecho', event_text(event))
        self.assertNotIn('<blockquote>', json.dumps(event, ensure_ascii=False))
        self.assertFalse(event_errors([event]))

    def test_semantic_only_never_auto_promotes_measurements(self):
        def candidate(id, origin, kind):
            return {'id': id, 'origin': origin, 'type': kind, 'score': 90, 'confidence': .95,
                    'observation': id, 'film_keys': [id], 'related_tags': [], 'related_lists': [],
                    'evidence': [{'source_type': 'film', 'source_id': id,
                                  'data': {'key': id, 'name': id, 'year': '2000'}}]}
        pool = [candidate('semantic_1', 'semantic', 'self_irony'),
                candidate('deterministic_1', 'deterministic', 'rewatch')]
        show = build_script(pool, 10, semantic_only=True)
        self.assertEqual([m['origin'] for m in show['moments']], ['semantic'])
        self.assertEqual(len(build_script(pool, 10, debug=True)['moments']), 2)

    def test_silence_callback_and_restatement_audit(self):
        moment = self.moment(5, 5)
        moment['display']['phrase'] = 'Dito isso mesmo'
        result = {'beats': {'beat_01': [{'text': 'Dito isso mesmo.'}]}, 'closer': []}
        report = writer_quality(result, 'model', [moment])
        self.assertGreaterEqual(report['possible_restatements'], 1)
        self.assertEqual(report['reaction_lines'], 1)
        self.assertFalse(validate_lines([], moment, 4, 14)[1])
        valid = {'beats': {'beat_01': [{'text': 'Dito isso, mas sua nota mudou.'}]}, 'closer': []}
        self.assertEqual(writer_quality(valid, 'model', [moment])['possible_restatements'], 0)


if __name__ == '__main__':
    unittest.main()
