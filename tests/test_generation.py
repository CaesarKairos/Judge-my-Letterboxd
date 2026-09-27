from copy import deepcopy
import json
import unittest

import test_pipeline
from src.analyzer import analyze
from src.context_builder import build_context, build_dataset
from src.findings import build_findings
from src.finding_pool import build_pool
from src.script_engine import build_script, writer_input
from src.validator import validate_semantic_findings, validate_writer


def semantic_candidate(dataset: dict) -> dict:
    review = dataset['reviews'][0]
    return {'id': 'semantic_001', 'type': 'review_spotlight', 'interestingness': .9, 'confidence': .95,
            'observation': 'A review insiste na imagem.', 'why_interesting': 'Há ênfase textual na imagem.',
            'evidence': [{'source_type': 'review', 'source_id': review['id'], 'quote': review['text']}],
            'film_keys': [review['film_key']], 'related_tags': [], 'related_lists': [], 'numeric_claims': []}


class GenerationTests(unittest.TestCase):
    def setUp(self):
        self.profile = test_pipeline.PipelineTests().synthetic()
        self.analysis = analyze(self.profile)
        self.findings = build_findings(self.profile, self.analysis)
        self.dataset = build_dataset(self.profile, self.analysis, self.findings, 'pt-BR')

    def validate(self, candidate):
        return validate_semantic_findings(json.dumps({'semantic_findings': [candidate]}), self.dataset)

    def test_rating_entities_and_no_tag_double_count(self):
        self.profile.diary[0].rating = None
        analysis = analyze(self.profile)
        tag = analysis['tags'][0]
        self.assertEqual(tag['current_film_ratings']['mean'], 4)
        self.assertEqual(tag['session_ratings']['count'], 3)
        self.assertEqual(tag['session_ratings']['mean'], 4)
        self.assertEqual(tag['sessions'], 4)
        data = build_dataset(self.profile, analysis, build_findings(self.profile, analysis), 'pt-BR')
        self.assertIsNone(data['diary'][0]['session_rating'])
        self.assertEqual(data['reviews'][0]['review_rating'], 2)
        film = next(f for f in data['films'] if f['key'] == data['diary'][0]['film_key'])
        self.assertEqual(film['current_rating'], 4)

    def test_small_tag_sample_never_produces_mean_finding(self):
        self.assertFalse(any(f.type == 'tag_rating_difference' for f in self.findings))
        for f in self.findings:
            self.assertGreater(f.sample_size, 0)
            self.assertTrue(f.metric)

    def test_contextual_finding_uses_session_baseline(self):
        for index in range(6):
            entry = deepcopy(self.profile.diary[index % 4])
            entry.id = f'diary:extra:{index}'
            entry.rating = .5
            entry.tags = ['context']
            self.profile.diary.append(entry)
            self.profile.films[entry.film_key].tags = list(set(self.profile.films[entry.film_key].tags + ['context']))
        analysis = analyze(self.profile)
        findings = build_findings(self.profile, analysis)
        finding = next(f for f in findings if f.type == 'tag_rating_difference' and f.evidence['tag'] == 'context')
        self.assertEqual(finding.sample_size, 6)
        self.assertEqual(finding.evidence['session_ratings']['mean'], .5)
        self.assertEqual(finding.baseline, analysis['session_rating_baseline'])
        self.assertEqual(finding.sources, ['diary.csv'])

    def test_valid_semantic_and_writer_scope(self):
        candidate = semantic_candidate(self.dataset)
        accepted, rejected = self.validate(candidate)
        self.assertFalse(rejected)
        pool = build_pool(self.dataset, accepted)
        script = build_script(pool, self.analysis['overview'], 5)
        beat = next(b for b in script['beats'] if candidate['id'] in b['finding_ids'])
        payload = writer_input(beat, 'pt-BR')
        self.assertEqual(payload['evidence'], beat['evidence'])
        self.assertEqual(payload['previous_context'], [])
        self.assertNotIn('stats', payload)
        self.assertNotIn('reviews', payload)
        self.assertNotIn('films', payload)
        review_sources = [e['source_id'] for e in payload['evidence'] if e['source_type'] == 'review']
        self.assertEqual(review_sources, [candidate['evidence'][0]['source_id']])
        self.assertEqual(script['beats'][-1]['beat_type'], 'CLOSER')

    def test_selection_has_type_film_and_tag_diversity(self):
        candidates = []
        kinds = ['rating_group', 'writing_pattern', 'rewatch', 'tag_overlap']
        for index in range(12):
            candidates.append({'id': f'candidate_{index}', 'origin': 'deterministic',
                               'type': kinds[index % len(kinds)], 'score': 90, 'confidence': 1,
                               'observation': f'Observation {index}', 'film_keys': [f'film_{index}'],
                               'related_tags': [f'tag_{index}'], 'evidence': [], 'sample_size': 10})
        script = build_script(candidates, self.analysis['overview'], 8)
        kinds = [b['beat_type'] for b in script['beats'][1:]]
        self.assertEqual(len(script['beats']), 8)
        self.assertGreaterEqual(len(set(kinds)), 4)
        self.assertTrue(all(a != b for a, b in zip(kinds, kinds[1:])))

    def test_reject_missing_ids_entities_quotes_and_numbers(self):
        base = semantic_candidate(self.dataset)
        changes = [lambda c: c['evidence'][0].update(source_id='missing'),
                   lambda c: c.update(film_keys=['missing']), lambda c: c.update(related_tags=['missing']),
                   lambda c: c.update(related_lists=['missing']), lambda c: c['evidence'][0].update(quote='fabricated quotation'),
                   lambda c: c.update(observation='Possui 999 reviews.'), lambda c: c.update(evidence=[]),
                   lambda c: c.update(observation='Avaliou o filme antes do lançamento oficial.'),
                   lambda c: c.update(confidence=2)]
        for change in changes:
            with self.subTest(change=change):
                item = deepcopy(base)
                change(item)
                valid, invalid = self.validate(item)
                self.assertFalse(valid)
                self.assertTrue(invalid)

    def test_numeric_claim_field_binding(self):
        item = semantic_candidate(self.dataset)
        item['observation'] = 'A review tem nota 2.'
        item['numeric_claims'] = [{'source_type': 'review', 'source_id': item['evidence'][0]['source_id'],
                                  'field': 'review_rating', 'value': 2}]
        self.assertTrue(self.validate(item)[0])
        item['numeric_claims'][0]['value'] = 5
        self.assertFalse(self.validate(item)[0])

    def test_list_membership_is_not_inferred_from_tags(self):
        item = semantic_candidate(self.dataset)
        item['type'] = 'list_meaning'
        own_list = self.dataset['lists'][0]
        nonmember = next(f for f in self.dataset['films'] if f['key'] not in {m['film_key'] for m in own_list['members']})
        item['related_lists'] = [own_list['id']]
        item['film_keys'] = [nonmember['key']]
        item['evidence'].extend([{'source_type': 'list', 'source_id': own_list['id'], 'quote': ''},
                                 {'source_type': 'film', 'source_id': nonmember['key'], 'quote': ''}])
        self.assertFalse(self.validate(item)[0])

    def test_reviews_do_not_prove_diary_sessions(self):
        item = semantic_candidate(self.dataset)
        item['observation'] = 'As sessões têm o mesmo comentário.'
        accepted, rejected = self.validate(item)
        self.assertFalse(accepted)
        self.assertIn('session claims require', str(rejected))

    def test_excluded_context_source_cannot_be_cited(self):
        candidate = semantic_candidate(self.dataset)
        self.dataset['reviews'] = []
        self.assertFalse(self.validate(candidate)[0])

    def test_script_diversity_dedup_limit_and_missing_category(self):
        pool = build_pool(self.dataset, [])
        duplicated = deepcopy(pool[0])
        duplicated['id'] = 'duplicate_new_id'
        script = build_script(pool + [duplicated], self.analysis['overview'], 6)
        self.assertLessEqual(len(script['beats']), 6)
        ids = [fid for b in script['beats'] for fid in b['finding_ids']]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertFalse(pool[0]['id'] in ids and duplicated['id'] in ids)
        for kind in set(b['beat_type'] for b in script['beats']):
            self.assertLessEqual(sum(b['beat_type'] == kind for b in script['beats']), 2)
        self.assertFalse(any(b['beat_type'] in {'LIST_PATTERN', 'CLOSER', 'CALLBACK'} for b in script['beats']))
        self.assertEqual(len(build_script([], self.analysis['overview'])['beats']), 1)
        self.assertEqual(len(build_script(pool, self.analysis['overview'], 1)['beats']), 1)

    def test_writer_limits_and_numeric_guard(self):
        beat = build_script([], self.analysis['overview'])['beats'][0]
        self.assertEqual(validate_writer('{"lines": []}', beat), ([], []))
        for raw in ['not json', '{"lines": ["a", "b", "c", "d"]}', '{"lines": ["999 reviews."]}',
                    json.dumps({'lines': ['word ' * 30]})]:
            self.assertTrue(validate_writer(raw, beat)[1])

    def test_compact_context_has_references_and_complete_reviews(self):
        context, message = build_context(self.profile, self.analysis, self.findings, 'prompt', 300000, 'pt-BR')
        self.assertEqual(len(context['diary']), len(self.profile.diary))
        self.assertEqual(len(context['reviews']), len(self.profile.reviews))
        self.assertNotIn('uri', context['reviews'][0])
        self.assertNotIn('name', context['diary'][0])
        for budget in (5000, 8000):
            context, message = build_context(self.profile, self.analysis, self.findings, 'prompt', budget, 'pt-BR')
            self.assertLessEqual(len(message) + 6, budget)
            keys = {f['key'] for f in context['films']}
            self.assertTrue(all(r['film_key'] in keys for r in context['reviews'] + context['diary']))


if __name__ == '__main__':
    unittest.main()
