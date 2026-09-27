"""Final Writer v2 contract.

Keeps strict beat/fact validation while leaving comedic timing to the Writer.
"""
import json

from .ai_schemas import FINAL_WRITER_SCHEMA
from .final_writer import line_errors, validate_opening
from .validator import schema_errors


def validate_lines(lines, moment: dict, max_lines: int, max_words: int) -> tuple[list[dict], list[str]]:
    errors: list[str] = []
    if len(lines) > min(max_lines, moment.get('max_lines', max_lines)):
        errors.append('line count outside moment limits')
    kept = []
    for line in lines:
        problems = line_errors(line, moment, max_words)
        if problems:
            errors.extend(problems)
            continue
        kept.append({'text': line['text'].strip(), 'effect': line.get('effect', 'none')})
    return kept, errors


def validate_final_writer(raw: str, moments: list[dict], closer: dict | None, plan: dict, locale,
                          overview: dict, max_lines: int = 4,
                          max_words: int = 14) -> tuple[dict | None, list[str]]:
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

    beats, seen = {}, set()
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

    errors.extend(f'missing beat_id: {beat_id}' for beat_id in by_id if beat_id not in seen)
    closer_lines, closer_problems = validate_lines(
        parsed['closer']['lines'],
        closer or {'display': [], 'evidence': [], 'max_lines': 0},
        max_lines if closer else 0,
        max_words,
    )
    errors.extend(f'closer: {problem}' for problem in closer_problems)

    opening, warnings = validate_opening(parsed['opening'], plan, locale, overview)
    if errors:
        return None, errors

    return {
        'opening': opening,
        'beats': beats,
        'closer': closer_lines if closer_id else [],
        'closer_beat_id': closer_id,
        'dropped_lines': {},
        'warnings': warnings,
    }, []
