"""Editorial v2 enrichment layered over the stable display builder."""
from .editorial import make_moment as _base_make_moment


def _stat(key, value, label=None):
    return {'key': key, 'value': value, 'label': label or key}


def _review_style_display(finding: dict, moment: dict) -> None:
    style = next((e['data'] for e in finding.get('evidence', []) if e['source_type'] == 'review_style'), None)
    if not style:
        return
    phrase = style.get('phrase', '')
    if not phrase:
        return
    examples = []
    for evidence in finding.get('evidence', []):
        if evidence['source_type'] != 'review':
            continue
        data = evidence['data']
        excerpt = data.get('excerpt') or data.get('full_text') or ''
        if excerpt:
            examples.append(excerpt[:180])
    stats = []
    if style.get('count') is not None:
        stats.append(_stat('reviews', style['count']))
    if style.get('share') is not None:
        stats.append(_stat('share', style['share']))
    if style.get('markup'):
        stats.append(_stat('markup', style['markup']))
    moment['moment_type'] = 'writing_pattern'
    moment['writer_mode'] = 'short_reaction'
    moment['display'] = {
        'kind': 'writing_pattern',
        'moment_type': 'writing_pattern',
        'phrase': phrase,
        'examples': examples[:3],
        'stats': stats,
        'films': moment['display'].get('films', []),
    }


def _rewatch_display(finding: dict, moment: dict) -> None:
    data = next((e['data'] for e in finding.get('evidence', []) if e['source_type'] == 'rewatch'), None)
    if not data:
        return
    films = moment['display'].get('films') or []
    film = films[0] if films else {
        'film_key': data.get('film_key', ''),
        'title': data.get('film_key', ''),
        'year': '',
        'rating': data.get('current_rating'),
    }
    sessions = data.get('session_details') or [
        {'index': i + 1, 'rating': rating, 'date': (data.get('dates') or [''])[i]}
        for i, rating in enumerate(data.get('ratings_over_time') or [])
    ]
    for index, session in enumerate(sessions):
        session.setdefault('index', index + 1)
    moment['moment_type'] = 'rewatch'
    moment['writer_mode'] = 'short_reaction'
    moment['display'] = {
        'kind': 'rewatch_sessions',
        'moment_type': 'rewatch',
        'film': film,
        'sessions': sessions,
        'stats': [
            _stat('sessions', data.get('sessions')),
            _stat('explicit_rewatches', data.get('explicit_rewatches')),
        ],
    }


def make_moment(finding: dict, position: int, locale) -> dict:
    moment = _base_make_moment(finding, position, locale)
    moment['max_lines'] = 4
    moment['why_interesting'] = finding.get('why_interesting', '')
    moment['cultural_angle'] = finding.get('cultural_angle', '')

    if finding.get('type') == 'recurring_idea':
        _review_style_display(finding, moment)
    elif finding.get('type') == 'rewatch_pattern':
        _rewatch_display(finding, moment)

    return moment
