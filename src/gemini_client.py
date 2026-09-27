"""SDK calls: retry transient errors, fall back to another model, allowlisted error metadata."""
from typing import Any, Callable

from .ai_schemas import FINAL_WRITER_SCHEMA, SEMANTIC_SCHEMA, wire_schema

# Retried inside a single call by the SDK; mirrors the SDK defaults plus 5xx.
RETRYABLE_CODES = [408, 429, 500, 502, 503, 504]
# Codes where the next configured model deserves a single attempt instead of failing the stage.
FALLBACK_CODES = (404, 429, 500, 502, 503, 504)


def make_request(model: str, system: str, message: str, temperature: float, stage: str,
                 fallback_models: tuple[str, ...] = ()) -> dict:
    return {'model': model, 'fallback_models': list(fallback_models), 'contents': message, 'config': {
        'system_instruction': system, 'temperature': temperature,
        'automatic_function_calling': {'disable': True},
        'response_mime_type': 'application/json',
        'response_json_schema': wire_schema(SEMANTIC_SCHEMA if stage == 'analyst' else FINAL_WRITER_SCHEMA)}}


def models_for(request: dict) -> list[str]:
    """Configured model first, then each distinct fallback, preserving order."""
    chain = [request['model']]
    for model in request.get('fallback_models') or []:
        if isinstance(model, str) and model.strip() and model not in chain:
            chain.append(model)
    return chain


def _call(api_key: str, model: str, request: dict[str, Any]) -> tuple[str, dict]:
    from google import genai
    from google.genai import types

    with genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=120_000,
            retry_options=types.HttpRetryOptions(attempts=3, initial_delay=1, max_delay=8,
                                                http_status_codes=RETRYABLE_CODES))) as client:
        response = client.models.generate_content(
            model=model, contents=request['contents'],
            config=types.GenerateContentConfig(**request['config']))
        return response.text or '', response.model_dump(mode='json', exclude_none=True)


def _generate(api_key: str, request: dict[str, Any], note: Callable[[str], None] | None = None) -> tuple[str, dict]:
    """Use the configured model, then each fallback, and disclose which one answered."""
    chain = models_for(request)
    attempts: list[dict] = []
    for position, model in enumerate(chain):
        try:
            raw, response = _call(api_key, model, request)
        except Exception as exc:
            info = error_info(exc)
            attempts.append({'model': model, 'code': info.get('code'), 'reason': info.get('reason')})
            if info.get('code') in FALLBACK_CODES and position + 1 < len(chain):
                if note:
                    note(f"Gemini HTTP {info.get('code')} no modelo {model}; tentando {chain[position + 1]}.")
                continue
            try:
                exc.attempted_models = attempts
            except AttributeError:
                pass
            raise
        response['served_model'] = model
        if attempts:
            response['model_attempts'] = attempts
            if note:
                note(f'Resposta obtida com o modelo de reserva {model}.')
        return raw, response
    raise RuntimeError('Nenhum modelo disponível na corrente configurada.')


def analyze_semantically(api_key: str, request: dict[str, Any],
                         note: Callable[[str], None] | None = None) -> tuple[str, dict]:
    return _generate(api_key, request, note)


def write_final(api_key: str, request: dict[str, Any],
                note: Callable[[str], None] | None = None) -> tuple[str, dict]:
    """The single Final Writer call: every moment in one request."""
    return _generate(api_key, request, note)


def list_models(api_key: str) -> list[dict]:
    """Official models.list discovery, once per run; metadata only."""
    from google import genai

    with genai.Client(api_key=api_key) as client:
        return [entry.model_dump(mode='json', exclude_none=True) for entry in client.models.list()]


def error_info(exc: Exception) -> dict:
    """Persist only allowlisted error metadata, never raw exception/request text."""
    code = getattr(exc, 'code', None)
    info = {'type': type(exc).__name__, 'code': code}
    attempts = getattr(exc, 'attempted_models', None)
    if isinstance(attempts, list) and attempts:
        info['attempted_models'] = [{'model': str(item.get('model')), 'code': item.get('code'),
                                     'reason': str(item.get('reason'))}
                                    for item in attempts if isinstance(item, dict)]
    if code == 429:
        info['reason'] = 'rate_limit_or_quota_exhausted'
        info['message'] = ('Gemini HTTP 429: limite de uso/cota atingido. Não houve resposta desta chamada. '
                           'Consulte os limites do projeto em https://aistudio.google.com/usage?tab=rate-limit. '
                           'Tente novamente quando houver cota disponível; repetir agora pode continuar falhando.')
        info['hint'] = ('Cota por dia (RPD) renova à meia-noite do Pacífico — 04h em Brasília. Se o limite for por '
                        'minuto, espere um pouco. Alternativas: definir GEMINI_FALLBACK_MODELS no .env '
                        '(ex.: gemini-flash-lite-latest; nome indisponível responde 404 e a cadeia segue), '
                        'reduzir SCRIPT_MAX_BEATS e/ou rodar com --no-analyst.')
    else:
        info['reason'] = 'api_failure'
        info['message'] = f'Gemini falhou ({type(exc).__name__}, HTTP {code}); a chamada não produziu resposta.'
        if code in (401, 403):
            info['hint'] = 'Credencial recusada: confira GEMINI_API_KEY no .env do projeto.'
        elif code == 404:
            info['hint'] = 'Modelo indisponível para esta credencial: ajuste GEMINI_MODEL ou GEMINI_FALLBACK_MODELS.'
    body = getattr(exc, 'details', {})
    details = body.get('error', body).get('details', []) if isinstance(body, dict) else []
    for detail in details if isinstance(details, list) else []:
        if not isinstance(detail, dict):
            continue
        delay = detail.get('retryDelay')
        if isinstance(delay, str) and delay.rstrip('s').replace('.', '', 1).isdigit():
            info['retry_after_seconds_hint'] = float(delay.rstrip('s'))
        for violation in detail.get('violations', []):
            quota = violation.get('quotaId', '') if isinstance(violation, dict) else ''
            if 'PerDay' in quota:
                info['limit_window'] = 'day'
            elif 'PerMinute' in quota and info.get('limit_window') != 'day':
                info['limit_window'] = 'minute'
    return info
