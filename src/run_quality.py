"""Run quality thresholds."""


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


def writer_quality(result: dict | None, served_model: str | None) -> dict:
    beat_lines = list((result or {}).get('beats', {}).values())
    closer = (result or {}).get('closer') or []
    return {
        'served_model': served_model,
        'quality_degraded': 'lite' in (served_model or '').casefold(),
        'reaction_lines': sum(len(lines) for lines in beat_lines) + len(closer),
        'silent_moments': sum(not lines for lines in beat_lines) + (1 if result and not closer else 0),
    }
