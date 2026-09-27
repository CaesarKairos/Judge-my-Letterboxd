"""Display-first Editorial Moments assembled from evidence selected by the Analyst."""
import json
import re
from typing import Any

from .utils import plain_text

EXCERPT_LIMIT = 260
EXAMPLE_LIMIT = 150
MAX_EXAMPLES = 3
MAX_DISPLAY_FILMS = 4

MOMENT_TYPES = {
    # Semantic: these are the preferred final-show candidates.
    'semantic_contrast': 'rating_contrast',
    'review_spotlight': 'review_spotlight',
    'self_irony': 'review_spotlight',
    'recurring_idea': 'writing_pattern',
    'list_meaning': 'list',
    'tag_meaning': 'tag',
    'meaningful_exception': 'semantic',
    # Deterministic fallback only; script_engine decides whether they are eligible.
    'rewatch': 'rewatch',
    'writing_pattern': 'writing_pattern',
    'tag_overlap': 'tag',
    'own_list': 'list',
    'multiple_reviews': 'review_spotlight',
}

WRITER_MODES = {
    'rating_contrast': 'contrast',
    'review_spotlight': 'quote_reaction',
    'rewatch': 'short_reaction',
    'tag': 'short_reaction',
    'list': 'short_reaction',
    'writing_pattern': 'short_reaction',
    'semantic': 'semantic_punch',
    'odd_stat': 'raw_reveal',
}


def short_excerpt(text: str, limit: int = EXCERPT_LIMIT) -> str:
    clean = ' '.join(plain_text(text or '').split())
    if len(clean) <= limit:
        return clean
    head = clean[:limit].rsplit(' ', 1)[0].rstrip(',;:.') or clean[:limit]
    return f'{head}…'


def _film_ref(data: dict) -> dict:
    return {
        'film_key': data['key'],
        'title': data['name'],
        'year': data.get('year', ''),
        'rating': data.get('current_rating'),
    }


def collect_evidence(finding: dict) -> dict[str, Any]:
    """Index the resolved evidence by source type for display construction."""
    parts: dict[str, Any] = {
        'films': {},
        'reviews': {},
        'diary': {},
        'tags': {},
        'lists': {},
        'rewatches': {},
        'finding': None,
    }
    for item in finding['evidence']:
        kind, data = item['source_type'], item['data']
        if kind == 'finding' and parts['finding'] is None:
            parts['finding'] = data
        elif kind in {'film', 'film_identity'} and data.get('key'):
            parts['films'].setdefault(data['key'], data)
        elif kind == 'review' and data.get('id'):
            parts['reviews'].setdefault(data['id'], data)
        elif kind == 'diary' and data.get('id'):
            parts['diary'].setdefault(data['id'], data)
        elif kind == 'tag':
            parts['tags'].setdefault(item['source_id'], data)
        elif kind == 'list':
            parts['lists'].setdefault(item['source_id'], data)
        elif kind == 'rewatch':
            parts['rewatches'].setdefault(item['source_id'], data)

    for key in finding.get('film_keys', []):
        parts['films'].setdefault(key, {'key': key, 'name': key, 'year': '', 'current_rating': None})

    parts['films'] = list(parts['films'].values())
    parts['reviews'] = list(parts['reviews'].values())
    parts['diary'] = list(parts['diary'].values())
    parts['tags'] = list(parts['tags'].values())
    parts['lists'] = list(parts['lists'].values())
    parts['rewatches'] = list(parts['rewatches'].values())
    parts['data'] = (parts['finding'] or {}).get('evidence') or {}
    return parts


def _stat(key: str, value: Any, label: str | None = None) -> dict:
    return {'key': key, 'value': value, 'label': label or key}


def _films(parts: dict, rated_only: bool = False) -> list[dict]:
    chosen = [f for f in parts['films'] if f.get('current_rating') is not None] if rated_only else parts['films']
    return [_film_ref(f) for f in chosen[:MAX_DISPLAY_FILMS]]


def _review_display(parts: dict) -> dict:
    chosen = parts['reviews'][0] if parts['reviews'] else None
    if chosen is None:
        return {'kind': 'film_group', 'films': _films(parts), 'stats': []}
    film = next((f for f in parts['films'] if f['key'] == chosen.get('film_key')), None)
    return {
        'kind': 'review_quote',
        'films': [_film_ref(film)] if film else [],
        'review': {
            'review_id': chosen['id'],
            'film_key': chosen.get('film_key'),
            'title': film['name'] if film else chosen.get('film_key', ''),
            'year': film.get('year', '') if film else '',
            'rating': chosen.get('review_rating'),
            'text': short_excerpt(chosen.get('excerpt') or chosen.get('text', '')),
        },
        'stats': [],
    }


def _semantic_contrast(parts: dict) -> dict:
    rated = _films(parts, rated_only=True)
    if len(rated) >= 2:
        return {'kind': 'rating_pair', 'films': rated[:2], 'stats': []}
    return {'kind': 'film_group', 'films': _films(parts), 'stats': []}


def _list_display(parts: dict) -> dict:
    if parts['lists']:
        item = parts['lists'][0]
        member_keys = [m.get('film_key') for m in item.get('members', [])]
        films = [_film_ref(f) for f in parts['films'] if f['key'] in member_keys][:MAX_DISPLAY_FILMS]
        return {
            'kind': 'list_members',
            'name': item.get('name', ''),
            'description': short_excerpt(item.get('description', ''), 220),
            'films': films or _films(parts),
            'stats': [_stat('films', item.get('film_count'))] if item.get('film_count') is not None else [],
        }
    data = parts['data']
    return {
        'kind': 'list_members',
        'name': data.get('name', ''),
        'description': short_excerpt(data.get('description', ''), 220),
        'films': _films(parts),
        'stats': [_stat('films', data.get('film_count'))] if data.get('film_count') is not None else [],
    }


def _tag_display(parts: dict, finding: dict) -> dict:
    if parts['tags']:
        item = parts['tags'][0]
        tag_name = item.get('tag') or (finding.get('related_tags') or [''])[0]
        return {
            'kind': 'tag_stats',
            'tag': tag_name,
            'related_tag': (finding.get('related_tags') or ['', ''])[1] if len(finding.get('related_tags') or []) > 1 else '',
            'films': _films(parts),
            'stats': [],
        }
    data = parts['data']
    if finding['type'] == 'tag_overlap':
        return {
            'kind': 'tag_stats',
            'tag': data.get('a', ''),
            'related_tag': data.get('b', ''),
            'films': _films(parts),
            'stats': [
                s for s in (
                    _stat('films_a', data.get('size_a')),
                    _stat('films_b', data.get('size_b')),
                    _stat('shared_films', data.get('intersection')),
                    _stat('jaccard', data.get('jaccard')),
                ) if s['value'] is not None
            ],
        }
    return {'kind': 'tag_stats', 'tag': (finding.get('related_tags') or [''])[0], 'related_tag': '',
            'films': _films(parts), 'stats': []}


def _rewatch_display(parts: dict) -> dict:
    data = parts['rewatches'][0] if parts['rewatches'] else parts['data']
    ratings, dates = data.get('ratings_over_time') or [], data.get('dates') or []
    sessions = [{'index': i + 1, 'rating': rating, 'date': dates[i] if i < len(dates) else ''}
                for i, rating in enumerate(ratings)]
    film_key = data.get('film_key', '')
    film = next((f for f in parts['films'] if f['key'] == film_key), None)
    film = film or (parts['films'][0] if parts['films'] else
                    {'key': film_key, 'name': film_key, 'year': '', 'current_rating': None})
    return {
        'kind': 'rewatch_sessions',
        'film': _film_ref(film),
        'sessions': sessions,
        'stats': [
            s for s in (
                _stat('sessions', data.get('sessions')),
                _stat('explicit_rewatches', data.get('explicit_rewatches')),
            ) if s['value'] is not None
        ],
    }


def _writing_display(parts: dict) -> dict:
    data = parts['data']
    phrase = data.get('phrase', '')
    examples = []
    for review in parts['reviews'][:MAX_EXAMPLES]:
        excerpt = review.get('excerpt') or review.get('text', '')
        if excerpt:
            examples.append(short_excerpt(excerpt, EXAMPLE_LIMIT))
    # Semantic recurring ideas may not be represented as a literal n-gram. In that
    # case, show concrete cited review excerpts instead of inventing a phrase.
    if phrase:
        return {
            'kind': 'writing_pattern',
            'phrase': phrase,
            'films': _films(parts),
            'examples': examples,
            'stats': [_stat('reviews', data.get('count'))] if data.get('count') is not None else [],
        }
    if parts['reviews']:
        return {
            'kind': 'review_group',
            'films': _films(parts),
            'reviews': [
                {
                    'review_id': r['id'],
                    'film_key': r.get('film_key'),
                    'text': short_excerpt(r.get('excerpt') or r.get('text', ''), EXAMPLE_LIMIT),
                    'rating': r.get('review_rating'),
                } for r in parts['reviews'][:MAX_EXAMPLES]
            ],
            'stats': [],
        }
    return {'kind': 'film_group', 'films': _films(parts), 'stats': []}


def build_display(finding: dict, locale) -> dict:
    parts = collect_evidence(finding)
    kind = MOMENT_TYPES.get(finding['type'], 'semantic' if finding['origin'] == 'semantic' else 'odd_stat')

    if finding['type'] == 'semantic_contrast':
        display = _semantic_contrast(parts)
    elif finding['type'] in {'review_spotlight', 'self_irony', 'multiple_reviews'}:
        display = _review_display(parts)
    elif finding['type'] == 'list_meaning' or kind == 'list':
        display = _list_display(parts)
    elif finding['type'] == 'tag_meaning' or kind == 'tag':
        display = _tag_display(parts, finding)
    elif finding['type'] == 'recurring_idea' or kind == 'writing_pattern':
        display = _writing_display(parts)
    elif kind == 'rewatch':
        display = _rewatch_display(parts)
    elif parts['reviews']:
        display = _review_display(parts)
    else:
        display = {'kind': 'film_group', 'films': _films(parts), 'stats': []}

    display['moment_type'] = kind
    for stat in display.get('stats', []):
        if stat.get('label') == stat['key']:
            stat['label'] = locale.stat_label(stat['key'])
    return display


def has_display(moment: dict) -> bool:
    display = moment['display']
    return bool(
        display.get('films') or display.get('film') or display.get('sessions') or
        display.get('examples') or display.get('reviews') or display.get('tag') or
        display.get('phrase') or display.get('name') or display.get('review') or
        display.get('stats')
    )


def make_moment(finding: dict, position: int, locale) -> dict:
    display = build_display(finding, locale)
    kind = display['moment_type']
    moment = {
        'beat_id': f'beat_{position:02}',
        'moment_id': f'moment_{position:02}',
        'position': position,
        'role': 'moment',
        'moment_type': kind,
        'finding_ids': [finding['id']],
        'origin': finding['origin'],
        'finding_type': finding['type'],
        'writer_mode': WRITER_MODES.get(kind, 'semantic_punch'),
        'max_lines': 2,
        'render_strategy': 'ai',
        'allow_silence': True,
        'display': display,
        'observation': finding['observation'],
        'evidence': finding['evidence'],
    }
    if not has_display(moment):
        moment['display_kind'] = 'empty'
    return moment


def supported_numbers(moment: dict) -> set[float]:
    text = json.dumps(moment['display'], ensure_ascii=False) + json.dumps(moment['evidence'], ensure_ascii=False)
    return {float(n.replace(',', '.')) for n in re.findall(r'(?<!\w)\d+(?:[.,]\d+)?', text)}
