"""Generic review-style analysis for editorial discovery.

This module measures repeated language and markup without deciding what is funny.
It deliberately contains no user-specific phrases, titles or tags.
"""
from collections import defaultdict
import re
from typing import Any

from .models import ReviewRecord
from .utils import plain_text, words

BLOCKQUOTE_RE = re.compile(r'<\s*blockquote\b', re.I)
STRONG_RE = re.compile(r'<\s*(?:strong|b)\b', re.I)
EM_RE = re.compile(r'<\s*(?:em|i)\b', re.I)

# Function words can participate in a phrase, but a candidate should contain at
# least one content-bearing token. "isso" is intentionally treated as common:
# a bigram such as "dito isso" still survives because "dito" carries content.
COMMON = set(
    'a o e de da do das dos em um uma uns umas que por para com os as no na nos nas '
    'ao aos à às se mas ou como mais menos muito muita muito muitas isso isto esse essa '
    'ele ela eles elas eu você voces vocês meu minha seu sua pra pro pelo pela porque '
    'the a an and of to in is it i this that was were are be on for with but or'.split()
)


def _candidate_allowed(tokens: tuple[str, ...], size: int) -> bool:
    if not tokens:
        return False
    content = [token for token in tokens if token not in COMMON and len(token) >= 3]
    if size == 1:
        return bool(content) and len(tokens[0]) >= 4
    return bool(content)


def _phrase_rows(reviews: list[ReviewRecord]) -> list[dict[str, Any]]:
    occurrences: dict[tuple[int, str], set[str]] = defaultdict(set)
    for review in reviews:
        tokens = words(review.text)
        seen: set[tuple[int, str]] = set()
        for size in (1, 2, 3):
            for index in range(len(tokens) - size + 1):
                group = tuple(tokens[index:index + size])
                if not _candidate_allowed(group, size):
                    continue
                key = (size, ' '.join(group))
                if key not in seen:
                    occurrences[key].add(review.id)
                    seen.add(key)

    total = len(reviews)
    rows = []
    for (size, phrase), ids in occurrences.items():
        # Unigrams need stronger prevalence to avoid a cloud of ordinary nouns.
        minimum = max(4, round(total * (.08 if size == 1 else .03)))
        if len(ids) < minimum:
            continue
        rows.append({
            'id': f'phrase:{size}:{phrase}',
            'kind': 'phrase',
            'size': size,
            'phrase': phrase,
            'review_ids': sorted(ids),
            'count': len(ids),
            'share': len(ids) / total if total else 0,
        })
    # Prefer a compact multi-word expression over a lone token when both
    # describe exactly the same reviews. Bigrams usually carry the idiom/style
    # ("dito isso") while the unigram alone ("dito") loses the point.
    size_priority = {2: 0, 3: 1, 1: 2}
    rows.sort(key=lambda row: (-row['count'], size_priority.get(row['size'], 9), row['phrase']))

    # Remove longer phrases that cover exactly the same reviews as a shorter,
    # more reusable phrase contained inside them. This keeps the editorial signal
    # ("dito isso") instead of only surfacing a narrower extension.
    selected: list[dict[str, Any]] = []
    for row in rows:
        duplicate = False
        for other in selected:
            if (other['review_ids'] == row['review_ids']
                    and (other['phrase'] in row['phrase'] or row['phrase'] in other['phrase'])):
                duplicate = True
                break
        if not duplicate:
            selected.append(row)
    return selected[:60]


def _edge_patterns(reviews: list[ReviewRecord], edge: str) -> list[dict[str, Any]]:
    occurrences: dict[str, set[str]] = defaultdict(set)
    for review in reviews:
        tokens = words(review.text)
        for size in (2, 3, 4):
            if len(tokens) < size:
                continue
            group = tokens[:size] if edge == 'opening' else tokens[-size:]
            if not _candidate_allowed(tuple(group), size):
                continue
            occurrences[' '.join(group)].add(review.id)
    minimum = max(3, round(len(reviews) * .03))
    rows = [{
        'id': f'{edge}:{phrase}',
        'kind': edge,
        'phrase': phrase,
        'review_ids': sorted(ids),
        'count': len(ids),
        'share': len(ids) / len(reviews) if reviews else 0,
    } for phrase, ids in occurrences.items() if len(ids) >= minimum]
    rows.sort(key=lambda row: (-row['count'], len(row['phrase']), row['phrase']))
    return rows[:25]


def analyze_review_style(reviews: list[ReviewRecord]) -> dict[str, Any]:
    phrases = _phrase_rows(reviews)
    openings = _edge_patterns(reviews, 'opening')
    closings = _edge_patterns(reviews, 'closing')

    markup_sets = {
        'blockquote': {r.id for r in reviews if BLOCKQUOTE_RE.search(r.text or '')},
        'strong': {r.id for r in reviews if STRONG_RE.search(r.text or '')},
        'emphasis': {r.id for r in reviews if EM_RE.search(r.text or '')},
    }
    markup = {
        key: {
            'id': f'markup:{key}',
            'kind': 'markup',
            'markup': key,
            'review_ids': sorted(ids),
            'count': len(ids),
            'share': len(ids) / len(reviews) if reviews else 0,
        }
        for key, ids in markup_sets.items()
    }

    intersections = []
    for phrase in phrases[:30]:
        phrase_ids = set(phrase['review_ids'])
        for markup_name, markup_ids in markup_sets.items():
            shared = phrase_ids & markup_ids
            if len(shared) < max(3, round(len(reviews) * .03)):
                continue
            # Keep intersections that cover a meaningful part of either side.
            phrase_coverage = len(shared) / max(1, len(phrase_ids))
            markup_coverage = len(shared) / max(1, len(markup_ids))
            if max(phrase_coverage, markup_coverage) < .35:
                continue
            intersections.append({
                'id': f"intersection:{phrase['id']}:{markup_name}",
                'kind': 'intersection',
                'phrase_id': phrase['id'],
                'phrase': phrase['phrase'],
                'markup': markup_name,
                'review_ids': sorted(shared),
                'count': len(shared),
                'phrase_coverage': phrase_coverage,
                'markup_coverage': markup_coverage,
            })
    intersections.sort(key=lambda row: (-row['count'], -row['phrase_coverage'], row['phrase']))

    return {
        'review_count': len(reviews),
        'phrases': phrases,
        'openings': openings,
        'closings': closings,
        'markup': markup,
        'intersections': intersections[:40],
    }
