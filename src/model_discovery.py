"""Dynamic model discovery through the official models.list API; no eternal hardcoded list."""
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Capabilities that cannot serve a text generateContent request with our structured output.
# models.list returns only name/version for this project, so the family filter is a documented
# heuristic; anything that slips through is caught by the runtime capability probe (404 -> next model).
EXCLUDED_TOKENS = ('embedding', 'tts', 'imagen', 'image', 'veo', 'live', 'native-audio', 'audio-dialog',
                   'whisper', 'speech', 'transcribe', 'lyria', 'nano-banana', 'banana', 'antigravity',
                   'computer-use', 'customtools', 'robotics', 'deep-research', 'aqa', 'realtime', 'clip')
# Discovered models are a short safety net, not an exhaustive ladder of guesses.
DISCOVERED_CHAIN_LIMIT = int(os.getenv('MODEL_DISCOVERY_CHAIN_LIMIT', '5'))
DISCOVERY_TTL_MINUTES = int(os.getenv('MODEL_DISCOVERY_TTL_MINUTES', '30'))


def model_id(entry: dict) -> str:
    return str(entry.get('name') or '').removeprefix('models/').strip()


def usable(entry: dict) -> tuple[bool, str]:
    """A model is usable only if it can serve generateContent text; everything else is recorded as rejected."""
    name = model_id(entry)
    if not name:
        return False, 'model sem nome'
    state = str(entry.get('state') or entry.get('lifecycleState') or '').casefold()
    if state in {'deprecated', 'shutdown', 'retired'}:
        return False, f'lifecycle {state}'
    lowered = name.casefold()
    for token in EXCLUDED_TOKENS:
        if token in lowered:
            return False, f'capacidade não textual ({token})'
    methods = entry.get('supportedGenerationMethods')
    if isinstance(methods, list) and methods and 'generateContent' not in methods:
        return False, 'não suporta generateContent'
    if isinstance(entry.get('outputTokenLimit'), int) and entry['outputTokenLimit'] <= 0:
        return False, 'sem limite de saída'
    return True, 'ok'


def rank(name: str) -> int:
    """Heuristic preference: stable text Flash first, then latest Flash, then Flash-Lite, then others."""
    lowered = name.casefold()
    if 'flash-lite' in lowered or 'flashlite' in lowered:
        score = 5
    elif 'flash' in lowered:
        score = 100
    elif 'pro' in lowered:
        score = 80
    else:
        score = 50
    if 'latest' in lowered:
        score += 10
    if 'preview' in lowered or 'experimental' in lowered or '-exp' in lowered:
        score -= 25
    if 'gemma' in lowered:
        score -= 15
    return score


def partition(models: list[dict]) -> tuple[list[str], list[dict]]:
    accepted, rejected = [], []
    for entry in models:
        ok, reason = usable(entry)
        (accepted if ok else rejected).append(model_id(entry) if ok else {'model': model_id(entry), 'reason': reason})
    return accepted, rejected


def build_chain(primary: str, configured: list[str], discovered: list[str],
                limit: int | None = None) -> tuple[list[str], list[dict]]:
    """Primary first; all remaining candidates are quality-ranked, with Lite last."""
    if limit is None:
        limit = int(os.getenv('MODEL_DISCOVERY_CHAIN_LIMIT', str(DISCOVERED_CHAIN_LIMIT)))
    rejected: list[dict] = []
    chain: list[str] = []
    combined = list(dict.fromkeys([*configured, *discovered]))
    ranked_all = sorted(combined, key=lambda n: (-rank(n), n))
    ranked = ranked_all[:max(0, limit)]
    rejected += [{'model': name, 'reason': f'fora do limite de {limit} modelos de reserva'}
                 for name in ranked_all[len(ranked):]]
    for name in [primary, *ranked]:
        if not name:
            continue
        if name in chain:
            if name != primary:
                rejected.append({'model': name, 'reason': 'duplicado na cadeia'})
            continue
        chain.append(name)
    return chain, rejected


def cached_discovery(output: Path) -> dict | None:
    """Optional short-lived local cache: metadata only, never a credential."""
    path = output / 'model_discovery.json'
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
        fetched = datetime.fromisoformat(data['fetched_at'])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if datetime.now(timezone.utc) - fetched > timedelta(minutes=DISCOVERY_TTL_MINUTES):
        return None
    return data


def record(primary: str, configured: list[str], discovered: list[str], rejected: list[dict], chain: list[str],
           discovery: dict) -> dict:
    return {'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
            'primary_model': primary, 'configured_fallbacks': configured,
            'discovered_models': sorted(discovered), 'rejected': rejected, 'chain': chain,
            'discovery': discovery}
