import unittest

from src.analysis_enrichment import enrich_rewatches, match_reviews_to_diary, review_coverage
from src.analyzer import rewatch_analysis
from src.editorial_priority import closer_key
from src.model_discovery import build_chain
from src.models import DiaryEntry, FilmRecord, ReviewRecord, UserProfile
from src.review_style import analyze_review_style
from src.run_quality import analyst_quality, required_semantic_moments, writer_quality


def profile_with_reviews() -> UserProfile:
    profile = UserProfile()
    film = FilmRecord('f1', 'Film A', '2000', rating=5, watched=True)
    profile.films['f1'] = film
    for index in range(10):
        diary = DiaryEntry(
            id=f'diary:{index}', film_key='f1', date=f'2024-01-{index + 1:02}',
            logged_date=f'2024-01-{index + 1:02}', rating=5, rewatch=index > 0,
            tags=['friends'] if index % 2 else [], uri='', source='diary.csv'
        )
        review = ReviewRecord(
            id=f'reviews:{index}', film_key='f1', date=diary.date, logged_date=diary.logged_date,
            rating=5, rewatch=diary.rewatch, tags=list(diary.tags), uri='', source='reviews.csv',
            text='<blockquote>frase citada</blockquote> Corte seco, gostei muito.'
        )
        profile.diary.append(diary)
        profile.reviews.append(review)
        film.diary_ids.append(diary.id)
        film.review_ids.append(review.id)
    return profile


class EditorialDepthTests(unittest.TestCase):
    def test_bigram_markup_and_intersection(self):
        style = analyze_review_style(profile_with_reviews().reviews)
        phrase = next(row for row in style['phrases'] if row['phrase'] == 'corte seco')
        self.assertEqual(phrase['count'], 10)
        self.assertEqual(style['markup']['blockquote']['count'], 10)
        cross = next(row for row in style['intersections']
                     if row['phrase'] == 'corte seco' and row['markup'] == 'blockquote')
        self.assertEqual(cross['count'], 10)

    def test_review_coverage_matches_sessions_without_inventing_them(self):
        profile = profile_with_reviews()
        profile.reviews.pop()
        matches, unmatched = match_reviews_to_diary(profile)
        coverage = review_coverage(profile, matches, unmatched)
        self.assertEqual(coverage['diary_sessions'], 10)
        self.assertEqual(coverage['matched_sessions'], 9)
        self.assertEqual(coverage['sessions_without_review'], 1)

    def test_rewatch_enrichment_detects_stability_and_change(self):
        profile = profile_with_reviews()
        matches, _ = match_reviews_to_diary(profile)
        rewatches = enrich_rewatches(profile, rewatch_analysis(profile), matches)
        self.assertTrue(rewatches[0]['all_known_ratings_same'])
        self.assertEqual(rewatches[0]['rating_delta_first_last'], 0)
        profile.diary[-1].rating = 4
        rewatches = enrich_rewatches(profile, rewatch_analysis(profile), matches)
        self.assertFalse(rewatches[0]['all_known_ratings_same'])
        self.assertEqual(rewatches[0]['rating_delta_first_last'], -1)

    def test_lite_is_last_in_discovered_fallback_quality_order(self):
        chain, _ = build_chain(
            'gemini-primary',
            ['gemini-flash-lite-latest'],
            ['gemini-2.5-flash', 'gemini-pro', 'gemini-other'],
            limit=8,
        )
        self.assertEqual(chain[0], 'gemini-primary')
        self.assertEqual(chain[-1], 'gemini-flash-lite-latest')
        self.assertLess(chain.index('gemini-2.5-flash'), chain.index('gemini-flash-lite-latest'))

    def test_rich_accounts_require_semantic_depth(self):
        analysis = {'overview': {'reviews': 103, 'rated_films': 92}}
        self.assertEqual(required_semantic_moments(analysis), 6)
        report = analyst_quality(analysis, [{}] * 5, [{}] * 3)
        self.assertFalse(report['passes'])
        self.assertTrue(analyst_quality(analysis, [{}] * 6, [])['passes'])

    def test_closer_prefers_self_reference_before_plain_score(self):
        self.assertGreater(
            closer_key({'type': 'self_irony', 'score': 70, 'confidence': .9}),
            closer_key({'type': 'semantic_contrast', 'score': 99, 'confidence': 1})
        )

    def test_lite_writer_is_marked_as_degraded(self):
        quality = writer_quality({'beats': {'b1': [], 'b2': [{'text': 'x'}]}, 'closer': []},
                                 'gemini-flash-lite-latest')
        self.assertTrue(quality['quality_degraded'])
        self.assertEqual(quality['reaction_lines'], 1)
        self.assertEqual(quality['silent_moments'], 2)


if __name__ == '__main__':
    unittest.main()
