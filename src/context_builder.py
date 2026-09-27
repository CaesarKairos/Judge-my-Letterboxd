"""Build the AI dataset. The full ZIP export is included or the request fails loudly."""
from dataclasses import asdict
import json
from typing import Any

from .models import Finding, UserProfile


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

    normalized = replace_keys({
        'task': 'Identify evidence-backed semantic candidates; do not write the judgment.',
        'language': language,
        'available_sources': [i['file'] for i in profile.inventory],
        'semantics': {
            'film': 'current_rating from ratings.csv only',
            'diary': 'session_rating and tags apply only to this diary row',
            'review': 'review_rating applies to this review, not necessarily the current rating',
            'tags': 'contextual mean uses rated diary rows; current film mean is separate; never infer causality',
            'rewatch': 'explicit flags and observed repeats overlap; never add them',
            'unknown': 'null and missing data are unknown; no external chronology or popularity is supplied',
            'raw_export': 'complete JSON conversion of every ZIP member; use it to inspect the full export, while evidence citations must still use normalized IDs',
            'evidence_ids': 'film:key; review:id; diary:id; tag:tag; list:id; finding:id; stats:overview; rewatch:film_key',
        },
        'stats': analysis['overview'],
        'films': films,
        'diary': diary,
        'reviews': reviews,
        'tags': tags,
        'lists': lists,
        'rewatches': analysis['rewatches'],
        'deterministic_findings': [asdict(f) for f in findings],
        'comments': [{'id': f'comment:{i}', **c} for i, c in enumerate(profile.comments, 1)],
        'liked_reviews': [{'id': f'liked_review:{i}', **c} for i, c in enumerate(profile.liked_reviews, 1)],
        'liked_lists': [{'id': f'liked_list:{i}', **c} for i, c in enumerate(profile.liked_lists, 1)],
        'favorites': profile.favorites,
    }, ids)

    # Deliberately appended after key replacement: raw_export must stay a faithful JSON
    # representation of the ZIP cells rather than having canonical film IDs substituted.
    normalized['raw_export'] = profile.raw_export
    normalized['archive_manifest'] = profile.inventory
    return normalized


def build_context(profile: UserProfile, analysis: dict, findings: list[Finding],
                  system: str, max_chars: int, language: str) -> tuple[dict, str]:
    context = build_dataset(profile, analysis, findings, language)
    csv_rows = sum(item.get('row_count', 0) for item in profile.raw_export if item.get('kind') == 'csv')
    context['coverage'] = {
        'mode': 'full_zip',
        'zip_files_total': len(profile.raw_export),
        'zip_files_included': len(profile.raw_export),
        'csv_rows_included': csv_rows,
        'omitted_files': 0,
        'truncated': False,
    }
    message = json.dumps(context, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    total = len(system) + len(message)
    if total > max_chars:
        raise ValueError(
            f'O contexto completo do ZIP precisa de {total:,} caracteres, mas MAX_CONTEXT_CHARS={max_chars:,}. '
            'Nenhum dado foi truncado. Aumente MAX_CONTEXT_CHARS para enviar o export inteiro.'
        )
    return context, message
