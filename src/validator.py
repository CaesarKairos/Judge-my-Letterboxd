"""Mechanical grounding checks. They do not prove semantic entailment."""
import json
import math
import re
from typing import Any

from .ai_schemas import SEMANTIC_SCHEMA
from .utils import plain_text


def schema_errors(value: Any, schema: dict, path: str = '$') -> list[str]:
    kind = schema['type']
    valid = {'object': isinstance(value, dict), 'array': isinstance(value, list),
             'string': isinstance(value, str), 'number': type(value) in (int, float) and math.isfinite(value)}
    if not valid[kind]:
        return [f'{path}: expected {kind}']
    errors = []
    if 'enum' in schema and value not in schema['enum']:
        errors.append(f'{path}: invalid enum')
    if kind == 'object':
        for key in schema.get('required', []):
            if key not in value:
                errors.append(f'{path}.{key}: missing')
        for key, item in value.items():
            if key not in schema['properties']:
                errors.append(f'{path}.{key}: unknown field')
            else:
                errors.extend(schema_errors(item, schema['properties'][key], f'{path}.{key}'))
    elif kind == 'array':
        if len(value) > schema.get('maxItems', len(value)):
            errors.append(f'{path}: too many items')
        for i, item in enumerate(value):
            errors.extend(schema_errors(item, schema['items'], f'{path}[{i}]'))
    elif kind == 'number' and not schema.get('minimum', -math.inf) <= value <= schema.get('maximum', math.inf):
        errors.append(f'{path}: outside range')
    return errors


def evidence_registry(context: dict) -> dict[tuple[str, str], dict]:
    registry = {('stats', 'overview'): context['stats']}
    for kind, collection, key in [('film', 'films', 'key'), ('review', 'reviews', 'id'),
                                  ('diary', 'diary', 'id'), ('tag', 'tags', 'tag'), ('list', 'lists', 'id'),
                                  ('finding', 'deterministic_findings', 'id'), ('rewatch', 'rewatches', 'film_key')]:
        registry.update({(kind, item[key]): item for item in context.get(collection, [])})
    return registry


def numeric_tokens(text: str) -> set[float]:
    return {float(n.replace(',', '.')) for n in re.findall(r'(?<!\w)\d+(?:[.,]\d+)?', text)}


def field_value(record: dict, field: str) -> Any:
    value: Any = record
    for part in field.split('.'):
        value = value[int(part)] if isinstance(value, list) else value[part]
    return value


def strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return strings(list(value.values()))
    if isinstance(value, list):
        return [text for v in value for text in strings(v)]
    return []


def materialize_reference(ref: dict, registry: dict) -> dict:
    source = registry[(ref['source_type'], ref['source_id'])]
    if ref['source_type'] == 'review':
        # Writer sees exactly the cited excerpt, never the entire review collection.
        data = {k: source[k] for k in ('id', 'film_key', 'date', 'review_rating', 'tags')}
        data.update(excerpt=ref['quote'], excerpt_only=True)
    else:
        data = source
    return {'source_type': ref['source_type'], 'source_id': ref['source_id'], 'data': data}


def validate_semantic_findings(raw: str, context: dict) -> tuple[list[dict], list[dict]]:
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return [], [{'id': None, 'errors': ['invalid JSON']}]
    if not isinstance(parsed, dict) or set(parsed) != {'semantic_findings'} or not isinstance(parsed['semantic_findings'], list):
        return [], [{'id': None, 'errors': ['expected semantic_findings array']}]
    if len(parsed['semantic_findings']) > 24:
        return [], [{'id': None, 'errors': ['too many semantic findings']}]
    registry = evidence_registry(context)
    accepted, rejected = [], []
    seen: set[str] = set()
    schema = SEMANTIC_SCHEMA['properties']['semantic_findings']['items']
    for item in parsed['semantic_findings']:
        errors = schema_errors(item, schema)
        if errors:
            rejected.append({'candidate': item, 'errors': errors})
            continue
        if not item['id'].startswith('semantic_') or item['id'] in seen:
            errors.append('invalid or duplicate semantic ID')
        seen.add(item['id'])
        if not item['observation'].strip() or not item['why_interesting'].strip():
            errors.append('empty observation')
        prose = item['observation'] + ' ' + item['why_interesting']
        # This dataset has no trusted release-date field. Never accept a comparison to one.
        external_chronology = r'(?:antes|depois|anterior|posterior|before|after).{0,100}(?:lançamento|estreia|existir|release|premiere|existed)'
        if re.search(external_chronology, prose, flags=re.I):
            errors.append('external release chronology is not supplied by this dataset')
        if not item['evidence']:
            errors.append('evidence required')
        cited = set()
        materialized = []
        for ref in item['evidence']:
            key = (ref['source_type'], ref['source_id'])
            if key not in registry:
                errors.append(f'missing evidence: {key}')
                continue
            cited.add(key)
            quote = ref['quote']
            texts = strings(registry[key])
            if quote and not any(quote in t or quote in plain_text(t) for t in texts):
                errors.append(f'quote not found: {key}')
            if ref['source_type'] == 'review' and (not quote.strip() or len(quote) > 1000):
                errors.append('review evidence needs an exact excerpt of 1–1000 characters')
            materialized.append(materialize_reference(ref, registry))
        grounded_films = set()
        for kind, source_id in cited:
            source = registry[(kind, source_id)]
            if kind == 'film':
                grounded_films.add(source_id)
            grounded_films.update(source.get('film_keys', []))
            if source.get('film_key'):
                grounded_films.add(source['film_key'])
            grounded_films.update(m['film_key'] for m in source.get('members', []))
        for fid in item['film_keys']:
            if ('film', fid) not in registry or fid not in grounded_films:
                errors.append(f'film absent or not supported by cited sources: {fid}')
        for tag in item['related_tags']:
            if ('tag', tag) not in registry or not any(
                    tag in registry[k].get('tags', []) or k == ('tag', tag) for k in cited):
                errors.append(f'tag absent or uncited: {tag}')
        for lid in item['related_lists']:
            if ('list', lid) not in cited:
                errors.append(f'list absent or uncited: {lid}')
        if item['type'] == 'list_meaning' and item['related_lists']:
            members = {m['film_key'] for lid in item['related_lists'] if ('list', lid) in registry
                       for m in registry[('list', lid)]['members']}
            if set(item['film_keys']) - members:
                errors.append('list_meaning references films outside the cited list membership')
        if re.search(r'\b(?:sessões|sessão|sessions?|rewatches)\b', item['observation'], re.I):
            if not any(kind in {'diary', 'rewatch'} or (kind == 'finding' and registry[(kind, sid)]['type'] == 'rewatch')
                       for kind, sid in cited):
                errors.append('session claims require diary or rewatch evidence; reviews are not sessions')
        numeric_values = set()
        for claim in item['numeric_claims']:
            key = (claim['source_type'], claim['source_id'])
            try:
                actual = field_value(registry[key], claim['field'])
                if key not in cited or type(actual) not in (int, float) or not math.isclose(actual, claim['value'], abs_tol=1e-8):
                    raise ValueError
                numeric_values.add(float(actual))
            except (KeyError, IndexError, ValueError, TypeError):
                errors.append('numeric claim does not match cited field')
        # Digits in quotes/titles may be repeated; statistical digits require field claims.
        for ref in item['evidence']:
            numeric_values.update(numeric_tokens(ref['quote']))
        for fid in item['film_keys']:
            if ('film', fid) in registry:
                numeric_values.update(numeric_tokens(registry[('film', fid)]['name']))
        declared = numeric_tokens(item['observation'] + ' ' + item['why_interesting'])
        if declared - numeric_values:
            errors.append('numbers in prose lack quoted evidence or numeric_claims')
        if errors:
            rejected.append({'candidate': item, 'errors': errors})
        else:
            accepted.append({**item, 'resolved_evidence': materialized, 'validation': 'references_quotes_numbers_checked'})
    return accepted, rejected



