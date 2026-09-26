"""Objective measurements. Session ratings never replace current ratings."""
from collections import Counter, defaultdict
from dataclasses import asdict
from datetime import date
from itertools import combinations
from math import sqrt
from typing import Any

from .models import UserProfile
from .utils import plain_text, stats, words


def percentile(values: list[int], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lo = int(position)
    hi = min(lo + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (position - lo)


def interval(first: str, second: str) -> int | None:
    try:
        return (date.fromisoformat(second) - date.fromisoformat(first)).days
    except ValueError:
        return None


def rewatch_analysis(profile: UserProfile) -> list[dict[str, Any]]:
    grouped = defaultdict(list)
    for entry in profile.diary:
        grouped[entry.film_key].append(entry)
    result = []
    for key, entries in grouped.items():
        entries.sort(key=lambda e: (e.date or '9999', e.logged_date, e.id))
        if len(entries) < 2 and not any(e.rewatch for e in entries):
            continue
        ratings = [e.rating for e in entries]
        changes = []
        for a, b in zip(entries, entries[1:]):
            days = interval(a.date, b.date)
            delta = b.rating - a.rating if a.rating is not None and b.rating is not None else None
            changes.append({'days': days, 'delta': delta,
                            'direction': 'unknown' if delta is None or days is None or days == 0 else
                            'increased' if delta > 0 else 'decreased' if delta < 0 else 'unchanged'})
        result.append({'film_key': key, 'sessions': len(entries), 'ratings_over_time': ratings,
                       'dates': [e.date for e in entries], 'explicit_rewatches': sum(e.rewatch for e in entries),
                       'observed_repeat_sessions': max(0, len(entries) - 1),
                       'changes': changes, 'sources': sorted({e.source for e in entries})})
    return result


def writing_patterns(profile: UserProfile) -> list[dict[str, Any]]:
    occurrences: dict[tuple[str, str], set[str]] = defaultdict(set)
    # Small multilingual stop set suppresses function-word-only phrases, not user vocabulary.
    common = set('a o e de da do das dos em um uma que por para com os as no na the a an and of to in is it i this that was eu é não'.split())
    for review in profile.reviews:
        tokens = words(review.text)
        for size in (3, 4, 5):
            for i in range(len(tokens) - size + 1):
                phrase = tokens[i:i + size]
                if sum(t not in common for t in phrase) >= 2:
                    occurrences[('ngram', ' '.join(phrase))].add(review.id)
        if len(tokens) >= 4 and sum(t not in common for t in tokens[:4]) >= 2:
            occurrences[('opening', ' '.join(tokens[:4]))].add(review.id)
    minimum = max(3, round(len(profile.reviews) * .03))
    candidates = [{'kind': kind, 'phrase': phrase, 'review_ids': sorted(ids), 'count': len(ids)}
                  for (kind, phrase), ids in occurrences.items() if len(ids) >= minimum]
    candidates.sort(key=lambda x: (-x['count'], -len(x['phrase']), x['phrase']))
    selected = []
    for candidate in candidates:
        if not any(candidate['kind'] == other['kind'] and candidate['phrase'] in other['phrase']
                   and candidate['review_ids'] == other['review_ids'] for other in selected):
            selected.append(candidate)
    return selected[:30]


def tag_analysis(profile: UserProfile, rewatches: list[dict]) -> tuple[list[dict], list[dict]]:
    groups: dict[str, set[str]] = defaultdict(set)
    for film in profile.films.values():
        for tag in film.tags:
            groups[tag].add(film.key)
    tags = []
    for tag, keys in sorted(groups.items()):
        sessions = [e for e in profile.diary if tag in e.tags]
        reviews = [r for r in profile.reviews if tag in r.tags]
        ratings = [profile.films[k].rating for k in keys if profile.films[k].rating is not None]
        tags.append({'tag': tag, 'films': sorted(keys), 'film_count': len(keys),
                     'sessions': len(sessions), 'session_ids': [e.id for e in sessions],
                     'reviews': len(reviews), 'review_ids': [r.id for r in reviews],
                     'frequency': len(sessions) + len(reviews),
                     'frequency_unit': 'CSV records; diary and review may describe the same session',
                     'ratings': stats(ratings), 'session_ratings': stats([e.rating for e in sessions if e.rating is not None]),
                     'explicit_rewatches': sum(e.rewatch for e in sessions)})
    # Inverted index counts only pairs actually co-occurring, avoiding all tag pairs.
    overlap_counts: Counter = Counter()
    for film in profile.films.values():
        eligible = sorted(t for t in film.tags if len(groups[t]) >= 3)
        overlap_counts.update(combinations(eligible, 2))
    pairs = []
    for (a, b), count in overlap_counts.items():
        size_a, size_b = len(groups[a]), len(groups[b])
        jaccard = count / (size_a + size_b - count)
        if count >= 3 and (jaccard >= .3 or max(count / size_a, count / size_b) >= .8):
            pairs.append({'a': a, 'b': b, 'size_a': size_a, 'size_b': size_b,
                          'intersection': count, 'percent_a_in_b': 100 * count / size_a,
                          'percent_b_in_a': 100 * count / size_b, 'jaccard': jaccard,
                          'film_keys': sorted(groups[a] & groups[b])})
    pairs.sort(key=lambda p: (-p['jaccard'], -p['intersection'], p['a'], p['b']))
    return tags, pairs[:50]


def review_analysis(profile: UserProfile) -> dict[str, Any]:
    lengths = [{'id': r.id, 'film_key': r.film_key, 'rating': r.rating,
                'characters': len(r.text), 'plain_text_characters': len(plain_text(r.text)),
                'words': len(words(r.text))} for r in profile.reviews]
    sizes = [r['characters'] for r in lengths]
    by_rating = defaultdict(list)
    for r in lengths:
        if r['rating'] is not None:
            by_rating[str(r['rating'])].append(r['characters'])
    pairs = [(r['rating'], r['characters']) for r in lengths if r['rating'] is not None]
    correlation = None
    if len(pairs) >= 3:
        xs, ys = zip(*pairs)
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        denominator = sqrt(sum((x - mx)**2 for x in xs) * sum((y - my)**2 for y in ys))
        if denominator:
            correlation = sum((x - mx) * (y - my) for x, y in pairs) / denominator
    long_threshold = max(500, percentile(sizes, .9) or 0)
    short = [r for r in lengths if r['words'] <= 5]
    long = [r for r in lengths if r['characters'] >= long_threshold]
    return {'count': len(lengths), 'lengths': lengths, 'total_characters': sum(sizes),
            'total_words': sum(r['words'] for r in lengths),
            'shortest': min(lengths, key=lambda r: r['characters']) if lengths else None,
            'longest': max(lengths, key=lambda r: r['characters']) if lengths else None,
            'percentiles_characters': {str(p): percentile(sizes, p / 100) for p in (10, 25, 50, 75, 90, 95)},
            'very_short': short, 'very_long': long, 'long_threshold': long_threshold,
            'length_by_rating': {k: stats(v) for k, v in sorted(by_rating.items())},
            'rating_length_pearson': correlation,
            'low_rating_long': [r for r in long if r['rating'] is not None and r['rating'] <= 2],
            'high_rating_short': [r for r in short if r['rating'] is not None and r['rating'] >= 4.5],
            'multiple_reviews': [{'film_key': f.key, 'review_ids': f.review_ids,
                                  'diary_sessions': len(f.diary_ids)} for f in profile.films.values() if len(f.review_ids) > 1],
            'writing_patterns': writing_patterns(profile)}


def analyze(profile: UserProfile) -> dict[str, Any]:
    films = list(profile.films.values())
    rated = [f for f in films if f.rating is not None]
    ratings = [f.rating for f in rated]
    distribution = {str(i / 2): {'count': ratings.count(i / 2),
                    'percent': 100 * ratings.count(i / 2) / len(ratings) if ratings else 0} for i in range(1, 11)}
    rewatches = rewatch_analysis(profile)
    tags, overlaps = tag_analysis(profile, rewatches)
    lists = []
    repeat_keys = {r['film_key'] for r in rewatches}
    for own_list in profile.lists:
        members = [profile.films[k] for k in dict.fromkeys(m['film_key'] for m in own_list.members)]
        lists.append({**asdict(own_list), 'film_count': len(members),
                      'ratings': stats([f.rating for f in members if f.rating is not None]),
                      'member_ratings': {f.key: f.rating for f in members},
                      'favorites': sum(f.favorite for f in members), 'with_reviews': sum(bool(f.review_ids) for f in members),
                      'with_rewatches': sum(f.key in repeat_keys for f in members)})
    watched = sum(f.watched for f in films)
    watchlist = [f for f in films if f.watchlist]
    mode_count = max((v['count'] for v in distribution.values()), default=0)
    overview = {'watched_films': watched, 'rated_films': len(rated), 'diary_entries': len(profile.diary),
                'reviews': len(profile.reviews), 'watchlist': len(watchlist), 'liked_films': sum(f.liked for f in films),
                'liked_reviews': len(profile.liked_reviews), 'liked_lists': len(profile.liked_lists),
                'own_lists': len(lists), 'ratings': stats(ratings), 'distribution': distribution,
                'explicit_rewatches': sum(e.rewatch for e in profile.diary),
                'observed_repeat_sessions': sum(r['observed_repeat_sessions'] for r in rewatches)}
    return {'overview': overview, 'rating_groups': {str(i / 2): [f.key for f in rated if f.rating == i / 2] for i in range(1, 11)},
            'rating_scale': {'modes': [k for k, v in distribution.items() if v['count'] == mode_count and mode_count],
                             'top_two_share': sum(sorted((v['count'] for v in distribution.values()), reverse=True)[:2]) / len(ratings) if ratings else None,
                             'five_star_count': ratings.count(5), 'very_low_count': sum(r <= 1.5 for r in ratings),
                             'very_low_percent': 100 * sum(r <= 1.5 for r in ratings) / len(ratings) if ratings else 0},
            'rewatches': rewatches, 'reviews': review_analysis(profile), 'tags': tags, 'tag_overlaps': overlaps,
            'lists': lists, 'favorites': profile.favorites,
            'likes': {'films': [f.key for f in films if f.liked],
                      'film_ratings': stats([f.rating for f in films if f.liked and f.rating is not None]),
                      'review_count': len(profile.liked_reviews), 'list_count': len(profile.liked_lists)},
            'watchlist': {'count': len(watchlist), 'ratio_to_watched': len(watchlist) / watched if watched else None,
                          'already_watched': [f.key for f in watchlist if f.watched],
                          'dates': {f.key: f.dates.get('watchlist.csv', []) for f in watchlist}}}
