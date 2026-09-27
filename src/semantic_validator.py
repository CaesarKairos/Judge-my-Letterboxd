"""Semantic Analyst validation v3.

The model selects evidence IDs and editorial meaning. Python materializes originals,
checks account facts and tolerates an imperfect review focus hint.
"""
import json
import math
import re
from typing import Any

from .ai_schemas import SEMANTIC_SCHEMA
from .utils import plain_text
from .validator import (
    ROUNDING_TOLERANCE,
    SCORE_FIELDS,
    canonical_source,
    evidence_numbers,
    normalize_unit,
    numeric_tokens,
    quote_fragments,
    quote_style,
    schema_errors,
)


def evidence_registry(context: dict) -> dict[tuple[str, str], dict]:
    registry = {
        ('stats', 'overview'): context.get('stats', {}),
        ('stats', 'review_coverage'): context.get('review_coverage', {}),
    }
    for kind, collection, key in [
        ('film', 'films', 'key'),
        ('review', 'reviews', 'id'),
        ('diary', 'diary', 'id'),
        ('tag', 'tags', 'tag'),
        ('list', 'lists', 'id'),
        ('finding', 'deterministic_findings', 'id'),
        ('rewatch', 'rewatches', 'film_key'),
        ('review_style', 'review_style_items', 'id'),
    ]:
        for item in context.get(collection, []):
            if isinstance(item, dict) and key in item:
                registry[(kind, item[key])] = item
    return registry


def normalize_candidate(item: dict) -> tuple[dict, dict]:
    candidate = dict(item)
    notes: dict[str, Any] = {}
    candidate.setdefault('cultural_angle', '')

    # Compatibility with archived v2 Analyst responses.
    if 'numeric_claims' in candidate:
        candidate.pop('numeric_claims', None)
        notes['legacy_numeric_claims'] = 'dropped'

    scales = {}
    for field in SCORE_FIELDS:
        value = candidate.get(field)
        normalized = normalize_unit(value)
        if normalized is not None and normalized != value:
            candidate[field] = normalized
            scales[field] = 'percent_to_unit' if isinstance(value, (int, float)) and value > 1 else 'saturated'
    if scales:
        notes['score_normalization'] = scales

    aliases = {}
    repaired = []
    for raw_ref in candidate.get('evidence') or []:
        if not isinstance(raw_ref, dict):
            repaired.append(raw_ref)
            continue
        ref = dict(raw_ref)
        canonical = canonical_source(ref.get('source_type'))
        if canonical and canonical != ref.get('source_type'):
            aliases[str(ref.get('source_type'))] = canonical
            ref['source_type'] = canonical
        if 'focus_text' not in ref:
            ref['focus_text'] = str(ref.pop('quote', '') or '')
        else:
            ref.pop('quote', None)
        repaired.append(ref)
    candidate['evidence'] = repaired
    if aliases:
        notes['source_type_aliases'] = aliases

    properties = SEMANTIC_SCHEMA['properties']['semantic_findings']['items']['properties']
    bounded = {}
    for field, schema in properties.items():
        value, limit = candidate.get(field), schema.get('maxItems')
        if limit and isinstance(value, list) and len(value) > limit:
            candidate[field] = value[:limit]
            bounded[field] = {'returned': len(value), 'kept': limit}
    if bounded:
        notes['bounded_lists'] = bounded
    return candidate, notes


def _review_materialization(source: dict, focus: str, notes: dict) -> dict:
    body = str(source.get('text') or '')
    plain = plain_text(body)
    excerpt = ''
    if focus:
        style = quote_style(focus, [body, plain])
        if style:
            fragments = quote_fragments(focus)
            excerpt = fragments[0] if fragments else focus
            notes.setdefault('focus_text', {})[source['id']] = style
        else:
            notes.setdefault('focus_text', {})[source['id']] = 'unresolved_hint_ignored'
    if not excerpt:
        excerpt = plain if len(plain) <= 900 else plain[:900].rsplit(' ', 1)[0] + '…'
    return {
        'id': source.get('id'),
        'film_key': source.get('film_key'),
        'date': source.get('date'),
        'logged_date': source.get('logged_date'),
        'review_rating': source.get('review_rating'),
        'rewatch': source.get('rewatch'),
        'tags': source.get('tags', []),
        'full_text': body,
        'excerpt': excerpt,
        'excerpt_only': len(plain_text(excerpt)) < len(plain),
    }


def materialize_reference(ref: dict, registry: dict, notes: dict) -> dict:
    source = registry[(ref['source_type'], ref['source_id'])]
    data = _review_materialization(source, ref.get('focus_text', ''), notes) if ref['source_type'] == 'review' else source
    return {'source_type': ref['source_type'], 'source_id': ref['source_id'], 'data': data}


def _grounded_films(cited: set[tuple[str, str]], registry: dict) -> set[str]:
    films: set[str] = set()
    for key in cited:
        source = registry[key]
        if key[0] == 'film':
            films.add(key[1])
        if source.get('film_key'):
            films.add(source['film_key'])
        films.update(source.get('film_keys', []))
        films.update(source.get('films', []))
        for field in ('members', 'member_details'):
            films.update(
                member.get('film_key') for member in source.get(field, [])
                if isinstance(member, dict) and member.get('film_key')
            )
    return films


def validate_semantic_findings(raw: str, context: dict) -> tuple[list[dict], list[dict]]:
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return [], [{'id': None, 'errors': ['invalid JSON']}]
    if not isinstance(parsed, dict) or not isinstance(parsed.get('semantic_findings'), list):
        return [], [{'id': None, 'errors': ['expected semantic_findings array']}]

    registry = evidence_registry(context)
    accepted, rejected, seen = [], [], set()
    schema = SEMANTIC_SCHEMA['properties']['semantic_findings']['items']

    for raw_item in parsed['semantic_findings'][:24]:
        item, notes = normalize_candidate(raw_item) if isinstance(raw_item, dict) else (raw_item, {})
        errors = schema_errors(item, schema)
        if errors:
            rejected.append({'candidate': item, 'errors': errors, **notes})
            continue

        identifier = item['id'].strip()
        if not identifier or identifier in seen or any(char.isspace() for char in identifier):
            errors.append('invalid or duplicate semantic ID')
        seen.add(identifier)
        if not item['observation'].strip() or not item['why_interesting'].strip():
            errors.append('empty observation')

        prose = item['observation'] + ' ' + item['why_interesting']
        if re.search(
            r'(?:antes|depois|anterior|posterior|before|after).{0,100}'
            r'(?:lançamento|estreia|existir|release|premiere|existed)',
            prose, re.I
        ):
            errors.append('external release chronology is not supplied by this dataset')

        cited: set[tuple[str, str]] = set()
        materialized = []
        for ref in item['evidence']:
            key = (ref['source_type'], ref['source_id'])
            if key not in registry:
                errors.append(f'missing evidence: {key}')
                continue
            cited.add(key)
            materialized.append(materialize_reference(ref, registry, notes))

        # Repair redundant omissions locally. The model already named these
        # entities in structured fields; Python can materialize their canonical
        # records instead of rejecting an otherwise useful idea.
        auto_refs = []
        for film_id in item['film_keys']:
            key = ('film', film_id)
            if key in registry and key not in cited:
                auto_refs.append({'source_type': 'film', 'source_id': film_id, 'focus_text': ''})
        for tag in item['related_tags']:
            key = ('tag', tag)
            if key in registry and key not in cited:
                auto_refs.append({'source_type': 'tag', 'source_id': tag, 'focus_text': ''})
        for list_id in item['related_lists']:
            key = ('list', list_id)
            if key in registry and key not in cited:
                auto_refs.append({'source_type': 'list', 'source_id': list_id, 'focus_text': ''})

        # Session/rewatch prose often names the film but forgets the aggregate
        # rewatch record. Add it when the backend has exactly that film rewatch.
        if item['type'] == 'rewatch_pattern' or re.search(
            r'\b(?:sessões|sessão|sessions?|rewatches?|reassist)', item['observation'], re.I
        ):
            for film_id in item['film_keys']:
                key = ('rewatch', film_id)
                if key in registry and key not in cited:
                    auto_refs.append({'source_type': 'rewatch', 'source_id': film_id, 'focus_text': ''})

        if auto_refs:
            notes['auto_materialized_evidence'] = [
                f"{ref['source_type']}:{ref['source_id']}" for ref in auto_refs
            ]
            for ref in auto_refs:
                key = (ref['source_type'], ref['source_id'])
                if key in cited:
                    continue
                cited.add(key)
                materialized.append(materialize_reference(ref, registry, notes))

        if not cited:
            errors.append('evidence required')

        grounded = _grounded_films(cited, registry)
        for film_id in item['film_keys']:
            if ('film', film_id) not in registry or film_id not in grounded:
                errors.append(f'film absent or not supported by cited sources: {film_id}')

        for tag in item['related_tags']:
            if ('tag', tag) not in registry:
                errors.append(f'tag absent: {tag}')

        for list_id in item['related_lists']:
            if ('list', list_id) not in registry:
                errors.append(f'list absent: {list_id}')

        if item['type'] == 'list_meaning' and item['related_lists']:
            members = {
                member['film_key']
                for list_id in item['related_lists'] if ('list', list_id) in registry
                for member in registry[('list', list_id)].get('members', [])
                if isinstance(member, dict) and member.get('film_key')
            }
            if set(item['film_keys']) - members:
                errors.append('list_meaning references films outside cited membership')

        if re.search(r'\b(?:sessões|sessão|sessions?|rewatches?|reassist)', item['observation'], re.I):
            if not any(
                kind in {'diary', 'rewatch'}
                or (kind == 'finding' and registry[(kind, source_id)].get('type') in {'rewatch', 'tag_rating_difference'})
                or (kind == 'stats' and source_id == 'review_coverage')
                for kind, source_id in cited
            ):
                errors.append('session claim lacks diary/rewatch/review_coverage evidence')

        numbers: set[float] = set()
        for key in cited:
            numbers.update(evidence_numbers(registry[key]))
        for film_id in item['film_keys']:
            if ('film', film_id) in registry:
                numbers.update(evidence_numbers(registry[('film', film_id)]))
                numbers.update(numeric_tokens(registry[('film', film_id)].get('name', '')))
        unsupported = {
            number for number in numeric_tokens(prose)
            if not any(math.isclose(number, known, rel_tol=ROUNDING_TOLERANCE, abs_tol=ROUNDING_TOLERANCE)
                       for known in numbers)
        }
        if unsupported:
            errors.append('numbers in account prose are absent from cited backend evidence')

        if errors:
            rejected.append({'candidate': item, 'errors': errors, **notes})
        else:
            accepted.append({
                **item,
                'resolved_evidence': materialized,
                **notes,
                'validation': 'references_and_account_facts_checked',
            })
    return accepted, rejected
