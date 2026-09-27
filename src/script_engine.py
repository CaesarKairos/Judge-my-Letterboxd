"""Deterministic editorial selection of Editorial Moments; it never writes user-facing prose."""
from collections import Counter
import json
import re

from .editorial import make_moment

CATEGORY_FOR_TYPE = {
    'list_meaning': 'LIST_PATTERN', 'tag_meaning': 'TAG_PATTERN', 'recurring_idea': 'WRITING_PATTERN',
    'review_spotlight': 'REVIEW_SPOTLIGHT', 'semantic_contrast': 'RATING_CONTRAST',
    'rating_group': 'RATING_CONTRAST', 'writing_pattern': 'WRITING_PATTERN', 'rewatch': 'REWATCH',
    'tag_overlap': 'TAG_PATTERN', 'tag_rating_difference': 'TAG_PATTERN',
    'review_low_rating_long': 'REVIEW_SPOTLIGHT', 'review_high_rating_short': 'REVIEW_SPOTLIGHT',
    'review_very_long': 'REVIEW_SPOTLIGHT', 'review_very_short': 'REVIEW_SPOTLIGHT',
    'multiple_reviews': 'REVIEW_SPOTLIGHT', 'own_list': 'LIST_PATTERN',
    'liked_rating_difference': 'SEMANTIC_FINDING'}


def category(finding: dict) -> str:
    if finding['origin'] == 'semantic':
        return CATEGORY_FOR_TYPE.get(finding['type'], 'SEMANTIC_FINDING')
    return CATEGORY_FOR_TYPE.get(finding['type'], 'ODD_STAT')


def duplicate(a: dict, b: dict) -> bool:
    if a['id'] == b['id']:
        return True
    def sources(f: dict) -> set:
        return {(e['source_type'], e['source_id']) for e in f['evidence'] if e['source_type'] not in {'film', 'film_identity', 'finding'}}
    sa, sb = sources(a), sources(b)
    if sa and sb and len(sa & sb) / len(sa | sb) >= .65:
        return True
    fa, fb = set(a['film_keys']), set(b['film_keys'])
    if a['type'] == b['type'] and fa and fb and len(fa & fb) / len(fa | fb) >= .8:
        return True
    wa = set(re.findall(r'\w+', a['observation'].casefold()))
    wb = set(re.findall(r'\w+', b['observation'].casefold()))
    return bool(wa and wb and len(wa & wb) / len(wa | wb) >= .8)


def build_script(pool: list[dict], max_beats: int = 10, max_evidence_chars: int = 10000, locale=None) -> dict:
    """Select moments before a single word is written: quality, diversity and evidence budget first."""
    if not 1 <= max_beats <= 12:
        raise ValueError('SCRIPT_MAX_BEATS deve estar entre 1 e 12.')
    candidates, excluded, selected, reasons = [], [], [], []
    for item in pool:
        base = item['score'] * item['confidence']
        if base < 35 or item['confidence'] < .6:
            excluded.append({'id': item['id'], 'reason': 'below quality threshold'})
        elif len(json.dumps(item['evidence'], ensure_ascii=False)) > max_evidence_chars:
            excluded.append({'id': item['id'], 'reason': 'evidence exceeds per-beat budget; not truncated'})
        elif any(duplicate(item, other) for other in candidates):
            excluded.append({'id': item['id'], 'reason': 'duplicate candidate'})
        else:
            candidates.append(item)
    closers = [f for f in candidates if f['origin'] == 'semantic' and f['score'] * f['confidence'] >= 65]
    closer = max(closers, key=lambda f: f['score'] * f['confidence'], default=None) if max_beats >= 3 else None
    if closer:
        candidates.remove(closer)
    types, films, tags = Counter(), Counter(), Counter()
    target = max_beats - (1 if closer else 0)
    while candidates and len(selected) < target:
        ranked = []
        for item in candidates:
            kind = category(item)
            if types[kind] >= 2 or any(duplicate(item, old) for old in selected):
                continue
            film_repeat = sum(films[k] for k in item['film_keys']) / max(1, len(item['film_keys']))
            penalty = 18 * types[kind] + 12 * film_repeat + 15 * sum(tags[t] for t in item['related_tags'])
            if selected and category(selected[-1]) == kind:
                penalty += 20
            if closer and duplicate(item, closer):
                continue
            score = item['score'] * item['confidence'] - penalty
            ranked.append((score, item, penalty))
        if not ranked:
            break
        score, item, penalty = max(ranked, key=lambda x: (x[0], x[1]['id']))
        if score < 25:
            break
        kind = category(item)
        reasons.append({'id': item['id'], 'category': kind, 'adjusted_score': score,
                        'base_score': item['score'] * item['confidence'], 'diversity_penalty': penalty,
                        'reason': 'Highest remaining evidence-backed score after type/film/tag penalties.'})
        selected.append(item)
        candidates.remove(item)
        types[kind] += 1
        films.update(item['film_keys'])
        tags.update(item['related_tags'])
    if closer and not any(duplicate(closer, old) for old in selected):
        reasons.append({'id': closer['id'], 'category': 'CLOSER', 'diversity_penalty': 0,
                        'adjusted_score': closer['score'] * closer['confidence'],
                        'base_score': closer['score'] * closer['confidence'],
                        'reason': 'Strongest unused semantic candidate reserved for the ending.'})
        selected.append(closer)
    moments = [make_moment(item, position, locale) for position, item in enumerate(selected, 1)]
    if closer and moments and moments[-1]['finding_ids'] == [closer['id']]:
        moments[-1]['role'] = 'closer'
    return {'target_max_beats': max_beats, 'moments': moments, 'selection': reasons, 'excluded': excluded,
            'policy': 'Quality before count; max two per category; display-first; no inferred callbacks.'}


def moment_payload(moment: dict, max_lines: int, max_words: int) -> dict:
    return {'beat_id': moment['beat_id'], 'moment_type': moment['moment_type'], 'writer_mode': moment['writer_mode'],
            'max_lines': min(max_lines, moment['max_lines']), 'allow_silence': moment['allow_silence'],
            'what_the_user_sees': moment['display'], 'editorial_candidate': moment['observation'],
            'evidence': moment['evidence'],
            'limits': {'max_lines': min(max_lines, moment['max_lines']), 'hard_max_words_per_line': max_words}}


def final_writer_input(moments: list[dict], closer: dict | None, plan: dict, locale, top_four: list[dict],
                       max_lines: int = 3, max_words: int = 24) -> dict:
    """The whole script in one request: the Writer sees the sequence, the data and the allowed slots."""
    return {'task': 'Write the Judge voice for a fixed script. You never change the script.',
            'language': locale.locale,
            'top_four_films': top_four,
            'opening_slots': {
                'salutation_allowed': locale.salutations(),
                'adjective_pairs_allowed': locale.adjective_pairs(),
                'archetype': {'count': 4, 'output': 'exactly four concepts, hyphen-joined by the frontend',
                              'source': 'the four favorite films listed above',
                              'about': 'themes, genres, atmospheres, settings, narrative elements of those films',
                              'concept_rules': ['one word when possible', 'at most two words',
                                                'natural Portuguese', 'semantically distinct from the other three',
                                                'no numbers, no diagnoses, no sensitive attributes'],
                              'forbidden': ['claims about the person', 'orientation', 'religion', 'politics',
                                            'health', 'clinical personality', 'personality diagnosis']},
                'profile_reaction': {'max_lines': 1, 'max_words': 14, 'optional': True,
                                     'note': 'the numbers are already on screen'}},
            'moments': [moment_payload(m, max_lines, max_words) for m in moments],
            'closer': moment_payload(closer, max_lines, max_words) if closer else None,
            'writer_rules': {
                'timing': 'The interface owns pauses, posters, strikes, corrections and anticipation. '
                          'Write simpler text, not more theatrical text.',
                'effects': 'Set effect=strike on a word you are crossing out and effect=correction on the '
                           'replacement right after it. Never write Markdown.',
                'timing_tokens': 'Never write milliseconds, durations or animation instructions.',
                'structure': 'Do not add, remove or reorder moments. Do not invent films, numbers, causes or context.',
                'silence': 'An empty lines array is valid when the data already says everything.'},
            'limits': {'max_lines': max_lines, 'hard_max_words_per_line': max_words,
                       'moments': len(moments), 'closer': bool(closer)}}
