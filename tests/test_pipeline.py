import csv
from dataclasses import asdict
import io
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

from src.analyzer import analyze
from src.context_builder import build_context
from src.findings import build_findings, relevance_score
from src.parser import read_export
from src.utils import csv_rows, film_key, normalize_title, parse_rating, parse_tags, records, words


def csv_text(header: list[str], rows: list[list]) -> str:
    stream = io.StringIO(newline='')
    writer = csv.writer(stream)
    writer.writerow(header)
    writer.writerows(rows)
    return stream.getvalue()


class PipelineTests(unittest.TestCase):
    def export(self, files: dict[str, str]):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'export.zip'
            with ZipFile(path, 'w') as archive:
                for name, content in files.items():
                    archive.writestr(name, content.encode('utf-8-sig'))
            return read_export(path)

    def synthetic(self):
        header = ['Name', 'Year', 'Letterboxd URI', 'Rating', 'Watched Date', 'Rewatch', 'Tags', 'Review']
        diary = [[' Café  東京 ', '2000', 'https://boxd.it/a', 2, '2024-01-01', '', 'x, y', ''],
                 ['CAFÉ 東京', '2000', 'https://letterboxd.com/user/film/a', 4, '2024-01-03', 'Yes', 'x, y', ''],
                 ['B', '2001', '', 3, '2024-01-02', '', 'x, y', ''],
                 ['C', '2002', '', 5, '2024-01-02', '', 'x, y', '']]
        reviews = [r[:-1] + ['Imagem bonita demais.\nGostei, sim!'] for r in diary]
        return self.export({'ratings.csv': csv_text(['Name', 'Year', 'Rating'], [['Café 東京', '2000', 4], ['B', '2001', 3], ['C', '2002', 5]]),
                            'diary.csv': csv_text(header, diary), 'reviews.csv': csv_text(header, reviews),
                            'profile.csv': csv_text(['Email Address', 'Location', 'Favorite Films'], [['private@example.com', 'PRIVATE_LOCATION', 'https://boxd.it/a']]),
                            'deleted/ratings.csv': csv_text(['Name', 'Year', 'Rating'], [['Deleted', '2000', .5]]),
                            'orphaned/reviews.csv': 'ignored', 'unknown.csv': 'anything',
                            'lists/test.csv': 'Letterboxd list export v7\nDate,Name,Tags,URL,Description\n2024-01-01,Minha lista,x,,Descrição\n\nPosition,Name,Year,URL,Description\n1,Café 東京,2000,,Observação\n',
                            'likes/films.csv': csv_text(['Name', 'Year'], [['B', '2001']]),
                            'likes/reviews.csv': 'Date,Content\n2024-01-01,review-link\n',
                            'likes/lists.csv': 'Date,Content\n2024-01-01,list-link\n'})

    def test_csv_bom_multiline_and_commas(self):
        value = csv_text(['Name', 'Review'], [['A', 'Linha 1, sim\nLinha 2']])
        self.assertEqual(records(csv_rows(value.encode('utf-8-sig')))[0]['Review'], 'Linha 1, sim\nLinha 2')

    def test_normalization_and_identity(self):
        self.assertEqual(normalize_title('  CAFE\u0301  東京 '), 'café 東京')
        self.assertEqual(film_key(' CAFÉ 東京', '2000'), film_key('cafe\u0301 東京', '2000'))
        self.assertNotEqual(film_key('A', '2000'), film_key('A', '2001'))

    def test_ratings(self):
        for value in ('', 'nan', 'inf', 'bad', '0', '5.5', '3.2'):
            self.assertIsNone(parse_rating(value))
        self.assertEqual(parse_rating('4.5'), 4.5)

    def test_tags(self):
        self.assertEqual(parse_tags(' x, "tag, with comma", x '), ['x', 'tag, with comma'])
        self.assertEqual(parse_tags('x,"tag, with comma",x'), ['x', 'tag, with comma'])
        self.assertEqual(parse_tags(''), [])

    def test_html_does_not_become_writing_pattern(self):
        self.assertEqual(words('<p>Imagem <i>bonita</i> &amp; clara.</p>'), ['imagem', 'bonita', 'clara'])

    def test_merge_lists_favorites_and_optional_files(self):
        profile = self.synthetic()
        self.assertEqual(len(profile.films), 3)
        film = profile.films[film_key('Café 東京', '2000')]
        self.assertEqual(len(film.uris), 2)
        self.assertTrue(film.favorite)
        self.assertEqual(film.rating, 4)
        self.assertEqual(len(film.diary_ids), 2)
        self.assertEqual(profile.lists[0].name, 'Minha lista')
        self.assertEqual(profile.lists[0].description, 'Descrição')
        self.assertEqual(len(profile.lists[0].members), 1)
        self.assertNotIn('private@example.com', str(asdict(profile)))
        self.assertNotIn('PRIVATE_LOCATION', str(asdict(profile)))
        self.assertEqual(analyze(self.export({}))['overview']['ratings']['mean'], None)

    def test_statistics_rewatches_and_review_lengths(self):
        profile = self.synthetic()
        analysis = analyze(profile)
        self.assertEqual(analysis['overview']['ratings']['mean'], 4)
        self.assertEqual(analysis['overview']['ratings']['median'], 4)
        self.assertEqual(analysis['overview']['diary_entries'], 4)
        self.assertEqual(analysis['overview']['explicit_rewatches'], 1)
        repeat = analysis['rewatches'][0]
        self.assertEqual(repeat['ratings_over_time'], [2, 4])
        self.assertEqual(repeat['changes'], [{'days': 2, 'delta': 2, 'direction': 'increased'}])
        self.assertEqual(analysis['reviews']['lengths'][0]['characters'], len(profile.reviews[0].text))
        self.assertEqual(analysis['reviews']['lengths'][0]['words'], 5)
        self.assertTrue(analysis['reviews']['writing_patterns'])
        overlap = analysis['tag_overlaps'][0]
        self.assertEqual(overlap['intersection'], 3)
        self.assertEqual(overlap['jaccard'], 1)
        self.assertEqual(analysis['tags'][0]['sessions'], 4)
        self.assertEqual(analysis['tags'][0]['ratings']['mean'], 4)

    def test_rating_directions_and_missing_dates(self):
        profile = self.synthetic()
        profile.diary[1].rating = 1
        self.assertEqual(analyze(profile)['rewatches'][0]['changes'][0]['direction'], 'decreased')
        profile.diary[1].rating = 2
        self.assertEqual(analyze(profile)['rewatches'][0]['changes'][0]['direction'], 'unchanged')
        profile.diary[1].date = ''
        self.assertEqual(analyze(profile)['rewatches'][0]['changes'][0]['direction'], 'unknown')

    def test_score_and_findings_evidence(self):
        self.assertGreater(relevance_score(20, .8), relevance_score(2, .1))
        self.assertLessEqual(relevance_score(10000, 10), 100)
        profile = self.synthetic()
        findings = build_findings(profile, analyze(profile))
        self.assertTrue(findings)
        self.assertTrue(all(f.sources and f.evidence for f in findings))
        self.assertEqual(len({f.id for f in findings}), len(findings))

    def test_context_budget_original_text_and_privacy(self):
        profile = self.synthetic()
        analysis = analyze(profile)
        findings = build_findings(profile, analysis)
        context, text = build_context(profile, analysis, findings, 'system', 300000, 'pt-BR')
        self.assertEqual(len(context['reviews']), len(profile.reviews))
        self.assertEqual(context['reviews'][0]['text'], profile.reviews[0].text)
        self.assertNotIn('private@example.com', text)
        context, text = build_context(profile, analysis, findings, 'system', 6500, 'pt-BR')
        self.assertLessEqual(len(text) + len('system'), 6500)
        self.assertTrue(any(context['coverage']['omitted'].values()))
        for review in context['reviews']:
            self.assertIn(review['text'], [r.text for r in profile.reviews])
        with self.assertRaises(ValueError):
            build_context(profile, analysis, findings, 'system', 100, 'pt-BR')

    def test_unresolved_favorite_does_not_invent_film(self):
        profile = self.export({'profile.csv': 'Favorite Films\nhttps://boxd.it/unknown\n'})
        self.assertEqual(profile.favorites[0]['status'], 'unresolved')
        self.assertFalse(profile.films)


if __name__ == '__main__':
    unittest.main()
