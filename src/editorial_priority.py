"""Editorial priority helpers kept separate from selection mechanics."""

CLOSER_PRIORITY = {
    'self_irony': 5,
    'meaningful_exception': 4,
    'logging_behavior': 4,
    'review_spotlight': 3,
    'semantic_contrast': 2,
    'rewatch_pattern': 2,
    'list_meaning': 1,
    'tag_meaning': 1,
    'recurring_idea': 1,
}


def closer_key(item: dict) -> tuple[float, float]:
    return (
        float(CLOSER_PRIORITY.get(item.get('type'), 0)),
        float(item.get('score', 0)) * float(item.get('confidence', 0)),
    )
