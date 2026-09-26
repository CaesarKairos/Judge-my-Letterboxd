"""Transparent ranking heuristics, not scientific confidence or humor rules."""
from math import log2
from typing import Any

from .models import Finding, UserProfile


def relevance_score(sample: int, magnitude: float, confidence: float = 1.0) -> int:
    return round(min(100, 15 + min(30, log2(max(1, sample)) * 6) + 55 * min(1, max(0, magnitude))) * min(1, max(0, confidence)))


def build_findings(profile: UserProfile, analysis: dict[str, Any]) -> list[Finding]:
    findings: list[Finding] = []

    def add(kind: str, summary: str, evidence: dict, keys: list[str], sources: list[str], sample: int, magnitude: float) -> None:
        findings.append(Finding(f'{kind}_{len(findings) + 1:03}', kind, relevance_score(sample, magnitude),
                                1.0, summary, evidence, keys, sources))

    total = analysis['overview']['rated_films']
    for rating, keys in analysis['rating_groups'].items():
        if keys and (float(rating) <= 1.5 or float(rating) >= 4.5 or len(keys) >= 5):
            share = len(keys) / total
            add('rating_group', f'{len(keys)} de {total} ratings são {rating} ({share:.1%}).',
                {'rating': float(rating), 'count': len(keys), 'share': share}, keys, ['ratings.csv'], len(keys), share)
    for item in analysis['rewatches']:
        add('rewatch', f"{item['sessions']} sessões registradas; {item['explicit_rewatches']} marcadas como rewatch.",
            item, [item['film_key']], item['sources'], item['sessions'],
            max([abs(c['delta']) / 4.5 for c in item['changes'] if c['delta'] is not None] + [.2]))
    for item in analysis['tag_overlaps']:
        add('tag_overlap', f"Tags compartilham {item['intersection']} filmes; Jaccard {item['jaccard']:.1%}.",
            item, item['film_keys'], ['diary.csv', 'reviews.csv'], item['intersection'], item['jaccard'])
    global_mean = analysis['overview']['ratings']['mean']
    for tag in analysis['tags']:
        if tag['ratings']['count'] >= 3 and global_mean is not None:
            delta = tag['ratings']['mean'] - global_mean
            if abs(delta) >= .5:
                add('tag_rating_difference', f"Tag {tag['tag']!r}: média difere {delta:+.2f} da média global.",
                    {'tag': tag['tag'], 'ratings': tag['ratings'], 'global_mean': global_mean, 'delta': delta},
                    tag['films'], ['ratings.csv', 'diary.csv', 'reviews.csv'], tag['ratings']['count'], abs(delta) / 2)
    review_stats = analysis['reviews']
    for category in ('low_rating_long', 'high_rating_short', 'very_long', 'very_short'):
        items = review_stats[category]
        if items:
            add('review_' + category, f'{len(items)} reviews no grupo {category}.',
                {'reviews': items}, list(dict.fromkeys(i['film_key'] for i in items)), ['reviews.csv'], len(items), .6)
    for pattern in review_stats['writing_patterns']:
        keys = list(dict.fromkeys(r.film_key for r in profile.reviews if r.id in pattern['review_ids']))
        add('writing_pattern', f"Expressão aparece em {pattern['count']} reviews distintas.", pattern,
            keys, ['reviews.csv'], pattern['count'], pattern['count'] / max(1, len(profile.reviews)))
    for item in review_stats['multiple_reviews']:
        add('multiple_reviews', f"Filme possui {len(item['review_ids'])} reviews.", item,
            [item['film_key']], ['reviews.csv', 'diary.csv'], len(item['review_ids']), .4)
    liked_mean = analysis['likes']['film_ratings']['mean']
    if analysis['likes']['film_ratings']['count'] >= 3 and global_mean is not None and abs(liked_mean - global_mean) >= .5:
        add('liked_rating_difference', 'Média dos filmes curtidos difere da média global em pelo menos 0.5.',
            {'liked': analysis['likes']['film_ratings'], 'global_mean': global_mean}, analysis['likes']['films'],
            ['likes/films.csv', 'ratings.csv'], analysis['likes']['film_ratings']['count'], abs(liked_mean - global_mean) / 2)
    return sorted(findings, key=lambda f: (-f.score, f.id))
