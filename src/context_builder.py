"""Complete Analyst dataset: faithful raw ZIP JSON plus normalized evidence indexes."""
from dataclasses import asdict
import json
import re
from typing import Any

from .models import Finding, UserProfile


def redact(value: Any) -> Any:
    """Redact incidental email addresses only from the normalized helper index.

    raw_export is intentionally not passed through this function: when the caller
    opts into the full-export Analyst flow, that object is the faithful ZIP JSON.
    """
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


def build_dataset(profile: UserProfile, analysis: dict, findings: list[Finding], language: str,
                  raw_export: dict | None = None) -> dict:
    """Build the evidence index the Analyst cites, plus the complete ZIP JSON.

    The normalized section is not a replacement for the export. It exists so the
    Analyst can cite stable IDs that our validator understands.
    """
    ids = film_ids(profile)
    films = [{'key': f.key, 'name': f.name, 'year': f.year, 'current_rating': f.rating,
              'watched': f.watched, 'watchlist': f.watchlist, 'liked': f.liked, 'favorite': f.favorite}
             for f in profile.films.values()]
    diary = [{'id': e.id, 'film_key': e.film_key, 'date': e.date, 'logged_date': e.logged_date,
              'session_rating': e.rating, 'rewatch': e.rewatch, 'tags': e.tags, 'uri': e.uri}
             for e in profile.diary]
    reviews = [{'id': r.id, 'film_key': r.film_key, 'date': r.date, 'logged_date': r.logged_date,
                'review_rating': r.rating, 'rewatch': r.rewatch, 'tags': r.tags, 'uri': r.uri, 'text': r.text}
               for r in profile.reviews]
    tags = [{k: v for k, v in t.items() if k in {'tag', 'film_count', 'sessions', 'session_ids', 'reviews',
             'review_ids', 'current_film_ratings', 'session_ratings', 'explicit_rewatches', 'unique_session_films',
             'rated_session_ids', 'film_keys', 'films'}} for t in analysis['tags']]
    lists = [{k: v for k, v in item.items() if k in {
                'id', 'name', 'description', 'tags', 'members', 'film_count', 'ratings',
                'member_ratings', 'favorites', 'with_reviews', 'with_rewatches', 'member_details'
             }} for item in analysis['lists']]
    review_style = analysis.get('review_style') or {}
    review_style_items = []
    for group in ('phrases', 'openings', 'closings', 'intersections'):
        review_style_items.extend(review_style.get(group, []))
    review_style_items.extend((review_style.get('markup') or {}).values())

    normalized = redact(replace_keys({
        'task': ('Read the complete raw Letterboxd export, discover genuinely interesting editorial moments, '
                 'then cite them through the normalized evidence IDs. Do not write the final Judge copy.'),
        'language': language,
        'available_sources': [i['file'] for i in profile.inventory],
        'semantics': {
            'raw_export': ('faithful ZIP content, including inactive deleted/orphaned files; use it for discovery, '
                           'but cite active normalized evidence for final editorial selections'),
            'film': 'current_rating comes from ratings.csv only',
            'diary': 'session_rating and tags apply only to this diary row',
            'review': 'review_rating applies to this review, not necessarily the current rating',
            'tags': 'contextual means use rated diary rows; association is not causation',
            'rewatch': 'explicit flags and observed repeats overlap; never add them',
            'unknown': 'null or missing is unknown; no external chronology/popularity is supplied',
            'evidence_ids': ('film:key; review:id; diary:id; tag:tag; list:id; finding:id; '
                             'stats:overview|review_coverage; rewatch:film_key; review_style:id'),
        },
        'stats': analysis['overview'],
        'review_coverage': analysis.get('review_coverage', {}),
        'rating_scale': analysis.get('rating_scale', {}),
        'watchlist_summary': analysis.get('watchlist', {}),
        'likes_summary': analysis.get('likes', {}),
        'favorites': analysis.get('favorites', []),
        'review_style': review_style,
        'review_style_items': review_style_items,
        'films': films,
        'diary': diary,
        'reviews': reviews,
        'tags': tags,
        'lists': lists,
        'rewatches': analysis['rewatches'],
        'deterministic_findings': [asdict(f) for f in findings],
        'comments': [{'id': f'comment:{i}', **c} for i, c in enumerate(profile.comments, 1)],
    }, ids))

    if raw_export is not None:
        normalized['raw_export'] = raw_export
    return normalized


def build_context(profile: UserProfile, analysis: dict, findings: list[Finding],
                  system: str, max_chars: int, language: str,
                  raw_export: dict | None = None) -> tuple[dict, str]:
    """Serialize the complete Analyst context. Never silently trim the export."""
    context = build_dataset(profile, analysis, findings, language, raw_export)
    context['coverage'] = {
        'complete': True,
        'truncated': False,
        'reviews_in_normalized_index': len(context.get('reviews', [])),
        'raw_export_files': (raw_export or {}).get('file_count', 0),
        'raw_export_included': raw_export is not None,
    }
    message = json.dumps(context, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    actual = len(system) + len(message)
    if actual > max_chars:
        raise ValueError(
            f'O contexto completo do export tem {actual:,} caracteres e MAX_CONTEXT_CHARS={max_chars:,} '
            f'(excesso de {actual - max_chars:,}). Nada foi truncado. Aumente MAX_CONTEXT_CHARS ou rode com '
            'ANALYST_RAW_EXPORT=0 para enviar apenas o índice normalizado, sem o ZIP bruto.'
        )
    return context, message
