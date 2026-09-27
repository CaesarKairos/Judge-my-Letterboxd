"""Wire schemas and prompt identifiers; no behavior depends on version labels."""
from typing import Any

ANALYST_PROMPT_VERSION = 'v3'
WRITER_PROMPT_VERSION = 'v5'


def obj(properties: dict) -> dict:
    return {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False}


def array(items: dict, maximum: int = 30) -> dict:
    return {'type': 'array', 'items': items, 'maxItems': maximum}


STRING = {'type': 'string'}
REF = obj({
    'source_type': {'type': 'string', 'enum': [
        'review', 'diary', 'film', 'tag', 'list', 'finding', 'stats', 'rewatch', 'review_style'
    ]},
    'source_id': STRING,
    # Optional semantically, required structurally so provider schemas stay simple.
    # Use "" for non-review evidence. The backend resolves it against the original.
    'focus_text': STRING,
})
SEMANTIC_SCHEMA = obj({'semantic_findings': array(obj({
    'id': STRING,
    'type': {'type': 'string', 'enum': [
        'self_irony', 'semantic_contrast', 'review_spotlight', 'recurring_idea',
        'list_meaning', 'tag_meaning', 'meaningful_exception', 'rewatch_pattern',
        'logging_behavior'
    ]},
    'interestingness': {'type': 'number', 'minimum': 0, 'maximum': 1},
    'confidence': {'type': 'number', 'minimum': 0, 'maximum': 1},
    # Account observation must be grounded. cultural_angle may use stable cinema knowledge.
    'observation': STRING,
    'why_interesting': STRING,
    'cultural_angle': STRING,
    'evidence': array(REF, 10),
    'film_keys': array(STRING, 10),
    'related_tags': array(STRING, 6),
    'related_lists': array(STRING, 6),
}), 24)})

LINE_ITEM = {'type': 'object', 'properties': {
    'text': STRING,
    'effect': {'type': 'string', 'enum': ['none', 'strike', 'correction']},
}, 'required': ['text']}
FINAL_WRITER_SCHEMA = obj({
    'opening': {'type': 'object', 'properties': {
        'salutation': STRING,
        'archetype_concepts': array(STRING, 4),
        'archetype_phrase': STRING,
        'negative_adjective': STRING,
        'positive_adjective': STRING,
        'profile_reaction': {'type': 'array', 'items': LINE_ITEM, 'maxItems': 1},
    }, 'required': [
        'salutation', 'archetype_concepts', 'archetype_phrase', 'negative_adjective',
        'positive_adjective', 'profile_reaction'
    ], 'additionalProperties': False},
    'beats': array(obj({'beat_id': STRING, 'lines': array(LINE_ITEM, 4)}), 16),
    'closer': {'type': 'object', 'properties': {
        'lines': {'type': 'array', 'items': LINE_ITEM, 'maxItems': 4},
    }, 'required': ['lines'], 'additionalProperties': False},
})


def wire_schema(schema: dict) -> dict:
    """Keep provider grammar small; enforce bounds again locally."""
    def simplify(value: Any) -> Any:
        if isinstance(value, dict):
            return {k: simplify(v) for k, v in value.items()
                    if k not in {'maxItems', 'additionalProperties', 'minimum', 'maximum'}}
        if isinstance(value, list):
            return [simplify(v) for v in value]
        return value
    return simplify(schema)
