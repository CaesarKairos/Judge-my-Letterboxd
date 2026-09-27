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
    registry = {
        ('stats', 'overview'): context.get('stats', {}),
        ('stats', 'review_coverage'): context.get('review_coverage', {}),
    }
    for kind, collection, key in [
        ('film', 'films', 'key'), ('review', 'reviews', 'id'),
        ('diary', 'diary', 'id'), ('tag', 'tags', 'tag'), ('list', 'lists', 'id'),
        ('finding', 'deterministic_findings', 'id'), ('rewatch', 'rewatches', 'film_key'),
        ('review_style', 'review_style_items', 'id')
    ]:
        registry.update({(kind, item[key]): item for item in context.get(collection, []) if key in item})
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


def evidence_numbers(value: Any) -> set[float]:
    """Numbers already present in cited evidence are grounded without duplicate bookkeeping."""
    if type(value) in (int, float) and math.isfinite(value):
        return {float(value)}
    if isinstance(value, str):
        return numeric_tokens(value)
    if isinstance(value, dict):
        return set().union(*(evidence_numbers(v) for v in value.values())) if value else set()
    if isinstance(value, list):
        return set().union(*(evidence_numbers(v) for v in value)) if value else set()
    return set()


ELLIPSIS_RE = re.compile(r'\s*(?:\.{2,}|…|\[\.\.\.\])\s*')


def quote_fragments(quote: str) -> list[str]:
    return [fragment.strip() for fragment in ELLIPSIS_RE.split(quote) if fragment.strip()]


def fragments_in_order(fragments: list[str], body: str) -> bool:
    cursor = 0
    for fragment in fragments:
        position = body.find(fragment, cursor)
        if position == -1:
            return False
        cursor = position + len(fragment)
    return True


def quote_style(quote: str, texts: list[str]) -> str:
    """'exact' for a contiguous excerpt, 'fragments' when only omissions were added.

    A model may cut an excerpt short with an ellipsis. Every fragment still has to be an
    exact, in-order substring of the cited record, so no word can be invented.
    """
    fragments = quote_fragments(quote)
    if not fragments:
        return ''
    # A trailing ellipsis still marks an excerpt: the fragment itself must exist in order.
    has_ellipsis = bool(ELLIPSIS_RE.search(quote))
    for text in texts:
        for body in (text, plain_text(text)):
            if quote in body:
                return 'exact'
            if has_ellipsis and fragments_in_order(fragments, body):
                return 'fragments'
    return ''


def materialize_reference(ref: dict, registry: dict, notes: dict) -> dict:
    """Resolve model-selected IDs to original backend data.

    Review focus_text is only a hint. A bad hint never kills a good finding:
    the backend keeps the original full review and chooses a safe excerpt.
    """
    source = registry[(ref['source_type'], ref['source_id'])]
    if ref['source_type'] == 'review':
        focus = str(ref.get('focus_text') or '').strip()
        body = str(source.get('text') or '')
        plain = plain_text(body)
        resolved = ''
        if focus:
            style = quote_style(focus, [body, plain])
            if style:
                fragments = quote_fragments(focus)
                resolved = fragments[0] if fragments else focus
                notes.setdefault('focus_text', {})[ref['source_id']] = style
            else:
                notes.setdefault('focus_text', {})[ref['source_id']] = 'unresolved_hint_ignored'
        if not resolved:
            resolved = plain[:900].rsplit(' ', 1)[0] if len(plain) > 900 else plain
        data = {k: source.get(k) for k in ('id', 'film_key', 'date', 'logged_date', 'review_rating', 'rewatch', 'tags')}
        data.update(full_text=body, excerpt=resolved, excerpt_only=len(resolved) < len(plain))
    else:
        data = source
    return {'source_type': ref['source_type'], 'source_id': ref['source_id'], 'data': data}


def normalize_unit(value: Any) -> float | None:
    """Bring an out-of-contract score into 0..1 without changing its order.

    The wire schema cannot carry minimum/maximum on nested fields (some Flash
    versions answer HTTP 400), so a model may legitimately answer on a 0–100 scale.
    1..100 is read as a percentage; above 100 saturates at 1; negative saturates at 0.
    Anything non-numeric stays untouched and is rejected by the schema check.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    if value < 0:
        return 0.0
    if value <= 1:
        return float(value)
    if value <= 100:
        return value / 100
    return 1.0


SCORE_FIELDS = ('interestingness', 'confidence')


# Collection names a model naturally copies from the payload, mapped to the evidence vocabulary.
SOURCE_ALIASES = {'film': 'film', 'films': 'film', 'ratings': 'film', 'watched': 'film', 'watchlist': 'film',
                  'review': 'review', 'reviews': 'review', 'diary': 'diary', 'diary_entries': 'diary',
                  'tag': 'tag', 'tags': 'tag', 'list': 'list', 'lists': 'list',
                  'rewatch': 'rewatch', 'rewatches': 'rewatch', 'finding': 'finding', 'findings': 'finding',
                  'deterministic_findings': 'finding', 'stats': 'stats', 'overview': 'stats',
                  'review_style': 'review_style', 'reviewstyle': 'review_style'}
ROUNDING_TOLERANCE = 5e-3  # 0.5%: accepts 1.67 for 1.6667, rejects an invented 4.2 for 3.8


def canonical_source(value: Any) -> str | None:
    return SOURCE_ALIASES.get(str(value).strip().casefold())


def resolve_field(record: dict, path: str) -> tuple[Any, str]:
    """Documented dot path first, then a unique match by field name anywhere in the record."""
    try:
        return field_value(record, path), 'exact_path'
    except (KeyError, IndexError, TypeError):
        leaf = path.split('.')[-1]
        matches: list[Any] = []

        def walk(value: Any) -> None:
            if len(matches) > 1:
                return
            if isinstance(value, dict):
                for key, item in value.items():
                    if key == leaf:
                        matches.append(item)
                    walk(item)
            elif isinstance(value, list):
                for item in value:
                    walk(item)

        walk(record)
        if len(matches) == 1:
            return matches[0], 'unique_name_match'
        raise KeyError(path)


def normalize_candidate(item: dict) -> tuple[dict, dict]:
    """Clamp scores to 0..1 and bound arrays to the documented maxima, recording every change."""
    candidate = dict(item)
    notes: dict[str, Any] = {}
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
    for group in ('evidence', 'numeric_claims'):
        for ref in candidate.get(group) or []:
            if not isinstance(ref, dict):
                continue
            canonical = canonical_source(ref.get('source_type'))
            if canonical and canonical != ref.get('source_type'):
                aliases[ref['source_type']] = canonical
                ref['source_type'] = canonical
    if aliases:
        notes['source_type_aliases'] = aliases
    bounds = SEMANTIC_SCHEMA['properties']['semantic_findings']['items']['properties']
    bounded = {}
    for field, schema in bounds.items():
        limit = schema.get('maxItems')
        value = candidate.get(field)
        if limit and isinstance(value, list) and len(value) > limit:
            candidate[field] = value[:limit]
            bounded[field] = {'returned': len(value), 'kept': limit}
    if bounded:
        notes['bounded_lists'] = bounded
    return candidate, notes


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
        item, notes = normalize_candidate(item) if isinstance(item, dict) else (item, {})
        errors = schema_errors(item, schema)
        if errors:
            rejected.append({'candidate': item, 'errors': errors})
            continue
        # The ID only has to be a usable, unique key; the prefix is a prompt convention.
        identifier = item['id'] if isinstance(item['id'], str) else ''
        if not identifier.strip() or any(c.isspace() for c in identifier) or identifier in seen:
            errors.append('invalid or duplicate semantic ID')
        if not identifier.startswith('semantic_') and 'invalid' not in ' '.join(errors):
            notes['id_convention'] = 'kept a non-standard ID; the prompt asks for semantic_NNN'
        seen.add(identifier)
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
            if quote:
                style = quote_style(quote, texts)
                if not style:
                    errors.append(f'quote not found: {key}')
                elif style == 'fragments':
                    notes.setdefault('quote_style', {})[f'{key[0]}:{key[1]}'] = 'excerpt_with_ellipsis'
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
            if not any(kind in {'diary', 'rewatch'} or (kind == 'finding' and registry[(kind, sid)]['type'] in {'rewatch', 'tag_rating_difference'})
                       for kind, sid in cited):
                errors.append('session claims require diary or rewatch evidence; reviews are not sessions')
        # Any number already present in a cited source is grounded. numeric_claims
        # remain useful for calculated/backend fields, but the model no longer has
        # to redundantly declare a film year/rating that is plainly in its evidence.
        numeric_values = set()
        for key in cited:
            numeric_values.update(evidence_numbers(registry[key]))
        for fid in item['film_keys']:
            if ('film', fid) in registry:
                numeric_values.update(evidence_numbers(registry[('film', fid)]))
        for claim in item['numeric_claims']:
            key = (claim['source_type'], claim['source_id'])
            try:
                # The claim must be for a cited evidence record, a referenced film, or an account-level finding/stat
                is_grounded_target = (key in cited) or (key[0] == 'film' and key[1] in item['film_keys']) or (key[0] in {'stats', 'finding'})
                if not is_grounded_target:
                    raise ValueError
                actual, resolution = resolve_field(registry[key], claim['field'])
                if type(actual) not in (int, float):
                    raise ValueError
                if not math.isclose(actual, claim['value'], abs_tol=1e-8):
                    if not math.isclose(actual, claim['value'], rel_tol=ROUNDING_TOLERANCE):
                        raise ValueError
                    notes.setdefault('numeric_tolerance', 'relative_0.5%')
                if resolution != 'exact_path':
                    notes.setdefault('field_resolution', {})[claim['field']] = resolution
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
            accepted.append({**item, 'resolved_evidence': materialized, **notes,
                             'validation': 'references_quotes_numbers_checked'})
    return accepted, rejected



