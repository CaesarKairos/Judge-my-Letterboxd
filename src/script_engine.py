"""AI-first editorial selection. Python supplies evidence and safe fallbacks; it does not pretend stats are jokes."""
from collections import Counter
import json
import re

from .editorial_v2 import make_moment

# Deterministic findings are measurements. Only a small subset is intrinsically
# display-ready enough to serve as fallback when the Analyst does not supply enough
# semantic moments.
DETERMINISTIC_FALLBACK_TYPES = {
    'rewatch',
    'writing_pattern',
    'tag_overlap',
    'own_list',
    'multiple_reviews',
}

CATEGORY_FOR_TYPE = {
    'list_meaning': 'LIST_PATTERN',
    'tag_meaning': 'TAG_PATTERN',
    'recurring_idea': 'WRITING_PATTERN',
    'review_spotlight': 'REVIEW_SPOTLIGHT',
    'semantic_contrast': 'RATING_CONTRAST',
    'self_irony': 'SEMANTIC_FINDING',
    'meaningful_exception': 'SEMANTIC_FINDING',
    'rewatch_pattern': 'REWATCH',
    'logging_behavior': 'SEMANTIC_FINDING',
    'writing_pattern': 'WRITING_PATTERN',
    'rewatch': 'REWATCH',
    'tag_overlap': 'TAG_PATTERN',
    'multiple_reviews': 'REVIEW_SPOTLIGHT',
    'own_list': 'LIST_PATTERN',
}


def category(finding: dict) -> str:
    return CATEGORY_FOR_TYPE.get(finding['type'], 'SEMANTIC_FINDING' if finding['origin'] == 'semantic' else 'ODD_STAT')


def duplicate(a: dict, b: dict) -> bool:
    if a['id'] == b['id']:
        return True

    def sources(f: dict) -> set:
        return {(e['source_type'], e['source_id']) for e in f['evidence']
                if e['source_type'] not in {'film_identity', 'finding'}}

    sa, sb = sources(a), sources(b)
    if sa and sb and len(sa & sb) / len(sa | sb) >= .65:
        return True
    fa, fb = set(a['film_keys']), set(b['film_keys'])
    if a['type'] == b['type'] and fa and fb and len(fa & fb) / len(fa | fb) >= .8:
        return True
    # Similar prose alone is not duplication: LLMs often describe distinct
    # evidence with the same vocabulary. Text similarity only breaks ties when
    # the candidates already share concrete evidence or films.
    wa = set(re.findall(r'\w+', a['observation'].casefold()))
    wb = set(re.findall(r'\w+', b['observation'].casefold()))
    has_shared_ground = bool((sa and sb and sa & sb) or (fa and fb and fa & fb))
    return bool(has_shared_ground and wa and wb and len(wa & wb) / len(wa | wb) >= .82)


def _eligible(pool: list[dict], max_evidence_chars: int) -> tuple[list[dict], list[dict]]:
    candidates, excluded = [], []
    for item in pool:
        base = item['score'] * item['confidence']
        if len(json.dumps(item['evidence'], ensure_ascii=False)) > max_evidence_chars:
            excluded.append({'id': item['id'], 'reason': 'evidence exceeds per-beat budget'})
            continue
        if item['origin'] == 'semantic':
            if base < 50 or item['confidence'] < .6:
                excluded.append({'id': item['id'], 'reason': 'semantic candidate below editorial threshold'})
                continue
            candidates.append(item)
            continue
        if item['type'] not in DETERMINISTIC_FALLBACK_TYPES:
            excluded.append({'id': item['id'], 'reason': 'measurement kept for Analyst, not auto-promoted to a beat'})
            continue
        if base < 45 or item['confidence'] < .6:
            excluded.append({'id': item['id'], 'reason': 'deterministic fallback below threshold'})
            continue
        candidates.append(item)
    return candidates, excluded


def build_script(pool: list[dict], max_beats: int = 12, max_evidence_chars: int = 16000, locale=None) -> dict:
    """Build a sequence from AI-selected semantic moments, with restrained local fallbacks."""
    if not 1 <= max_beats <= 14:
        raise ValueError('SCRIPT_MAX_BEATS deve estar entre 1 e 14.')

    candidates, excluded = _eligible(pool, max_evidence_chars)
    semantic = [f for f in candidates if f['origin'] == 'semantic']
    deterministic = [f for f in candidates if f['origin'] == 'deterministic']

    # The Analyst is the editor. Deterministic findings only fill genuine gaps.
    ordered = sorted(semantic, key=lambda f: (-f['score'] * f['confidence'], f['id']))
    if len(ordered) < max_beats:
        ordered.extend(sorted(deterministic, key=lambda f: (-f['score'] * f['confidence'], f['id'])))

    selected: list[dict] = []
    reasons: list[dict] = []
    types, films, tags = Counter(), Counter(), Counter()

    for item in ordered:
        if len(selected) >= max_beats:
            break
        if any(duplicate(item, old) for old in selected):
            excluded.append({'id': item['id'], 'reason': 'duplicate editorial idea'})
            continue
        kind = category(item)
        if types[kind] >= 3:
            excluded.append({'id': item['id'], 'reason': 'category diversity cap'})
            continue

        film_repeat = sum(films[k] for k in item['film_keys']) / max(1, len(item['film_keys']))
        tag_repeat = sum(tags[t] for t in item['related_tags'])
        penalty = 10 * types[kind] + 8 * film_repeat + 10 * tag_repeat
        if selected and category(selected[-1]) == kind:
            penalty += 14
        editorial = item['score'] * item['confidence'] - penalty
        if editorial < 35:
            excluded.append({'id': item['id'], 'reason': 'diversity-adjusted editorial score too low'})
            continue

        selected.append(item)
        types[kind] += 1
        films.update(item['film_keys'])
        tags.update(item['related_tags'])
        reasons.append({
            'id': item['id'],
            'origin': item['origin'],
            'category': kind,
            'base_score': item['score'] * item['confidence'],
            'diversity_penalty': penalty,
            'adjusted_score': editorial,
            'reason': ('AI Analyst editorial candidate' if item['origin'] == 'semantic'
                       else 'display-ready deterministic fallback'),
        })

    # Reserve the strongest genuinely semantic remaining item as closer by moving it
    # to the end. No separate "closer invention" happens here.
    if len(selected) >= 3:
        semantic_indices = [i for i, item in enumerate(selected) if item['origin'] == 'semantic']
        if semantic_indices:
            best = max(semantic_indices, key=lambda i: selected[i]['score'] * selected[i]['confidence'])
            selected.append(selected.pop(best))

    moments = [make_moment(item, position, locale) for position, item in enumerate(selected, 1)]
    if moments and selected[-1]['origin'] == 'semantic' and len(moments) >= 3:
        moments[-1]['role'] = 'closer'

    selected_ids = {f['id'] for f in selected}
    for item in candidates:
        if item['id'] not in selected_ids and not any(e['id'] == item['id'] for e in excluded):
            excluded.append({'id': item['id'], 'reason': 'beat limit or diversity'})

    return {
        'target_max_beats': max_beats,
        'moments': moments,
        'selection': reasons,
        'excluded': excluded,
        'policy': ('AI-first: semantic candidates define the show. Deterministic findings are measurements '
                   'and only a small display-ready subset may fill gaps. rating_group/review-length/tag-mean '
                   'statistics are never auto-promoted to jokes.'),
    }


def moment_payload(moment: dict, max_lines: int, max_words: int) -> dict:
    return {
        'beat_id': moment['beat_id'],
        'moment_type': moment['moment_type'],
        'writer_mode': moment['writer_mode'],
        'max_lines': min(max_lines, moment['max_lines']),
        'allow_silence': moment['allow_silence'],
        'what_the_user_sees': moment['display'],
        'editorial_candidate': moment['observation'],
        'why_interesting': moment.get('why_interesting', ''),
        'cultural_angle': moment.get('cultural_angle', ''),
        'evidence': moment['evidence'],
        'limits': {
            'max_lines': min(max_lines, moment['max_lines']),
            'hard_max_words_per_line': max_words,
        },
    }


def compact_review_style(style: dict | None) -> dict:
    """Global style context for rhythm/callbacks, without shipping huge ID arrays twice."""
    style = style or {}
    def rows(name: str, limit: int):
        return [
            {key: row.get(key) for key in ('id', 'kind', 'phrase', 'markup', 'count', 'share',
                                            'phrase_coverage', 'markup_coverage') if row.get(key) is not None}
            for row in style.get(name, [])[:limit]
        ]
    return {
        'review_count': style.get('review_count'),
        'phrases': rows('phrases', 15),
        'openings': rows('openings', 8),
        'closings': rows('closings', 8),
        'markup': {
            key: {k: row.get(k) for k in ('id', 'kind', 'markup', 'count', 'share')}
            for key, row in (style.get('markup') or {}).items()
        },
        'intersections': rows('intersections', 15),
    }


def compact_review_coverage(coverage: dict | None) -> dict:
    coverage = coverage or {}
    return {
        key: coverage.get(key)
        for key in ('diary_sessions', 'matched_sessions', 'matched_review_records',
                    'sessions_without_review', 'reviewed_session_percent', 'matching_semantics')
        if key in coverage
    }


def final_writer_input(moments: list[dict], closer: dict | None, plan: dict, locale, top_four: list[dict],
                       max_lines: int = 4, max_words: int = 14, overview: dict | None = None,
                       review_style: dict | None = None, review_coverage: dict | None = None) -> dict:
    """The Writer sees the whole SELECTED show, never the full ZIP again."""
    return {
        'task': 'Write the Judge voice for a fixed script selected from the complete export by the Analyst.',
        'language': locale.locale,
        'top_four_films': top_four,
        'editorial_dossier': {
            'profile_overview': overview or {},
            'review_style': compact_review_style(review_style),
            'review_coverage': compact_review_coverage(review_coverage),
            'note': 'Use this for global rhythm/callback context; beat facts still come from each moment evidence.'
        },
        'opening_slots': {
            'salutation_allowed': locale.salutations(),
            'adjective_pairs_allowed': locale.adjective_pairs(),
            'archetype': {
                'count': 4,
                'output': 'exactly four concepts, hyphen-joined by the frontend',
                'source': 'the four favorite films listed above',
                'about': 'recognizable archetypes, nouns, settings, genres or narrative elements of those films',
                'concept_rules': ['one word when possible', 'at most two words', 'natural Portuguese',
                                  'visual or recognizable rather than generic', 'semantically distinct', 'no numbers, no diagnoses',
                                  'avoid generic words such as drama, story, emotional, intelligence when a concrete concept exists'],
                'forbidden': ['claims about the person', 'religion', 'politics', 'health',
                              'clinical personality', 'personality diagnosis'],
            },
            'profile_reaction': {
                'max_lines': 1, 'max_words': 14, 'optional': True,
                'note': 'the numbers are already on screen',
            },
        },
        'moments': [moment_payload(m, max_lines, max_words) for m in moments],
        'closer': moment_payload(closer, max_lines, max_words) if closer else None,
        'writer_rules': {
            'timing': ('The interface owns pauses, posters, strikes, corrections and anticipation. '
                       'Write simpler text, not more theatrical text.'),
            'effects': ('Set effect=strike only when actually crossing out writer text; '
                        'effect=correction only for its immediate replacement. Never write Markdown.'),
            'structure': 'Do not add, remove or reorder moments. Do not invent films, numbers, causes or context.',
            'silence': 'An empty lines array is valid when the display already says everything.',
            'global_context': 'You can see every selected beat. Use that only for rhythm, repetition and supported callbacks.',
        },
        'limits': {
            'max_lines': max_lines,
            'hard_max_words_per_line': max_words,
            'moments': len(moments),
            'closer': bool(closer),
        },
    }
