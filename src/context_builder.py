"""Budget the actual user message and system instruction, keeping reviews whole."""
from dataclasses import asdict
import json
import re
from typing import Any

from .models import Finding, UserProfile


def redact(value: Any) -> Any:
    """Defense in depth for email addresses in user-authored free text."""
    if isinstance(value, str):
        return re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[email removido]', value)
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    return value


def build_context(profile: UserProfile, analysis: dict[str, Any], findings: list[Finding],
                  system: str, max_chars: int, language: str) -> tuple[dict, str]:
    context: dict[str, Any] = {
        'task': 'Julgue somente usando as evidências deste export.', 'language': language,
        'available_sources': [i['file'] for i in profile.inventory if i['status'] == 'read'],
        'semantics': {'current_ratings': 'ratings.csv only; null means unknown',
                      'sessions': 'diary.csv only; reviews are not additional sessions',
                      'rewatches': 'explicit flags and observed repetitions are distinct, never add them',
                      'tag_frequency': 'record frequency may count diary and review for one session',
                      'favorites': 'unresolved references do not imply ratings',
                      'privacy': 'profile fields excluded; email addresses redacted in free text',
                      'omissions': 'omitted evidence is unknown, not absent'},
        'stats': analysis['overview'], 'rating_scale': analysis['rating_scale'],
        'watchlist_summary': {k: v for k, v in analysis['watchlist'].items() if k != 'dates'},
        'likes_summary': analysis['likes'],
        'review_stats': {k: v for k, v in analysis['reviews'].items() if k in
                         {'count', 'total_characters', 'total_words', 'percentiles_characters', 'length_by_rating', 'rating_length_pearson'}},
        'findings': [], 'films': [], 'rewatches': [], 'tags': [], 'lists': [], 'favorites': [],
        'reviews': [], 'comments': [],
        'coverage': {'total': {}, 'included': {}, 'omitted': {}, 'reviews_truncated': False}}
    priority = {f.key: 0.0 for f in profile.films.values()}
    for finding in findings:
        for key in finding.film_keys:
            priority[key] = max(priority.get(key, 0), finding.score)
    for film in profile.films.values():
        priority[film.key] += 20 * film.favorite + 10 * bool(film.list_ids) + 5 * bool(film.tags)
        priority[film.key] += 15 * (film.rating is not None and (film.rating <= 1.5 or film.rating >= 4.5))
    ranked_films = sorted(profile.films.values(), key=lambda f: (-priority[f.key], f.key))
    candidates = {
        'findings': [asdict(f) for f in findings],
        'films': [{'key': f.key, 'name': f.name, 'year': f.year, 'rating': f.rating,
                   'watched': f.watched, 'watchlist': f.watchlist, 'liked': f.liked, 'favorite': f.favorite,
                   'tags': f.tags, 'list_ids': f.list_ids, 'diary_ids': f.diary_ids, 'review_ids': f.review_ids}
                  for f in ranked_films],
        'rewatches': analysis['rewatches'], 'tags': analysis['tags'], 'lists': analysis['lists'],
        'favorites': profile.favorites,
        'reviews': [asdict(r) for r in sorted(profile.reviews, key=lambda r: (-priority[r.film_key], r.id))],
        'comments': profile.comments}
    candidates = redact(candidates)
    context['coverage']['total'] = {k: len(v) for k, v in candidates.items()}

    def serialize() -> str:
        context['coverage']['included'] = {k: len(context[k]) for k in candidates}
        context['coverage']['omitted'] = {k: len(v) - len(context[k]) for k, v in candidates.items()}
        return json.dumps(context, ensure_ascii=False, allow_nan=False)

    for key, values in candidates.items():
        context[key] = values.copy()
    message = serialize()
    if len(system) + len(message) <= max_chars:
        return context, message
    for key in candidates:
        context[key] = []
    if len(system) + len(serialize()) > max_chars:
        raise ValueError('MAX_CONTEXT_CHARS é pequeno demais para as estatísticas básicas; aumente o limite.')

    # Reserve half the remaining budget for original reviews before ancillary collections.
    base_size = len(system) + len(serialize())
    first_limit = base_size + (max_chars - base_size) // 2
    used: dict[str, set[int]] = {k: set() for k in candidates}

    def include(key: str, index: int, limit: int) -> None:
        if index in used[key]:
            return
        context[key].append(candidates[key][index])
        if len(system) + len(serialize()) <= limit:
            used[key].add(index)
        else:
            context[key].pop()

    for i in range(len(candidates['reviews'])):
        include('reviews', i, first_limit)
    for key in ('findings', 'rewatches', 'favorites', 'lists', 'tags', 'films'):
        for i in range(len(candidates[key])):
            include(key, i, max_chars)
    for key in ('reviews', 'comments'):
        for i in range(len(candidates[key])):
            include(key, i, max_chars)
    return context, serialize()
