"""Deterministic editorial selection, not generated choreography."""
from collections import Counter
import json
import re


def category(finding: dict) -> str:
    if finding['origin'] == 'semantic':
        return {'list_meaning': 'LIST_PATTERN', 'tag_meaning': 'TAG_PATTERN',
                'recurring_idea': 'WRITING_PATTERN', 'review_spotlight': 'REVIEW_SPOTLIGHT',
                'semantic_contrast': 'RATING_CONTRAST'}.get(finding['type'], 'SEMANTIC_FINDING')
    return {'rating_group': 'RATING_CONTRAST', 'writing_pattern': 'WRITING_PATTERN',
            'rewatch': 'REWATCH', 'tag_overlap': 'TAG_PATTERN', 'tag_rating_difference': 'TAG_PATTERN',
            'review_low_rating_long': 'REVIEW_SPOTLIGHT', 'review_high_rating_short': 'REVIEW_SPOTLIGHT',
            'review_very_long': 'REVIEW_SPOTLIGHT', 'review_very_short': 'REVIEW_SPOTLIGHT',
            'multiple_reviews': 'REVIEW_SPOTLIGHT'}.get(finding['type'], 'ODD_STAT')


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


def make_beat(finding: dict, beat_type: str, reason: dict) -> dict:
    mode = {'RATING_CONTRAST': 'contrast', 'SEMANTIC_FINDING': 'semantic_punch',
            'CLOSER': 'closer', 'ODD_STAT': 'raw_reveal'}.get(beat_type, 'short_reaction')
    display = {'lines': [], 'display_quote': False}
    # Only editorial spotlight candidates get a quote display; never arbitrary first lines.
    if finding['origin'] == 'semantic' and beat_type == 'REVIEW_SPOTLIGHT':
        quote = next((e['data'].get('excerpt') for e in finding['evidence'] if e['source_type'] == 'review'), None)
        if quote and len(quote) <= 350:
            display = {'lines': [quote], 'display_quote': True}
            mode = 'quote_reaction'
    return {'id': '', 'position': 0, 'beat_type': beat_type, 'finding_ids': [finding['id']],
            'origin': finding['origin'], 'selected_observation': finding['observation'],
            'selection_reason': reason, 'writer_mode': mode, 'evidence': finding['evidence'],
            'display': display, 'previous_context': [], 'allow_silence': bool(display['lines']),
            'film_keys': finding['film_keys'], 'related_tags': finding['related_tags']}


def build_script(pool: list[dict], stats: dict, max_beats: int = 10, max_evidence_chars: int = 10000) -> dict:
    if not 1 <= max_beats <= 12:
        raise ValueError('SCRIPT_MAX_BEATS deve estar entre 1 e 12.')
    opening_data = {k: stats[k] for k in ('watched_films', 'rated_films', 'reviews')}
    opening = {'id': 'beat_01', 'position': 1, 'beat_type': 'OPENING', 'finding_ids': [],
               'origin': 'deterministic', 'selected_observation': 'Abertura curta com números gerais.',
               'selection_reason': {'reason': 'Orientar a experiência com contagens verificadas.'},
               'writer_mode': 'raw_reveal', 'evidence': [{'source_type': 'stats', 'source_id': 'opening', 'data': opening_data}],
               'display': {'lines': [f"{stats['watched_films']} filmes vistos. {stats['reviews']} reviews."], 'display_quote': False},
               'previous_context': [], 'allow_silence': True, 'film_keys': [], 'related_tags': []}
    beats, selected, excluded = [opening], [], []
    candidates = []
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
    while candidates and len(beats) < target:
        ranked = []
        for item in candidates:
            kind = category(item)
            if types[kind] >= 2 or any(duplicate(item, old) for old in selected):
                continue
            film_repeat = sum(films[k] for k in item['film_keys']) / max(1, len(item['film_keys']))
            penalty = 18 * types[kind] + 12 * film_repeat + 15 * sum(tags[t] for t in item['related_tags'])
            if beats[-1]['beat_type'] == kind:
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
        beats.append(make_beat(item, kind, {'base_score': item['score'] * item['confidence'],
                     'diversity_penalty': penalty, 'adjusted_score': score,
                     'reason': 'Highest remaining evidence-backed score after type/film/tag penalties.'}))
        selected.append(item)
        candidates.remove(item)
        types[kind] += 1
        films.update(item['film_keys'])
        tags.update(item['related_tags'])
    if closer and not any(duplicate(closer, old) for old in selected):
        beats.append(make_beat(closer, 'CLOSER', {'reason': 'Strongest unused semantic candidate reserved for ending.',
                                               'base_score': closer['score'] * closer['confidence']}))
    for i, beat in enumerate(beats, 1):
        beat.update(id=f'beat_{i:02}', position=i)
    excluded.extend({'id': f['id'], 'reason': 'diversity, novelty or beat limit'} for f in candidates)
    return {'target_max_beats': max_beats, 'beats': beats, 'excluded': excluded,
            'policy': 'Quality before count; max two per category; no inferred callbacks; independent evidence only.'}


def writer_input(beat: dict, language: str, max_lines: int = 3, max_words: int = 24) -> dict:
    return {'beat_id': beat['id'], 'language': language, 'writer_mode': beat['writer_mode'],
            'beat_type': beat['beat_type'], 'selected_observation': beat['selected_observation'],
            'evidence': beat['evidence'], 'display': beat['display'], 'previous_context': beat['previous_context'],
            'allow_silence': beat['allow_silence'], 'limits': {'max_lines': max_lines,
            'preferred_words_per_line': '2–12', 'hard_max_words_per_line': max_words}}
