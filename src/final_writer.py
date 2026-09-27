"""Final Writer contract: exact beat ids, structured effects, no invented numbers, no timing tokens."""
import json
import re

from .ai_schemas import FINAL_WRITER_SCHEMA
from .editorial import supported_numbers
from .validator import numeric_tokens, schema_errors

# Concepts that would turn a film theme into a claim about the person.
FORBIDDEN_CONCEPT = re.compile(
    r'\b(gay|lesbi|homossex|trans|travesti|bi\s?sexual|relig|deus|igreja|católic|evang|islam|jud|comunist|socialis|'
    r'polític|partido|eleitoral|depress|ansiedade|bipolar|esquiz|autis|psicopata|diagnóstic|terapia)\w*', re.I)
ARCHETYPE_CONCEPT_WORDS = 2
PROFILE_REACTION_WORDS = 14
TIMING_TOKEN = re.compile(r'\b\d+\s*(?:ms|mseg|milissegundos?|segundos?|s)\b', re.I)


def line_errors(line: dict, moment: dict, max_words: int) -> list[str]:
    text, effect = line.get('text', ''), line.get('effect', 'none')
    if not isinstance(text, str) or not text.strip():
        return ['empty line']
    if '\n' in text or '\r' in text:
        return ['multiline line']
    if effect not in {'none', 'strike', 'correction'}:
        return ['invalid effect']
    if len(text.split()) > max_words or len(text) > 300:
        return ['oversized line']
    if '~~' in text or re.match(r'^\s*[*_]{1,3}', text) or '**' in text:
        return ['raw markup in line']
    if TIMING_TOKEN.search(text):
        return ['timing token in line']
    if numeric_tokens(text) - supported_numbers(moment):
        return ['unsupported numeric token']
    return []


def display_texts(moment: dict) -> list[str]:
    display = moment.get('display') or {}
    texts = [display.get('phrase', ''), display.get('name', ''), display.get('description', '')]
    texts += [f.get('title', '') for f in display.get('films') or []]
    if isinstance(display.get('film'), dict):
        texts.append(display['film'].get('title', ''))
    if isinstance(display.get('review'), dict):
        texts.append(display['review'].get('text', ''))
    return [t for t in texts if t]


def validate_lines(lines, moment: dict, max_lines: int, max_words: int) -> tuple[list[dict], list[str]]:
    """Normalize to {text, effect}; a line that only repeats the screen is dropped, not a failure."""
    errors: list[str] = []
    if len(lines) > min(max_lines, moment.get('max_lines', max_lines)):
        errors.append('line count outside moment limits')
    shown = {text.casefold() for text in display_texts(moment) if text.strip()}
    kept = []
    for line in lines:
        problems = line_errors(line, moment, max_words)
        if problems:
            errors.extend(problems)
            continue
        if line['text'].strip().casefold() in shown:
            continue
        kept.append({'text': line['text'].strip(), 'effect': line.get('effect', 'none')})
    return kept, errors


def validate_archetype(concepts, locale) -> tuple[list[str], list[str]]:
    """Exactly four short, distinct, theme-level concepts; never a statement about the person."""
    if not isinstance(concepts, list) or len(concepts) != 4:
        return [], ['top_four_archetype must contain exactly four concepts']
    clean = []
    for concept in concepts:
        text = str(concept or '').strip()
        if not text or len(text.split()) > ARCHETYPE_CONCEPT_WORDS or numeric_tokens(text):
            return [], ['archetype concept must be one or two plain words']
        if FORBIDDEN_CONCEPT.search(text):
            return [], ['archetype concept describes the person instead of the film']
        clean.append(text)
    if len({text.casefold() for text in clean}) != 4:
        return [], ['archetype concepts must be distinct']
    return clean, []


def validate_opening(opening: dict, plan: dict, locale, overview: dict) -> tuple[dict, list[str]]:
    """Slots the Script Engine owns: the Writer may only pick inside the localized pools."""
    warnings, result = [], {}
    salutation = opening.get('salutation', '')
    if salutation in locale.salutations():
        result['salutation'] = salutation
    else:
        result['salutation'] = plan['salutation']
        warnings.append('salutation outside the localized pool; Script Engine choice kept')
    pair = next((p for p in locale.adjective_pairs()
                 if opening.get('negative_adjective') == p['negative']
                 and opening.get('positive_adjective') == p['positive']), None)
    if pair:
        result['adjective_pair'] = pair
    else:
        result['adjective_pair'] = plan['adjective_pair']
        warnings.append('adjective pair outside the localized pool; Script Engine choice kept')
    archetype, archetype_errors = validate_archetype(opening.get('top_four_archetype'), locale)
    result['archetype'] = archetype
    warnings.extend(archetype_errors)
    reaction, problems = validate_lines(opening.get('profile_reaction') or [],
                                        {'display': [], 'evidence': [], 'max_lines': 1}, 1, PROFILE_REACTION_WORDS)
    revealed = numeric_tokens(json.dumps(overview, ensure_ascii=False))
    for line in reaction:
        if numeric_tokens(line['text']) - revealed:
            problems.append('profile reaction quotes a number outside the reveal')
    result['profile_reaction'] = reaction if not problems else []
    if problems:
        warnings.append('profile reaction rejected: ' + '; '.join(sorted(set(problems))))
    return result, warnings


def validate_final_writer(raw: str, moments: list[dict], closer: dict | None, plan: dict, locale,
                          overview: dict, max_lines: int = 3,
                          max_words: int = 24) -> tuple[dict | None, list[str]]:
    """Strict contract: unknown or missing beat ids reject the response; slot issues fall back and warn."""
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return None, ['invalid JSON']
    errors = schema_errors(parsed, FINAL_WRITER_SCHEMA)
    if errors:
        return None, errors
    by_id = {moment['beat_id']: moment for moment in moments}
    closer_id = closer['beat_id'] if closer else None
    if closer_id:
        by_id.pop(closer_id, None)
    beats, seen, dropped = {}, set(), {}
    for item in parsed['beats']:
        beat_id = item['beat_id']
        if beat_id in seen:
            errors.append(f'duplicate beat_id: {beat_id}')
            continue
        seen.add(beat_id)
        moment = by_id.get(beat_id)
        if moment is None:
            errors.append(f'unexpected beat_id: {beat_id}')
            continue
        lines, problems = validate_lines(item['lines'], moment, max_lines, max_words)
        errors.extend(f'{beat_id}: {problem}' for problem in problems)
        beats[beat_id] = lines
        if len(lines) != len(item['lines']):
            dropped[beat_id] = len(item['lines']) - len(lines)
    errors.extend(f'missing beat_id: {beat_id}' for beat_id in by_id if beat_id not in seen)
    closer_lines, closer_problems = validate_lines(
        parsed['closer']['lines'], closer or {'display': [], 'evidence': [], 'max_lines': 0},
        max_lines if closer else 0, max_words)
    errors.extend(f'closer: {problem}' for problem in closer_problems)
    if closer_id:
        beats.pop(closer_id, None)
    opening, warnings = validate_opening(parsed['opening'], plan, locale, overview)
    if errors:
        return None, errors
    return {'opening': opening, 'beats': beats, 'closer': closer_lines if closer_id else [],
            'closer_beat_id': closer_id, 'dropped_lines': dropped, 'warnings': warnings}, []
