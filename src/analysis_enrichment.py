"""Cross-record analysis that needs diary/review relationships.

Kept separate from analyzer.py so matching semantics stay testable and explicit.
"""
from collections import defaultdict
from typing import Any

from .models import UserProfile


def match_reviews_to_diary(profile: UserProfile) -> tuple[dict[str, list[str]], list[str]]:
    """Greedily match review rows to diary sessions using only export fields."""
    by_film = defaultdict(list)
    for review in profile.reviews:
        by_film[review.film_key].append(review)

    used: set[str] = set()
    matches: dict[str, list[str]] = {}
    for entry in sorted(profile.diary, key=lambda e: (e.film_key, e.date, e.logged_date, e.id)):
        candidates = [r for r in by_film.get(entry.film_key, []) if r.id not in used]
        if entry.date:
            dated = [r for r in candidates if r.date == entry.date]
            if dated:
                candidates = dated
        same_rewatch = [r for r in candidates if r.rewatch == entry.rewatch]
        if same_rewatch:
            candidates = same_rewatch
        same_logged = [r for r in candidates if entry.logged_date and r.logged_date == entry.logged_date]
        if same_logged:
            candidates = same_logged
        if not candidates:
            continue
        candidates.sort(key=lambda r: (r.date != entry.date, r.logged_date != entry.logged_date, r.id))
        chosen = candidates[0]
        used.add(chosen.id)
        matches.setdefault(entry.id, []).append(chosen.id)

    unmatched = [review.id for review in profile.reviews if review.id not in used]
    return matches, unmatched


def review_coverage(profile: UserProfile, matches: dict[str, list[str]], unmatched: list[str]) -> dict[str, Any]:
    reviewed = [entry.id for entry in profile.diary if matches.get(entry.id)]
    missing = [entry.id for entry in profile.diary if not matches.get(entry.id)]
    total = len(profile.diary)
    return {
        'diary_sessions': total,
        'matched_sessions': len(reviewed),
        'matched_review_records': sum(len(ids) for ids in matches.values()),
        'sessions_without_review': len(missing),
        'reviewed_session_percent': 100 * len(reviewed) / total if total else None,
        'session_review_map': matches,
        'session_ids_without_review': missing,
        'unmatched_review_ids': unmatched,
        'matching_semantics': (
            'greedy film + watched date + rewatch flag; logged date breaks ties; '
            'unmatched reviews never create diary sessions'
        ),
    }


def enrich_rewatches(profile: UserProfile, rewatches: list[dict], matches: dict[str, list[str]]) -> list[dict]:
    """Attach current rating, per-session reviews/tags and stability metadata."""
    diary_by_id = {entry.id: entry for entry in profile.diary}
    for item in rewatches:
        entries = [entry for entry in profile.diary if entry.film_key == item['film_key']]
        entries.sort(key=lambda e: (e.date or '9999', e.logged_date, e.id))
        known = [entry.rating for entry in entries if entry.rating is not None]
        item['current_rating'] = profile.films[item['film_key']].rating
        item['all_known_ratings_same'] = len(known) >= 2 and len(set(known)) == 1
        item['rating_min'] = min(known) if known else None
        item['rating_max'] = max(known) if known else None
        item['rating_delta_first_last'] = known[-1] - known[0] if len(known) >= 2 else None
        item['session_details'] = [{
            'diary_id': entry.id,
            'date': entry.date,
            'logged_date': entry.logged_date,
            'rating': entry.rating,
            'rewatch': entry.rewatch,
            'tags': entry.tags,
            'review_ids': matches.get(entry.id, []),
        } for entry in entries]
        item['review_ids'] = [rid for entry in entries for rid in matches.get(entry.id, [])]
        item['tag_history'] = [entry.tags for entry in entries]
    return rewatches


def enrich_lists(profile: UserProfile, lists: list[dict], rewatches: list[dict]) -> list[dict]:
    repeat = {item['film_key']: item for item in rewatches}
    for item in lists:
        keys = [member['film_key'] for member in item.get('members', [])]
        details = []
        for key in dict.fromkeys(keys):
            film = profile.films.get(key)
            if not film:
                continue
            details.append({
                'film_key': key,
                'rating': film.rating,
                'favorite': film.favorite,
                'review_ids': film.review_ids,
                'rewatch': repeat.get(key),
                'tags': film.tags,
            })
        item['member_details'] = details
    return lists
