"""Normalize candidates without erasing their origin or original measurements."""
from .semantic_validator import evidence_registry
from .utils import plain_text


def build_pool(dataset: dict, semantic: list[dict]) -> list[dict]:
    registry = evidence_registry(dataset)
    pool = []
    for finding in dataset['deterministic_findings']:
        evidence = [{'source_type': 'finding', 'source_id': finding['id'], 'data': finding}]
        # Small identity sample is explicit: the population remains in finding.film_keys.
        for fid in finding['film_keys'][:3]:
            if ('film', fid) in registry:
                evidence.append({'source_type': 'film', 'source_id': fid, 'data': registry[('film', fid)]})
        review_ids = list(finding['evidence'].get('review_ids', []))
        review_ids += [r['id'] for r in finding['evidence'].get('reviews', [])]
        for rid in list(dict.fromkeys(review_ids))[:2]:
            if ('review', rid) in registry:
                r = registry[('review', rid)]
                text = plain_text(r['text'])
                evidence.append({'source_type': 'review', 'source_id': rid,
                                 'data': {'id': rid, 'film_key': r['film_key'], 'review_rating': r['review_rating'],
                                          'excerpt': text[:700], 'excerpt_only': len(text) > 700}})
        tags = [finding['evidence'][k] for k in ('tag', 'a', 'b') if k in finding['evidence']]
        pool.append({'id': finding['id'], 'origin': 'deterministic', 'type': finding['type'],
                     'score': finding['score'], 'confidence': finding['confidence'], 'observation': finding['summary'],
                     'film_keys': finding['film_keys'], 'related_tags': tags, 'related_lists': [],
                     'evidence': evidence, 'sample_size': finding['sample_size']})
    for item in semantic:
        evidence = item['resolved_evidence'].copy()
        # Name/year resolution does not license uncited current ratings.
        for fid in item['film_keys']:
            source = registry[('film', fid)]
            if not any(e['source_type'] == 'film' and e['source_id'] == fid for e in evidence):
                evidence.append({'source_type': 'film_identity', 'source_id': fid,
                                 'data': {k: source[k] for k in ('key', 'name', 'year')}})
        pool.append({'id': item['id'], 'origin': 'semantic', 'type': item['type'],
                     'score': 100 * item['interestingness'], 'interestingness': item['interestingness'],
                     'confidence': item['confidence'], 'observation': item['observation'],
                     'why_interesting': item['why_interesting'], 'film_keys': item['film_keys'],
                     'related_tags': item['related_tags'], 'related_lists': item['related_lists'],
                     'evidence': evidence, 'sample_size': len(item['evidence'])})
    return sorted(pool, key=lambda f: (-f['score'] * f['confidence'], f['id']))
