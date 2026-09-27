"""The standard opening: fixed template, controlled variation, AI only fills the archetype slot."""
import re

from .presentation import correction, message, pause, profile_stats_event, strike, typing

ARCHETYPE_COUNT = 4
REVEAL_MAX = 5
PROFILE_STATS = (('watched_films', 'watched_films'), ('reviews', 'reviews'), ('diary_entries', 'diary_entries'),
                 ('rated_films', 'rated_films'), ('explicit_rewatches', 'rewatches'), ('watchlist', 'watchlist'),
                 ('own_lists', 'own_lists'))
# Recognisable skeleton, small controlled variation: the account keeps a stable identity.
RHYTHMS = ({'greeting': 'short', 'before_archetype': 'medium', 'archetype_pause': 'short', 'taste_pause': 'short',
            'before_reveal': 'medium'},
           {'greeting': 'medium', 'before_archetype': 'long', 'archetype_pause': 'medium', 'taste_pause': 'short',
            'before_reveal': 'medium'})


def account_seed(profile) -> str:
    """Stable per account; falls back to film identity, never to personal data."""
    return profile.handle or profile.display_name or f'{len(profile.films)}:' + '|'.join(sorted(profile.films)[:3])


def safe_opening_name(profile) -> str:
    """Prefer the public handle; never project contact or profile fields into the joke."""
    for candidate in (profile.handle, profile.display_name):
        clean = ' '.join((candidate or '').split())
        if (clean and len(clean) <= 60 and '@' not in clean and '://' not in clean
                and not re.search(r'\bwww\.|\b\S+\.(?:com|net|org|br)(?:/|$)', clean, re.I)
                and not re.search(r'[\x00-\x1f\x7f<>]', clean)):
            return clean
    return ''


def reveal_stats(overview: dict, locale) -> list[dict]:
    """Three to five real numbers, no spreadsheet: the reveal is the data, not the comment."""
    stats = [{'key': key, 'value': overview.get(key), 'label': locale.stat_label(label)}
             for key, label in PROFILE_STATS if overview.get(key)]
    return stats[:REVEAL_MAX]


def build_plan(profile, overview: dict, locale) -> dict:
    """Backend-owned slots. The AI may only pick inside the localized pools."""
    index = locale.stable_index(account_seed(profile))
    salutations, pairs = locale.salutations(), locale.adjective_pairs()
    if not pairs:
        raise KeyError(f'pool ausente no locale {locale.locale}: taste_adjective_pairs')
    return {'template': 'opening_v1', 'salutation': salutations[index % len(salutations)],
            'adjective_pair': pairs[(index // max(1, len(salutations))) % len(pairs)],
            'name': safe_opening_name(profile), 'handle': profile.handle,
            'stats': reveal_stats(overview, locale), 'rhythm': RHYTHMS[index % len(RHYTHMS)],
            'archetype': [], 'archetype_text': '', 'archetype_requested': False,
            'top_four_archetype': {'requested': False, 'concepts': [], 'phrase': '',
                                   'valid': False, 'repaired': False, 'fallback_used': False, 'issues': []},
            'profile_reaction': [], 'opening_events': []}


def build_events(plan: dict, archetype: str | None, profile_reaction: list[dict], locale) -> list[dict]:
    """The whole opening as events: typing, pause, strike, correction and the stats reveal."""
    rhythm, pair = plan['rhythm'], plan['adjective_pair']
    events = [typing(rhythm['greeting']), message(plan['salutation'])]
    if archetype or plan.get('archetype_requested'):
        events.extend([typing(rhythm['before_archetype']), message(locale.phrase('opening.intro_before_archetype'))])
        events[-1]['cue'] = 'top_four_reveal'
        if archetype:
            events.extend([message(archetype), pause(rhythm['archetype_pause']),
                           message(locale.phrase('opening.archetype_question')), pause(rhythm['archetype_pause']),
                           message(locale.phrase('opening.archetype_too_long'))])
            events[-5]['role'] = 'archetype_phrase'
        else:
            events.extend([pause(rhythm['archetype_pause']), message(locale.phrase('opening.archetype_empty')),
                           pause(rhythm['archetype_pause']), message(locale.phrase('opening.archetype_give_up'))])
        events.extend([
                       message(locale.phrase('opening.fallback_name', name=plan['name']) if plan['name']
                                else locale.phrase('opening.fallback_name_missing'))])
    elif plan.get('top_four'):
        events[-1]['cue'] = 'top_four_reveal'
    events.extend([typing('short'), message(locale.phrase('opening.taste_prefix')), strike(pair['negative']),
                   pause(rhythm['taste_pause']), correction(pair['negative'], pair['positive']),
                   message(f" {locale.phrase('opening.taste_suffix')}"),
                   message(locale.phrase('opening.serious')), message(locale.phrase('opening.judge_line')),
                   typing(rhythm['before_reveal']), message(locale.phrase('opening.look')),
                   typing('medium'), message(locale.phrase('opening.reveal_dots')),
                   profile_stats_event(plan['stats'])])
    if profile_reaction:
        events.extend([typing('short')] + [message(line['text']) for line in profile_reaction])
    return events
