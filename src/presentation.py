"""Presentation builder: the Script Engine decides content, this module decides how it is shown."""
import re
from html.parser import HTMLParser


class ReviewSegments(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.segments = []
        self.stack = []

    def handle_starttag(self, tag, attrs):
        if tag in {'blockquote', 'strong', 'em'}:
            self.stack.append(tag)
        elif tag in {'br', 'p'} and self.segments:
            self.handle_data('\n')

    def handle_endtag(self, tag):
        if tag in self.stack:
            self.stack = self.stack[:len(self.stack) - 1 - self.stack[::-1].index(tag)]

    def handle_data(self, data):
        if data:
            kind = self.stack[-1] if self.stack else 'text'
            if self.segments and self.segments[-1]['type'] == kind:
                self.segments[-1]['text'] += data
            else:
                self.segments.append({'type': kind, 'text': data})


def clean_review(text: str) -> tuple[str, list[dict]]:
    parser = ReviewSegments()
    parser.feed(text or '')
    parser.close()
    segments = [{'type': row['type'], 'text': row['text'].strip()}
                for row in parser.segments if row['text'].strip()]
    return '\n'.join(row['text'] for row in segments), segments


def review_event(review: dict) -> dict:
    plain, segments = clean_review(review.get('text', ''))
    return {**review, 'text': plain, 'segments': segments}

# Contract vocabulary for the future frontend. Durations are enums, never milliseconds.
EVENT_TYPES = ('typing', 'pause', 'message', 'correction', 'strike', 'profile_stats', 'film', 'film_pair',
               'film_group', 'review_quote', 'tag', 'list', 'rating', 'rewatch', 'phrase', 'stat')
DURATIONS = ('instant', 'short', 'medium', 'long')
SEGMENT_EFFECTS = ('none', 'strike', 'correction')
TIMING_TOKENS = re.compile(r'\b\d+\s*(?:ms|mseg|milissegundos?|segundos?|s)\b', re.I)
RAW_MARKUP = re.compile(r'~~|\*\*|^\s*[*_]{1,3}')
MAX_EXAMPLE_QUOTES = 2
PERCENT_KEYS = {'share', 'jaccard', 'percent_a_in_b', 'percent_b_in_a', 'delta'}


def message(text: str, effect: str = 'none') -> dict:
    """One message; effects are semantic fields, never Markdown in the text."""
    return {'type': 'message', 'segments': [{'text': text, 'effect': effect}]}


def typing(duration: str = 'short') -> dict:
    return {'type': 'typing', 'duration': duration}


def pause(duration: str = 'short') -> dict:
    return {'type': 'pause', 'duration': duration}

def profile_stats_event(stats: list[dict]) -> dict:
    return {'type': 'profile_stats', 'stats': [s for s in stats if s.get('value') is not None]}


def strike(text: str) -> dict:
    return {'type': 'strike', 'text': text}


def correction(original: str, replacement: str) -> dict:
    return {'type': 'correction', 'original': original, 'replacement': replacement}


def stat_event(stats: list[dict], caption: str = '') -> dict:
    return {'type': 'stat', 'caption': caption, 'stats': [s for s in stats if s.get('value') is not None]}


def fmt_value(key: str, value) -> str:
    if value is None:
        return '?'
    if key in PERCENT_KEYS and isinstance(value, (int, float)):
        return f'{value * 100:.1f}%' if key != 'delta' else f'{value:+.2f}'
    if isinstance(value, float):
        return f'{round(value, 2):g}'
    return str(value)


def fmt_stats(stats: list[dict]) -> str:
    return ' · '.join(f"{s['label']}: {fmt_value(s['key'], s.get('value'))}" for s in stats if s.get('value') is not None)


def line_events(lines: list[dict]) -> list[dict]:
    """Convert validated writer lines into events; strike then correction becomes a real pair."""
    events, struck = [], ''
    for line in lines:
        text, effect = line['text'], line.get('effect', 'none')
        if effect == 'strike' and text.strip():
            events.append(strike(text))
            struck = text
        elif effect == 'correction' and text.strip():
            events.extend([pause('short'), correction(struck, text)] if struck else [message(text)])
            struck = ''
        else:
            events.append(message(text))
    return events


def film_event(film: dict) -> dict:
    return {'type': 'film', 'film': dict(film)}


def _quote(review: dict) -> dict:
    return review_event({'type': 'review_quote', 'review_id': review.get('review_id'), 'film_key': review.get('film_key'),
            'title': review.get('title', ''), 'year': review.get('year', ''), 'rating': review.get('rating'),
            'text': review.get('text', '')})


def _with_film_titles(review: dict, films: list[dict]) -> dict:
    film = next((f for f in films if f['film_key'] == review.get('film_key')), None)
    return {**review, 'title': review.get('title') or (film['title'] if film else ''),
            'year': review.get('year') or (film['year'] if film else '')}


def display_events(moment: dict) -> list[dict]:
    """Data-first: everything the frontend shows for this moment, before any reaction."""
    display, kind = moment['display'], moment['display'].get('kind')
    films = display.get('films') or []
    if kind == 'rating_pair':
        return [{'type': 'film_pair', 'films': [dict(f) for f in films[:2]]}, stat_event(display.get('stats', []))]
    if kind == 'rating_group':
        rated = [f for f in films if f.get('rating') is not None]
        return [{'type': 'film_group', 'films': [dict(f) for f in rated[:3]]},
                stat_event(display.get('stats', []))]
    if kind == 'review_quote':
        return [film_event(films[0]) if films else None, _quote(_with_film_titles(display['review'], films))]
    if kind == 'rewatch_sessions':
        return [film_event(display['film']), {'type': 'rewatch', 'film': dict(display['film']),
                                              'sessions': display.get('sessions', []),
                                              'stats': [s for s in display.get('stats', []) if s.get('value') is not None]}]
    if kind == 'tag_stats':
        return [{'type': 'tag', 'tag': display.get('tag', ''), 'related_tag': display.get('related_tag', ''),
                 'films': [dict(f) for f in films], 'stats': [s for s in display.get('stats', []) if s.get('value') is not None]}]
    if kind == 'list_members':
        return [{'type': 'list', 'name': display.get('name', ''), 'description': display.get('description', ''),
                 'films': [dict(f) for f in films], 'stats': [s for s in display.get('stats', []) if s.get('value') is not None]}]
    if kind == 'writing_pattern':
        events = [{'type': 'phrase', 'phrase': display.get('phrase', ''),
                   'stats': [s for s in display.get('stats', []) if s.get('value') is not None]}]
        for example in display.get('examples', [])[:MAX_EXAMPLE_QUOTES]:
            events.append(review_event({'type': 'review_quote', 'film_key': None, 'title': '', 'year': '', 'rating': None,
                           'text': example, 'review_id': None}))
        return events
    if kind == 'review_group':
        by_key = {f['film_key']: f for f in films}
        events = []
        for review in display.get('reviews', [])[:MAX_EXAMPLE_QUOTES]:
            film = by_key.get(review.get('film_key'))
            events.append(review_event({'type': 'review_quote', 'film_key': review.get('film_key'),
                           'title': film.get('title', '') if film else '',
                           'year': film.get('year', '') if film else '',
                           'rating': review.get('rating'), 'text': review.get('text', ''),
                           'review_id': review.get('review_id')}))
        return events
    if films:
        return [{'type': 'film_group', 'films': [dict(f) for f in films[:3]]},
                stat_event(display.get('stats', [])) if display.get('stats') else None]
    return [stat_event(display.get('stats', []))] if display.get('stats') else []


def moment_block(entry: dict) -> list[dict]:
    """Data first, then the reaction. Silence is a valid script decision, not a failure."""
    moment, lines = entry['moment'], entry.get('lines') or []
    events = [event for event in display_events(moment) if event]
    return events + ([pause('short')] if not lines else [typing('short')] + line_events(lines))


def build_presentation(plan: dict, entries: list[dict], closer: dict | None, render: dict, ai: dict, locale) -> dict:
    events, beats = list(plan['opening_events']), []
    for entry in entries + ([closer] if closer else []):
        moment, block = entry['moment'], moment_block(entry)
        events.extend(block)
        beats.append({'beat_id': moment['beat_id'], 'moment_id': moment['beat_id'],
                      'moment_type': moment['moment_type'], 'origin': moment['origin'],
                      'finding_ids': moment['finding_ids'], 'render_strategy': entry['render_strategy'],
                      'source': entry['source'], 'writer_mode': moment['writer_mode'],
                      'status': entry['status'], 'lines': entry.get('lines') or [], 'event_count': len(block)})
    return {'version': 'presentation-v1', 'template': plan['template'], 'locale': locale.locale,
            'profile': {'name': plan['name'], 'handle': plan['handle'], 'display_name': plan['name']},
            'stats': plan['stats'], 'opening': {'salutation': plan['salutation'],
                                               'adjective_pair': plan['adjective_pair'],
                                               'archetype': plan.get('archetype') or [],
                                               'archetype_text': plan.get('archetype_text', ''),
                                               'top_four_archetype': plan.get('top_four_archetype', {}),
                                               'profile_reaction': plan.get('profile_reaction') or []},
            'render': render, 'ai': ai, 'beats': beats, 'events': events}


def event_errors(events: list[dict]) -> list[str]:
    """Contract checks: known types, enum durations, structured effects, no raw markup or timing numbers."""
    errors = []
    for index, event in enumerate(events):
        kind = event.get('type')
        if kind not in EVENT_TYPES:
            errors.append(f'eventos[{index}]: tipo desconhecido {kind!r}')
            continue
        if kind in {'typing', 'pause'} and event.get('duration') not in DURATIONS:
            errors.append(f'eventos[{index}]: duração fora do enum')
        if kind == 'message':
            for segment in event.get('segments', []):
                if not segment.get('text', '').strip():
                    errors.append(f'eventos[{index}]: segmento vazio')
                if segment.get('effect') not in SEGMENT_EFFECTS:
                    errors.append(f'eventos[{index}]: efeito de segmento inválido')
        if kind == 'correction' and not (event.get('original') or '').strip():
            errors.append(f'eventos[{index}]: correção sem original')
        if kind in {'film', 'film_pair', 'film_group'} and not _film_keys(event):
            errors.append(f'eventos[{index}]: evento de filme sem film_key')
        for text in _texts(event):
            if RAW_MARKUP.search(text) or TIMING_TOKENS.search(text):
                errors.append(f'eventos[{index}]: markup ou tempo cru no texto')
    return errors


def _film_keys(event: dict) -> list[str]:
    films = event.get('films') or ([event['film']] if isinstance(event.get('film'), dict) else [])
    if event.get('film_key'):
        films = films + [{'film_key': event['film_key']}]
    return [f.get('film_key') for f in films if isinstance(f, dict) and f.get('film_key')]


def _texts(event: dict) -> list[str]:
    kind = event['type']
    if kind == 'message':
        return [s.get('text', '') for s in event.get('segments', [])]
    if kind in {'strike', 'correction', 'review_quote', 'phrase'}:
        return [str(event.get('text') or event.get('original') or ''), str(event.get('replacement') or ''),
                str(event.get('phrase') or '')]
    return []


def validate_presentation(script: dict) -> list[str]:
    errors = event_errors(script.get('events', []))
    seen: set[str] = set()
    for beat in script.get('beats', []):
        if beat['beat_id'] in seen:
            errors.append(f"beat repetido: {beat['beat_id']}")
        seen.add(beat['beat_id'])
    if script.get('render', {}).get('ai_generation') == 'complete' and not any(
            event['type'] == 'message' for event in script.get('events', [])):
        errors.append('execução marcada como completa sem nenhuma mensagem')
    return errors


def event_text(event: dict) -> str:
    """Readable terminal projection of one event; the frontend gets the structured version."""
    kind = event['type']
    if kind == 'message':
        return ''.join(segment['text'] for segment in event['segments'])
    if kind == 'typing':
        return f'{"." * 3} ({event["duration"]})'
    if kind == 'pause':
        return ''
    if kind == 'strike':
        return f'~~{event["text"]}~~'
    if kind == 'correction':
        return f'*{event["replacement"]}'.strip()
    if kind == 'profile_stats':
        return fmt_stats(event['stats'])
    if kind == 'stat':
        return fmt_stats(event.get('stats', []))
    if kind == 'film':
        return _film_text(event['film'])
    if kind == 'film_pair':
        return '  |  '.join(_film_text(f) for f in event['films'])
    if kind == 'film_group':
        return '  |  '.join(_film_text(f) for f in event['films'])
    if kind == 'rating':
        return f"{event['title']} ({event['year']}): {fmt_value('rating', event.get('rating'))}"
    if kind == 'review_quote':
        where = f" — {event['title']} ({event['year']})" if event.get('title') else ''
        note = f", {fmt_value('rating', event['rating'])}" if event.get('rating') is not None else ''
        rows = event.get('segments') or [{'type': 'text', 'text': event['text']}]
        formatted = '\n'.join(('> ' if row['type'] == 'blockquote' else '') + row['text'] for row in rows)
        return f'"{formatted}"{where}{note}'
    if kind == 'tag':
        related = f' + {event["related_tag"]}' if event.get('related_tag') else ''
        return f'{event["tag"]}{related}: {fmt_stats(event.get("stats", []))}'.rstrip(': ')
    if kind == 'list':
        description = f' — {event["description"]}' if event.get('description') else ''
        members = ', '.join(f['title'] for f in event.get('films', [])[:3])
        return f'{event["name"]}{description} [{members}] {fmt_stats(event.get("stats", []))}'.strip()
    if kind == 'rewatch':
        steps = ' → '.join(f"{fmt_value('rating', s.get('rating'))}" for s in event.get('sessions', []))
        return f"{event['film']['title']} ({event['film']['year']}): {steps}"
    if kind == 'phrase':
        return f'"{event["phrase"]}" {fmt_stats(event.get("stats", []))}'.strip()
    return ''


def _film_text(film: dict) -> str:
    year = f' ({film["year"]})' if film.get('year') else ''
    rating = f' ★{fmt_value("rating", film["rating"])}' if film.get('rating') is not None else ''
    return f'{film.get("title", "")}{year}{rating}'


def script_text(script: dict) -> str:
    """Terminal projection: readable as an experience, without inventing HTML."""
    blocks: list[str] = []
    for event in script.get('events', []):
        text = event_text(event).strip()
        if text and (not blocks or blocks[-1] != text):
            blocks.append(text)
    return '\n\n'.join(blocks) + '\n'
