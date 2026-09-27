"""Run quality thresholds."""
import re

from .final_writer import absolute_language_flags, display_texts


def restatement_audit(result: dict | None, moments: list[dict]) -> list[dict]:
    """Flag near captions for review without rejecting legitimate interpretations."""
    output = []
    lines_by_id = (result or {}).get('beats', {})
    for moment in moments:
        for line in lines_by_id.get(moment['beat_id'], []):
            words = set(re.findall(r'\w+', line['text'].casefold()))
            if len(words) < 3:
                continue
            for shown in display_texts(moment):
                display_words = set(re.findall(r'\w+', shown.casefold()))
                if len(words & display_words) / len(words) >= .8 and not re.search(
                        r'\b(mas|porém|enquanto|apesar|comparad[oa]|porque|então|já)\b', line['text'], re.I):
                    output.append({'beat_id': moment['beat_id'], 'line': line['text'], 'display': shown[:160]})
                    break
    return output


def callback_count(result: dict | None) -> int:
    """Conservative textual indicator; editorial callbacks still need human review."""
    seen = set()
    found = 0
    lines = [line['text'] for beat in (result or {}).get('beats', {}).values() for line in beat]
    lines += [line['text'] for line in (result or {}).get('closer', [])]
    for line in lines:
        words = re.findall(r'\w+', line.casefold())
        phrases = {' '.join(words[i:i + 3]) for i in range(len(words) - 2)}
        if phrases & seen:
            found += 1
        seen.update(phrases)
    return found


def required_semantic_moments(analysis: dict) -> int:
    overview = analysis.get('overview', {})
    reviews = overview.get('reviews', 0) or 0
    ratings = overview.get('rated_films', 0) or 0
    if reviews >= 20 or ratings >= 50:
        return 6
    if reviews >= 5 or ratings >= 20:
        return 4
    return 2


def analyst_quality(analysis: dict, accepted: list[dict], rejected: list[dict]) -> dict:
    required = required_semantic_moments(analysis)
    counts = {}
    for item in rejected:
        for reason in item.get('errors', []):
            counts[reason] = counts.get(reason, 0) + 1
    return {
        'returned_candidates': len(accepted) + len(rejected),
        'accepted_candidates': len(accepted),
        'rejected_candidates': len(rejected),
        'required_semantic_candidates': required,
        'passes': len(accepted) >= required,
        'top_rejection_reasons': sorted(
            ({'reason': key, 'count': value} for key, value in counts.items()),
            key=lambda row: (-row['count'], row['reason'])
        )[:8],
    }


def writer_quality(result: dict | None, served_model: str | None, moments: list[dict] | None = None) -> dict:
    beat_lines = list((result or {}).get('beats', {}).values())
    closer = (result or {}).get('closer') or []
    restated = restatement_audit(result, moments or [])
    absolute_flags = [
        {'beat_id': moment['beat_id'], 'line': line['text']}
        for moment in moments or [] for line in (result or {}).get('beats', {}).get(moment['beat_id'], [])
        if absolute_language_flags(line['text'], moment)
    ]
    return {
        'served_model': served_model,
        'quality_degraded': 'lite' in (served_model or '').casefold(),
        'reaction_lines': sum(len(lines) for lines in beat_lines) + len(closer),
        'silent_moments': sum(not lines for lines in beat_lines) + (1 if result and not closer else 0),
        'possible_restatements': len(restated),
        'possible_restated_lines': restated,
        'absolute_language_flags': absolute_flags,
        'callbacks_detected': callback_count(result),
    }
