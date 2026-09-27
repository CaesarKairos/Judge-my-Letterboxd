"""Wire schemas and prompt identifiers; no behavior depends on version labels."""
from typing import Any
ANALYST_PROMPT_VERSION = 'v2'
WRITER_PROMPT_VERSION = 'v3'


def obj(properties: dict) -> dict:
    return {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False}


def array(items: dict, maximum: int = 30) -> dict:
    return {'type': 'array', 'items': items, 'maxItems': maximum}


STRING = {'type': 'string'}
REF = obj({'source_type': {'type': 'string', 'enum': ['review', 'diary', 'film', 'tag', 'list', 'finding', 'stats', 'rewatch']},
           'source_id': STRING, 'quote': STRING})
NUMBER_CLAIM = obj({'source_type': STRING, 'source_id': STRING, 'field': STRING, 'value': {'type': 'number'}})
SEMANTIC_SCHEMA = obj({'semantic_findings': array(obj({
    'id': STRING,
    'type': {'type': 'string', 'enum': ['self_irony', 'semantic_contrast', 'review_spotlight', 'recurring_idea',
                                     'list_meaning', 'tag_meaning', 'meaningful_exception']},
    'interestingness': {'type': 'number', 'minimum': 0, 'maximum': 1},
    'confidence': {'type': 'number', 'minimum': 0, 'maximum': 1},
    'observation': STRING, 'why_interesting': STRING,
    'evidence': array(REF, 6), 'film_keys': array(STRING, 8),
    'related_tags': array(STRING, 5), 'related_lists': array(STRING, 5),
    'numeric_claims': array(NUMBER_CLAIM, 10)}), 24)})
WRITER_SCHEMA = obj({'lines': array(STRING, 3)})  # kept for historical per-beat audits
LINE_ITEM = {'type': 'object', 'properties': {'text': STRING,
                                             'effect': {'type': 'string', 'enum': ['none', 'strike', 'correction']}},
             'required': ['text']}
FINAL_WRITER_SCHEMA = obj({
    'opening': {'type': 'object', 'properties': {
        'salutation': STRING, 'top_four_archetype': array(STRING, 4),
        'negative_adjective': STRING, 'positive_adjective': STRING,
        'profile_reaction': {'type': 'array', 'items': LINE_ITEM, 'maxItems': 1}},
     'required': ['salutation', 'top_four_archetype', 'negative_adjective', 'positive_adjective', 'profile_reaction'],
     'additionalProperties': False},
    'beats': array(obj({'beat_id': STRING, 'lines': array(LINE_ITEM, 3)}), 12),
    'closer': {'type': 'object', 'properties': {'lines': {'type': 'array', 'items': LINE_ITEM, 'maxItems': 3}},
               'required': ['lines'], 'additionalProperties': False}})


def wire_schema(schema: dict) -> dict:
    """Keep the provider grammar small; enforce all bounds again locally.

    Some Flash versions reject nested maxItems/additionalProperties constraints
    with HTTP 400. The wire contract retains object fields, types, required and enums.
    """
    def simplify(value: Any) -> Any:
        if isinstance(value, dict):
            return {k: simplify(v) for k, v in value.items()
                    if k not in {'maxItems', 'additionalProperties', 'minimum', 'maximum'}}
        if isinstance(value, list):
            return [simplify(v) for v in value]
        return value
    return simplify(schema)
