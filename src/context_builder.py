"""Compact Analyst dataset. Original review text occurs exactly once."""
from dataclasses import asdict
import json
import re
from typing import Any

from .models import Finding, UserProfile


def redact(value: Any) -> Any:
    if isinstance(value, str):
        return re.sub(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', '[email removido]', value)
    if isinstance(value, list):
        return [redact(v) for v in value]
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    return value


def film_ids(profile: UserProfile) -> dict[str, str]:
    return {key: f'f{i:04}' for i, key in enumerate(sorted(profile.films), 1)}


def replace_keys(value: Any, ids: dict[str, str]) -> Any:
    if isinstance(value, str):
        return ids.get(value, value)
    if isinstance(value, list):
        return [replace_keys(v, ids) for v in value]
    if isinstance(value, dict):
        return {ids.get(k, k): replace_keys(v, ids) for k, v in value.items()}
    return value


def build_dataset(profile: UserProfile, analysis: dict, findings: list[Finding], language: str) -> dict:
    ids = film_ids(profile)
    films = [{'key': f.key, 'name': f.name, 'year': f.year, 'current_rating': f.rating,
              'watched': f.watched, 'watchlist': f.watchlist, 'liked': f.liked, 'favorite': f.favorite}
             for f in profile.films.values()]
    diary = [{'id': e.id, 'film_key': e.film_key, 'date': e.date, 'session_rating': e.rating,
              'rewatch': e.rewatch, 'tags': e.tags} for e in profile.diary]
    reviews = [{'id': r.id, 'film_key': r.film_key, 'date': r.date, 'review_rating': r.rating,
                'tags': r.tags, 'text': r.text} for r in profile.reviews]
    tags = [{k: v for k, v in t.items() if k in {'tag', 'film_count', 'sessions', 'reviews',
             'current_film_ratings', 'session_ratings', 'explicit_rewatches', 'unique_session_films'}} for t in analysis['tags']]
    lists = [{k: v for k, v in item.items() if k in {'id', 'name', 'description', 'tags', 'members', 'film_count', 'ratings'}}
             for item in analysis['lists']]
    return redact(replace_keys({
        'task': 'Identify evidence-backed semantic candidates; do not write the judgment.', 'language': language,
        'available_sources': [i['file'] for i in profile.inventory if i['status'] == 'read'],
        'semantics': {'film': 'current_rating from ratings.csv only',
                      'diary': 'session_rating and tags apply only to this diary row',
                      'review': 'review_rating applies to this review, not necessarily the current rating',
                      'tags': 'contextual mean uses rated diary rows; current film mean is separate; never infer causality',
                      'rewatch': 'explicit flags and observed repeats overlap; never add them',
                      'unknown': 'null, missing and omitted data are unknown; no external chronology or popularity is supplied',
                      'evidence_ids': 'film:key; review:id; diary:id; tag:tag; list:id; finding:id; stats:overview; rewatch:film_key'},
        'stats': analysis['overview'], 'films': films, 'diary': diary, 'reviews': reviews,
        'tags': tags, 'lists': lists, 'rewatches': analysis['rewatches'],
        'deterministic_findings': [asdict(f) for f in findings],
        'comments': [{'id': f'comment:{i}', **c} for i, c in enumerate(profile.comments, 1)]}, ids))


def build_context(profile: UserProfile, analysis: dict, findings: list[Finding],
                  system: str, max_chars: int, language: str) -> tuple[dict, str]:
    context = build_dataset(profile, analysis, findings, language)
    collections = {k: v for k, v in context.items() if isinstance(v, list) and k != 'available_sources'}
    totals = {k: len(v) for k, v in collections.items()}

    def serialize() -> str:
        context['coverage'] = {'total': totals, 'included': {k: len(context[k]) for k in totals},
                               'omitted': {k: totals[k] - len(context[k]) for k in totals}, 'reviews_truncated': False}
        return json.dumps(context, ensure_ascii=False, separators=(',', ':'), allow_nan=False)

    message = serialize()
    if len(system) + len(message) <= max_chars:
        return context, message
    ids = film_ids(profile)
    priorities = {ids[f.key]: 20 * f.favorite + 10 * bool(f.list_ids) for f in profile.films.values()}
    for f in findings:
        for key in f.film_keys:
            fid = ids.get(key)
            priorities[fid] = max(priorities.get(fid, 0), f.score)
    for key in totals:
        context[key] = []
    if len(system) + len(serialize()) > max_chars:
        raise ValueError('MAX_CONTEXT_CHARS é pequeno demais para as estatísticas básicas.')
    catalog = {f['key']: f for f in collections['films']}

    def refs(value: Any) -> set[str]:
        if isinstance(value, str):
            return {value} if value in catalog else set()
        if isinstance(value, list):
            return set().union(*(refs(v) for v in value)) if value else set()
        if isinstance(value, dict):
            return refs(list(value.values()))
        return set()

    def include(kind: str, item: dict, limit: int) -> None:
        if item in context[kind]:
            return
        old_films = context['films'].copy()
        existing = {f['key'] for f in old_films}
        context['films'].extend(catalog[k] for k in sorted(refs(item) - existing))
        if kind != 'films':
            context[kind].append(item)
        if len(system) + len(serialize()) > limit:
            context['films'] = old_films
            if kind != 'films':
                context[kind].pop()

    reviews = sorted(collections['reviews'], key=lambda r: (-priorities.get(r['film_key'], 0), r['id']))
    base = len(system) + len(serialize())
    for review in reviews:
        include('reviews', review, base + (max_chars - base) // 2)
    for kind in ('deterministic_findings', 'tags', 'lists', 'rewatches', 'diary'):
        for item in collections[kind]:
            include(kind, item, max_chars)
    for review in reviews:
        include('reviews', review, max_chars)
    for kind in ('films', 'comments'):
        for item in collections[kind]:
            include(kind, item, max_chars)
    return context, serialize()
