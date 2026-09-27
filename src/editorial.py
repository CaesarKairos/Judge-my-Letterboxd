"""Display-first Editorial Moments. A moment must be worth showing without any AI line."""
import json
import re
from typing import Any

from .utils import plain_text

EXCERPT_LIMIT = 180
EXAMPLE_LIMIT = 110
MAX_EXAMPLES = 3
MAX_DISPLAY_FILMS = 4

# Deterministic finding type -> moment type exposed by the frontend contract.
MOMENT_TYPES = {
    'rating_group': 'rating_contrast',
    'rewatch': 'rewatch',
    'tag_rating_difference': 'tag',
    'tag_overlap': 'tag',
    'review_very_long': 'review_spotlight',
    'review_very_short': 'review_spotlight',
    'review_low_rating_long': 'review_spotlight',
    'review_high_rating_short': 'review_spotlight',
    'multiple_reviews': 'review_spotlight',
    'writing_pattern': 'writing_pattern',
    'own_list': 'list',
    'liked_rating_difference': 'semantic',
}
WRITER_MODES = {'rating_contrast': 'contrast', 'review_spotlight': 'quote_reaction', 'rewatch': 'short_reaction',
                'tag': 'short_reaction', 'list': 'short_reaction', 'writing_pattern': 'short_reaction',
                'semantic': 'semantic_punch', 'odd_stat': 'raw_reveal'}


def short_excerpt(text: str, limit: int = EXCERPT_LIMIT) -> str:
    """A displayable fragment of user text: plain, bounded, ellipsized at a word boundary."""
    clean = ' '.join(plain_text(text or '').split())
    if len(clean) <= limit:
        return clean
    head = clean[:limit].rsplit(' ', 1)[0].rstrip(',;:.') or clean[:limit]
    return f'{head}…'


def _film_ref(data: dict) -> dict:
    return {'film_key': data['key'], 'title': data['name'], 'year': data.get('year', ''),
            'rating': data.get('current_rating')}


def collect_evidence(finding: dict) -> dict[str, Any]:
    """Split finding evidence into films, reviews and the deterministic finding payload."""
    films, reviews, payload = {}, {}, None
    for item in finding['evidence']:
        kind, data = item['source_type'], item['data']
        if kind == 'finding' and payload is None:
            payload = data
        elif kind in {'film', 'film_identity'} and data.get('key'):
            films.setdefault(data['key'], {'key': data['key'], 'name': data['name'], 'year': data.get('year', ''),
                                           'current_rating': data.get('current_rating')})
        elif kind == 'review':
            reviews.setdefault(data['id'], data)
    for key in finding.get('film_keys', []):
        films.setdefault(key, {'key': key, 'name': key, 'year': '', 'current_rating': None})
    return {'films': [films[k] for k in films], 'reviews': list(reviews.values()),
            'data': (payload or {}).get('evidence') or {}}


def _stat(key: str, value: Any, label: str | None = None) -> dict:
    return {'key': key, 'value': value, 'label': label or key}


def _films(parts: dict, rated_only: bool = False) -> list[dict]:
    chosen = [f for f in parts['films'] if f['current_rating'] is not None] if rated_only else parts['films']
    return [_film_ref(f) for f in chosen[:MAX_DISPLAY_FILMS]]


def _rating_display(finding: dict, parts: dict, locale) -> dict:
    data = parts['data']
    stats = [_stat('rating', data.get('rating'), locale.moment_label('rating_group')),
             _stat('count', data.get('count')), _stat('share', data.get('share'))]
    stats = [s for s in stats if s['value'] is not None]
    pair = _films(parts, rated_only=True)[:2]
    kind = 'rating_pair' if len(pair) == 2 else 'rating_group'
    return {'kind': kind, 'films': pair, 'stats': stats}


def _review_display(finding: dict, parts: dict, locale) -> dict:
    chosen = parts['reviews'][0] if parts['reviews'] else None
    if chosen is None:
        return {'kind': 'film_group', 'films': _films(parts), 'stats': []}
    film = next((f for f in parts['films'] if f['key'] == chosen.get('film_key')), None)
    return {'kind': 'review_quote', 'review': {
        'review_id': chosen['id'], 'film_key': chosen.get('film_key'),
        'title': film['name'] if film else chosen.get('film_key', ''),
        'year': film['year'] if film else '',
        'rating': chosen.get('review_rating'), 'text': short_excerpt(chosen.get('excerpt', ''))},
        'stats': []}


def _rewatch_display(finding: dict, parts: dict, locale) -> dict:
    data = parts['data']
    ratings, dates = data.get('ratings_over_time') or [], data.get('dates') or []
    sessions = [{'index': i + 1, 'rating': rating, 'date': dates[i] if i < len(dates) else ''}
                for i, rating in enumerate(ratings)]
    film = parts['films'][0] if parts['films'] else {'key': data.get('film_key', ''), 'name': data.get('film_key', ''),
                                                     'year': '', 'current_rating': None}
    return {'kind': 'rewatch_sessions', 'film': _film_ref(film), 'sessions': sessions,
            'stats': [_stat('sessions', data.get('sessions')), _stat('explicit_rewatches', data.get('explicit_rewatches'))]}


def _tag_display(finding: dict, parts: dict, locale) -> dict:
    data = parts['data']
    if finding['type'] == 'tag_overlap':
        return {'kind': 'tag_stats', 'tag': data.get('a', ''), 'related_tag': data.get('b', ''), 'films': _films(parts),
                'stats': [s for s in [_stat('films_a', data.get('size_a')), _stat('films_b', data.get('size_b')),
                                      _stat('shared_films', data.get('intersection')),
                                      _stat('jaccard', data.get('jaccard'))] if s['value'] is not None]}
    session = data.get('session_ratings') or {}
    return {'kind': 'tag_stats', 'tag': data.get('tag') or (finding['related_tags'] or [''])[0], 'films': _films(parts),
            'stats': [_stat('session_mean', session.get('mean')), _stat('rated_sessions', session.get('count')),
                      _stat('unique_films', data.get('unique_films')), _stat('delta', data.get('delta'))]}


def _list_display(finding: dict, parts: dict, locale) -> dict:
    data = parts['data']
    return {'kind': 'list_members', 'name': data.get('name', ''),
            'description': short_excerpt(data.get('description', ''), 160),
            'films': _films(parts), 'stats': [_stat('films', data.get('film_count'))]}


def _writing_display(finding: dict, parts: dict, locale) -> dict:
    data = parts['data']
    examples = [short_excerpt(r['excerpt'], EXAMPLE_LIMIT) for r in parts['reviews'][:MAX_EXAMPLES] if r.get('excerpt')]
    return {'kind': 'writing_pattern', 'phrase': data.get('phrase', ''), 'films': _films(parts),
            'examples': examples, 'stats': [_stat('reviews', data.get('count'))]}


def _semantic_display(finding: dict, parts: dict, locale) -> dict:
    if parts['reviews']:
        return _review_display(finding, parts, locale)
    return {'kind': 'film_group', 'films': _films(parts), 'stats': [_stat('reviews_count', finding['sample_size'])]}


def build_display(finding: dict, locale) -> dict:
    """Map one pool finding to the structured display the frontend can render alone."""
    parts = collect_evidence(finding)
    kind = MOMENT_TYPES.get(finding['type'], 'semantic' if finding['origin'] == 'semantic' else 'odd_stat')
    builder = {'rating_contrast': _rating_display, 'review_spotlight': _review_display, 'rewatch': _rewatch_display,
               'tag': _tag_display, 'list': _list_display, 'writing_pattern': _writing_display,
               'semantic': _semantic_display, 'odd_stat': _semantic_display}[kind]
    display = builder(finding, parts, locale)
    display['moment_type'] = kind
    for stat in display.get('stats', []):
        if stat.get('label') == stat['key']:
            stat['label'] = locale.stat_label(stat['key'])
    return display


def has_display(moment: dict) -> bool:
    """Display-first: a moment without any data on screen is not worth scheduling."""
    display = moment['display']
    return bool(display.get('films') or display.get('sessions') or display.get('examples') or display.get('tag')
                or display.get('phrase') or display.get('name') or display.get('review') or display.get('stats'))


def make_moment(finding: dict, position: int, locale) -> dict:
    """An Editorial Moment: what the frontend shows, plus the evidence the writer may use."""
    display = build_display(finding, locale)
    kind = display['moment_type']
    moment = {'beat_id': f'beat_{position:02}', 'moment_id': f'moment_{position:02}', 'position': position,
              'role': 'moment', 'moment_type': kind, 'finding_ids': [finding['id']], 'origin': finding['origin'],
              'finding_type': finding['type'], 'writer_mode': WRITER_MODES[kind], 'max_lines': 2,
              'render_strategy': 'ai', 'allow_silence': True, 'display': display,
              'observation': finding['observation'], 'evidence': finding['evidence']}
    if not has_display(moment):
        moment['display_kind'] = 'empty'
    return moment


def supported_numbers(moment: dict) -> set[float]:
    """Every digit the writer may repeat: display data plus the moment evidence."""
    text = json.dumps(moment['display'], ensure_ascii=False) + json.dumps(moment['evidence'], ensure_ascii=False)
    return {float(n.replace(',', '.')) for n in re.findall(r'(?<!\w)\d+(?:[.,]\d+)?', text)}
