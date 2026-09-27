from copy import deepcopy
import json
import unittest

import test_pipeline
from src.analyzer import analyze
from src.context_builder import build_context, build_dataset
from src.final_writer_v2 import validate_final_writer
from src.findings import build_findings
from src.finding_pool import build_pool
from src.opening import build_plan
from src.resources import bundle
from src.script_engine import build_script, final_writer_input
from src.semantic_validator import validate_semantic_findings

LOCALE = bundle('pt-BR')


def semantic_candidate(dataset: dict) -> dict:
    review = dataset['reviews'][0]
    return {'id': 'semantic_001', 'type': 'review_spotlight', 'interestingness': .9, 'confidence': .95,
            'observation': 'A review insiste na imagem.', 'why_interesting': 'Há ênfase textual na imagem.',
            'cultural_angle': '',
            'evidence': [{'source_type': 'review', 'source_id': review['id'], 'focus_text': review['text']}],
            'film_keys': [review['film_key']], 'related_tags': [], 'related_lists': []}


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
        script = build_script(pool, 5, 10000, LOCALE, debug=True)
        moment = next(m for m in script['moments'] if candidate['id'] in m['finding_ids'])
        payload = final_writer_input([moment], None, build_plan(self.profile, self.analysis['overview'], LOCALE),
                                     LOCALE, [])
        sent = payload['moments'][0]
        self.assertEqual(sent['evidence'], moment['evidence'])
        self.assertNotIn('stats', sent)
        self.assertNotIn('reviews', sent)
        self.assertNotIn('films', sent)
        review_sources = [e['source_id'] for e in sent['evidence'] if e['source_type'] == 'review']
        self.assertEqual(review_sources, [candidate['evidence'][0]['source_id']])
        self.assertEqual(script['moments'][-1]['role'], 'closer')

    def test_ai_first_selection_and_weak_stats_do_not_become_beats(self):
        weak = {'id': 'rating_group_001', 'origin': 'deterministic', 'type': 'rating_group',
                'score': 99, 'confidence': 1, 'observation': 'Muitas notas iguais.',
                'film_keys': ['f1', 'f2'], 'related_tags': [],
                'evidence': [{'source_type': 'finding', 'source_id': 'rating_group_001', 'data': {}}],
                'sample_size': 20}
        semantic = []
        for index, kind in enumerate(['review_spotlight', 'semantic_contrast', 'self_irony', 'list_meaning']):
            semantic.append({'id': f'semantic_{index:03}', 'origin': 'semantic', 'type': kind,
                             'score': 90 - index, 'confidence': .95,
                             'observation': f'Editorial {index}', 'film_keys': [f'f{index + 10}'],
                             'related_tags': [], 'related_lists': [],
                             'evidence': [{'source_type': 'film', 'source_id': f'f{index + 10}',
                                           'data': {'key': f'f{index + 10}', 'name': f'Film {index}',
                                                    'year': '2000', 'current_rating': 4.5}}],
                             'sample_size': 1})
        script = build_script([weak] + semantic, 4, 10000, LOCALE)
        ids = [fid for m in script['moments'] for fid in m['finding_ids']]
        self.assertNotIn('rating_group_001', ids)
        self.assertEqual(len(script['moments']), 4)
        self.assertTrue(all(m['origin'] == 'semantic' for m in script['moments']))

    def test_reject_missing_ids_entities_quotes_and_numbers(self):
        base = semantic_candidate(self.dataset)
        changes = [lambda c: c['evidence'][0].update(source_id='missing'),
                   lambda c: c.update(film_keys=['missing']), lambda c: c.update(related_tags=['missing']),
                   lambda c: c.update(related_lists=['missing']),
                   lambda c: c.update(observation='Possui 999 reviews.'), lambda c: c.update(evidence=[]),
                   lambda c: c.update(observation='Avaliou o filme antes do lançamento oficial.'),
                   lambda c: c.update(confidence='alta')]
        for change in changes:
            with self.subTest(change=change):
                item = deepcopy(base)
                change(item)
                valid, invalid = self.validate(item)
                self.assertFalse(valid)
                self.assertTrue(invalid)

    def test_out_of_range_scores_and_long_lists_are_normalized_not_rejected(self):
        base = semantic_candidate(self.dataset)
        grounded = self.dataset['reviews'][0]['film_key']
        item = deepcopy(base)
        item.update(interestingness=88, confidence=95, film_keys=[grounded] * 19)
        valid, invalid = self.validate(item)
        self.assertFalse(invalid)
        self.assertEqual(valid[0]['interestingness'], .88)
        self.assertEqual(valid[0]['confidence'], .95)
        self.assertEqual(valid[0]['score_normalization'],
                         {'interestingness': 'percent_to_unit', 'confidence': 'percent_to_unit'})
        self.assertEqual(valid[0]['bounded_lists'], {'film_keys': {'returned': 19, 'kept': 10}})
        saturated = deepcopy(base)
        saturated.update(interestingness=400, confidence=-3)
        valid, _ = self.validate(saturated)
        self.assertEqual(valid[0]['interestingness'], 1.0)
        self.assertEqual(valid[0]['confidence'], 0.0)
        self.assertFalse(build_pool(self.dataset, valid)[0]['confidence'] > 1)

    def test_numbers_are_grounded_from_backend_without_numeric_claims(self):
        item = semantic_candidate(self.dataset)
        item['observation'] = 'A review tem nota 2.'
        self.assertTrue(self.validate(item)[0])
        item['observation'] = 'A review tem nota 999.'
        self.assertFalse(self.validate(item)[0])

    def test_bad_focus_hint_does_not_kill_a_good_finding(self):
        item = semantic_candidate(self.dataset)
        item['evidence'][0]['focus_text'] = 'trecho inventado que não existe'
        valid, invalid = self.validate(item)
        self.assertFalse(invalid)
        self.assertEqual(valid[0]['focus_text'][item['evidence'][0]['source_id']], 'unresolved_hint_ignored')
        self.assertIn('full_text', valid[0]['resolved_evidence'][0]['data'])

    def test_list_membership_is_not_inferred_from_tags(self):
        item = semantic_candidate(self.dataset)
        item['type'] = 'list_meaning'
        own_list = self.dataset['lists'][0]
        nonmember = next(f for f in self.dataset['films'] if f['key'] not in {m['film_key'] for m in own_list['members']})
        item['related_lists'] = [own_list['id']]
        item['film_keys'] = [nonmember['key']]
        item['evidence'].extend([{'source_type': 'list', 'source_id': own_list['id'], 'focus_text': ''},
                                 {'source_type': 'film', 'source_id': nonmember['key'], 'focus_text': ''}])
        self.assertFalse(self.validate(item)[0])

    def test_reviews_do_not_prove_diary_sessions(self):
        item = semantic_candidate(self.dataset)
        item['observation'] = 'As sessões têm o mesmo comentário.'
        accepted, rejected = self.validate(item)
        self.assertFalse(accepted)
        self.assertIn('session review comparison requires multiple review records', str(rejected))

    def test_excluded_context_source_cannot_be_cited(self):
        candidate = semantic_candidate(self.dataset)
        self.dataset['reviews'] = []
        self.assertFalse(self.validate(candidate)[0])

    def test_script_diversity_dedup_limit_and_missing_category(self):
        pool = build_pool(self.dataset, [])
        duplicated = deepcopy(pool[0])
        duplicated['id'] = 'duplicate_new_id'
        script = build_script(pool + [duplicated], 6, 10000, LOCALE)
        self.assertLessEqual(len(script['moments']), 6)
        ids = [fid for m in script['moments'] for fid in m['finding_ids']]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertFalse(pool[0]['id'] in ids and duplicated['id'] in ids)
        for kind in set(m['moment_type'] for m in script['moments']):
            self.assertLessEqual(sum(m['moment_type'] == kind for m in script['moments']), 3)
        self.assertEqual(len(build_script([], 3, 10000, LOCALE)['moments']), 0)
        self.assertLessEqual(len(build_script(pool, 1, 10000, LOCALE)['moments']), 1)
        rating_only = [item for item in pool if item['type'] == 'rating_group']
        if rating_only:
            self.assertEqual(build_script(rating_only, 3, 10000, LOCALE)['moments'], [])

    def test_writer_limits_and_numeric_guard(self):
        moment = {'beat_id': 'beat_01', 'max_lines': 2, 'display': {'films': [{'title': 'Gattaca'}]},
                  'evidence': [{'source_type': 'film', 'source_id': 'f1', 'data': {'current_rating': 4.5}}]}
        plan = build_plan(self.profile, self.analysis['overview'], LOCALE)

        def run(lines, closer=None):
            raw = json.dumps({'opening': {'salutation': plan['salutation'],
                                          'archetype_concepts': ['a', 'b', 'c', 'd'],
                                          'archetype_phrase': 'a-e-b-de-c-d',
                                          'negative_adjective': plan['adjective_pair']['negative'],
                                          'positive_adjective': plan['adjective_pair']['positive'],
                                          'profile_reaction': []},
                              'beats': [{'beat_id': 'beat_01', 'lines': lines}], 'closer': {'lines': []}})
            return validate_final_writer(raw, [moment], closer, plan, LOCALE, self.analysis['overview'])

        for lines in ([{'text': 'a', 'effect': 'none'}] * 3,
                      [{'text': '999 reviews.', 'effect': 'none'}],
                      [{'text': 'word ' * 30, 'effect': 'none'}],
                      [{'text': '~~riscado~~', 'effect': 'none'}],
                      [{'text': 'espera 300 ms', 'effect': 'none'}]):
            self.assertIsNone(run(lines)[0])
        broken = json.dumps({'opening': {}, 'beats': [], 'closer': {}})
        self.assertEqual(validate_final_writer('not json', [moment], None, plan, LOCALE,
                                              self.analysis['overview'])[1], ['invalid JSON'])
        self.assertIsNone(validate_final_writer(broken, [moment], None, plan, LOCALE,
                                                self.analysis['overview'])[0])
        result, errors = run([{'text': 'Gattaca', 'effect': 'none'}, {'text': 'Curto.', 'effect': 'none'}])
        self.assertFalse(errors)
        self.assertEqual(result['beats']['beat_01'],
                         [{'text': 'Gattaca', 'effect': 'none'}, {'text': 'Curto.', 'effect': 'none'}])
        self.assertEqual(result['dropped_lines'], {})

    def test_full_context_includes_raw_export_and_never_silently_truncates(self):
        raw = {'format': 'letterboxd-export-json-v1', 'file_count': 2,
               'files': [{'path': 'ratings.csv', 'format': 'csv', 'rows': [['Name'], ['Film']]},
                         {'path': 'deleted/reviews.csv', 'format': 'csv', 'rows': [['Name'], ['Old Film']]}]}
        context, message = build_context(self.profile, self.analysis, self.findings, 'prompt', 300000, 'pt-BR', raw)
        self.assertEqual(context['raw_export'], raw)
        self.assertTrue(context['coverage']['complete'])
        self.assertFalse(context['coverage']['truncated'])
        self.assertEqual(context['coverage']['raw_export_files'], 2)
        self.assertEqual(len(context['diary']), len(self.profile.diary))
        self.assertEqual(len(context['reviews']), len(self.profile.reviews))
        self.assertIn('uri', context['reviews'][0])
        with self.assertRaises(ValueError):
            build_context(self.profile, self.analysis, self.findings, 'prompt', 100, 'pt-BR', raw)


if __name__ == '__main__':
    unittest.main()
