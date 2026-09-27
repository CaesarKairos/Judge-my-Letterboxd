"""Auditable Analyst -> validation -> pool -> script -> per-beat Writer pipeline."""
from dataclasses import dataclass
import json
import os
from pathlib import Path
from typing import Callable

from .ai_schemas import ANALYST_PROMPT_VERSION, WRITER_PROMPT_VERSION
from .context_builder import build_context, build_dataset, film_ids
from .finding_pool import build_pool
from .gemini_client import analyze_semantically, error_info, make_request, write_beat
from .models import Finding, UserProfile
from .script_engine import build_script, writer_input
from .utils import dumps
from .validator import validate_semantic_findings, validate_writer
from .run_storage import cache_response, no_judgment, read_cached


@dataclass
class GenerationConfig:
    model: str = 'gemini-flash-latest'
    language: str = 'pt-BR'
    max_context: int = 300000
    max_beats: int = 10
    writer_max_context: int = 16000
    max_lines: int = 3
    max_words: int = 24
    analyst_temperature: float = .2
    writer_temperature: float = .7
    fallback_models: tuple[str, ...] = ()

    @classmethod
    def from_env(cls) -> 'GenerationConfig':
        config = cls(os.getenv('GEMINI_MODEL', 'gemini-flash-latest'), os.getenv('JUDGE_LANGUAGE', 'pt-BR'),
                     int(os.getenv('MAX_CONTEXT_CHARS', '300000')), int(os.getenv('SCRIPT_MAX_BEATS', '10')),
                     int(os.getenv('WRITER_MAX_CONTEXT_CHARS', '16000')), int(os.getenv('WRITER_MAX_LINES', '3')),
                     int(os.getenv('WRITER_MAX_WORDS_PER_LINE', '24')), float(os.getenv('ANALYST_TEMPERATURE', '.2')),
                     float(os.getenv('WRITER_TEMPERATURE', '.7')), fallback_models())
        if not 1 <= config.max_beats <= 12 or not 1 <= config.max_lines <= 3 or not 2 <= config.max_words <= 40:
            raise ValueError('Limites inválidos: beats 1–12; linhas 1–3; palavras 2–40.')
        if not 0 <= config.analyst_temperature <= 2 or not 0 <= config.writer_temperature <= 2:
            raise ValueError('Temperaturas devem estar entre 0 e 2.')
        return config


def fallback_models() -> tuple[str, ...]:
    """GEMINI_FALLBACK_MODELS (vírgula ou espaço) sem repetir o modelo principal."""
    declared = os.getenv('GEMINI_FALLBACK_MODELS', '') or os.getenv('GEMINI_FALLBACK_MODEL', '')
    seen = {os.getenv('GEMINI_MODEL', 'gemini-flash-latest').strip()}
    models = []
    for candidate in declared.replace(',', ' ').split():
        if candidate not in seen:
            seen.add(candidate)
            models.append(candidate)
    return tuple(models)


def failure_hint(code: int | None) -> str:
    if code == 429:
        return ('Cota esgotada não se recupera repetindo agora: aguarde o RPD renovar (meia-noite do Pacífico, '
                '04h em Brasília), defina GEMINI_FALLBACK_MODELS no .env ou rode --no-analyst.')
    if code in (401, 403):
        return 'Credencial recusada: confira GEMINI_API_KEY no .env do projeto.'
    return ''


def reason_with_hint(problem: dict, fallback: str) -> str:
    """Mensagem do erro mais a dica acionável quando não existe problema registrado."""
    if not problem:
        return fallback
    message = problem.get('message', fallback)
    hint = problem.get('hint', '')
    return f'{message}\n{hint}' if hint else message


def save(path: Path, value: object) -> None:
    path.write_text(dumps(value), encoding='utf-8', newline='')


def generate(profile: UserProfile, analysis: dict, findings: list[Finding], root: Path, config: GenerationConfig,
             api_key: str, dry_run: bool, analyze_only: bool, skip_analyst: bool,
             report: Callable[[str], None]) -> tuple[dict, str, bool]:
    output = root / 'output'
    analyst_prompt = (root / 'prompts' / 'analyst.txt').read_text(encoding='utf-8')
    writer_prompt = (root / 'prompts' / 'writer.txt').read_text(encoding='utf-8')
    context, message = build_context(profile, analysis, findings, analyst_prompt, config.max_context, config.language)
    full_dataset = build_dataset(profile, analysis, findings, config.language)
    save(output / 'ai_id_map.json', film_ids(profile))
    (output / 'ai_context.json').write_text(message, encoding='utf-8', newline='')
    request = make_request(config.model, analyst_prompt, message, config.analyst_temperature, 'analyst',
                           config.fallback_models)
    save(output / 'ai_request.json', request)
    state = {'status': 'running', 'analyst': 'pending', 'writer': 'pending',
             'judgment_generated': False,
             'model': config.model, 'fallback_models': list(config.fallback_models),
             'prompt_versions': {'analyst': ANALYST_PROMPT_VERSION, 'writer': WRITER_PROMPT_VERSION}}
    status_path = output / 'run_status.json'
    if status_path.exists():
        state['previous_run'] = json.loads(status_path.read_text(encoding='utf-8')).get('previous_run')
    save(output / 'run_status.json', state)
    report(f"Contexto Analyst: {len(analyst_prompt) + len(message):,} caracteres; "
           f"{len(context['reviews'])}/{len(profile.reviews)} reviews.")
    semantic, rejected = [], []
    failed = False
    if dry_run or not api_key:
        state['analyst'] = 'skipped'
        state['gemini'] = 'skipped'
        state['reason'] = '--dry-run' if dry_run else 'GEMINI_API_KEY não configurada'
        report(f"IA pulada: {state['reason']}.")
    elif skip_analyst:
        state['analyst'] = 'skipped_by_flag'
        state['analyst_skip_reason'] = ('--no-analyst: etapa semântica desativada; o roteiro usa apenas '
                                        'findings determinísticos medidos localmente.')
        report(f"Analyst pulado: {state['analyst_skip_reason']}")
    else:
        state['analyst'] = 'running'
        save(output / 'run_status.json', state)
        report('AI Analyst: examinando evidências...')
        try:
            cached = read_cached(output, 'analyst', request)
            raw, response = cached or analyze_semantically(api_key, request, report)
            state['analyst_response_origin'] = 'cache' if cached else 'api'
            if cached:
                report('Analyst: resposta local reaproveitada para o mesmo pedido, sem consumir nova chamada.')
            if response.get('served_model'):
                state['analyst_model'] = response['served_model']
            if response.get('model_attempts'):
                state['analyst_model_attempts'] = response['model_attempts']
            save(output / 'ai_response.json', response)
            save(output / 'analyst_response.json', {'prompt_version': ANALYST_PROMPT_VERSION, 'raw_response': raw})
            semantic, rejected = validate_semantic_findings(raw, context)
            if semantic or not rejected:
                cache_response(output, 'analyst', request, raw, response)
            state['analyst'] = 'validated' if not rejected else 'validated_with_rejections'
            if rejected and not semantic:
                failed = True
                state['analyst'] = 'all_candidates_rejected'
        except Exception as exc:
            state['analyst'] = 'failed'
            state['analyst_error_type'] = type(exc).__name__
            state['analyst_error_code'] = getattr(exc, 'code', None)
            state['error'] = error_info(exc)
            failed = True
            report(state['error']['message'])
            report('Sem resposta do Analyst, o Writer não foi chamado. O roteiro local não é um julgamento.')
            if state['error'].get('hint'):
                report(state['error']['hint'])
    save(output / 'semantic_findings.json', semantic)
    save(output / 'semantic_validation.json', {'prompt_version': ANALYST_PROMPT_VERSION, 'rejected': rejected,
                                              'accepted_count': len(semantic), 'status': state['analyst']})
    pool = build_pool(full_dataset, semantic)
    save(output / 'finding_pool.json', pool)
    # Reserve overhead for instructions and structured fields; final request is checked again.
    evidence_budget = max(0, config.writer_max_context - len(writer_prompt) - 1800)
    script = build_script(pool, analysis['overview'], config.max_beats, evidence_budget)
    script['prompt_versions'] = state['prompt_versions']
    save(output / 'script.json', script)
    inputs, judgments = [], []
    for beat in script['beats']:
        payload = writer_input(beat, config.language, config.max_lines, config.max_words)
        writer_message = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
        writer_request = make_request(config.model, writer_prompt, writer_message, config.writer_temperature, 'writer',
                                      config.fallback_models)
        inputs.append({'beat_id': beat['id'], 'writer_mode': beat['writer_mode'], 'prompt_version': WRITER_PROMPT_VERSION,
                       'evidence': payload['evidence'], 'previous_context': payload['previous_context'],
                       'request': writer_request, 'request_chars': len(writer_prompt) + len(writer_message),
                       'raw_response': None, 'parsed_lines': [], 'accepted_lines': [], 'errors': [], 'status': 'prepared'})
    save(output / 'writer_inputs.json', inputs)
    save(output / 'judgment.json', {'beats': judgments, 'prompt_versions': state['prompt_versions']})
    report(f"Analyst: {len(semantic)} candidatos aceitos, {len(rejected)} rejeitados. Roteiro: {len(script['beats'])} beats.")
    if dry_run or not api_key or analyze_only or state['analyst'] == 'failed':
        for audit in inputs:
            audit['status'] = 'skipped'
        save(output / 'writer_inputs.json', inputs)
        state['writer'] = 'skipped'
        state['status'] = 'analysis_complete' if not failed else 'analysis_partial'
        reason = (reason_with_hint(state.get('error', {}), 'Writer não executado.') if 'error' in state else
                  'Modo --analyze-only: geração do Writer desativada.' if analyze_only and not dry_run else
                  state.get('reason', 'Writer não executado.'))
        state['writer_skip_reason'] = reason
        no_judgment(output, reason)
        save(output / 'judgment.json', {'status': 'not_generated', 'reason': reason, 'beats': [],
                                      'prompt_versions': state['prompt_versions']})
        report('Nenhum julgamento novo. judgment.txt contém a explicação; script.json contém somente o roteiro.')
        save(output / 'run_status.json', state)
        save(output / 'debug_report.txt', {'inventory': profile.inventory, 'warnings': profile.warnings, 'coverage': context['coverage'], 'run': state})
        return script, '', failed
    state['writer'] = 'running'
    save(output / 'run_status.json', state)
    emitted: set[str] = set()
    blocked_code: int | None = None
    for beat, audit in zip(script['beats'], inputs):
        request = audit['request']
        report(f"Writer {beat['position']}/{len(script['beats'])}: {beat['beat_type']} ({audit['request_chars']:,} caracteres)")
        lines = []
        if blocked_code is not None:
            audit.update(status='skipped', errors=['previous API failure prevents further calls'], error_code=blocked_code)
        elif audit['request_chars'] > config.writer_max_context:
            audit.update(status='rejected', errors=['request exceeds writer budget'])
        else:
            try:
                cached = read_cached(output, 'writer', request)
                raw, response = cached or write_beat(api_key, request, report)
                audit['response_origin'] = 'cache' if cached else 'api'
                audit.update(raw_response=raw, sdk_response=response)
                if response.get('served_model'):
                    audit['served_model'] = response['served_model']
                if response.get('model_attempts'):
                    audit['model_attempts'] = response['model_attempts']
                try:
                    parsed_response = json.loads(raw)
                    if isinstance(parsed_response, dict) and isinstance(parsed_response.get('lines'), list):
                        audit['parsed_lines'] = parsed_response['lines']
                except ValueError:
                    pass
                lines, errors = validate_writer(raw, beat, config.max_lines, config.max_words)
                if not errors:
                    cache_response(output, 'writer', request, raw, response)
                audit.update(errors=errors, status='validated' if not errors else 'rejected')
                # A linha que apenas repete o display do próprio beat sai do texto, mas fica registrada.
                displayed = {line.strip().casefold() for line in beat['display']['lines'] if line.strip()}
                repeats = [line for line in lines if line.strip().casefold() in displayed]
                if repeats:
                    lines = [line for line in lines if line.strip().casefold() not in displayed]
                    audit['dropped_display_repeats'] = repeats
                # Reject duplicate generated lines across beats without hiding the raw response.
                if any(line.strip().casefold() in emitted for line in lines):
                    audit.update(status='rejected', errors=['duplicate line from earlier beat'])
                    lines = []
            except Exception as exc:
                audit.update(status='failed', errors=[type(exc).__name__], error_code=getattr(exc, 'code', None))
                audit['error_details'] = error_info(exc)
                state['error'] = audit['error_details']
                report(audit['error_details']['message'])
                if getattr(exc, 'code', None) in (401, 403, 429):
                    blocked_code = exc.code
                    report(f'Gemini HTTP {blocked_code}: chamadas restantes puladas; resultados já obtidos preservados.')
                    hint = failure_hint(blocked_code)
                    if hint:
                        report(hint)
        if audit['status'] != 'validated':
            failed = True
        audit['accepted_lines'] = lines
        emitted.update(line.strip().casefold() for line in lines)
        judgments.append({'beat_id': beat['id'], 'finding_ids': beat['finding_ids'], 'beat_type': beat['beat_type'],
                          'display_lines': beat['display']['lines'], 'lines': lines, 'status': audit['status']})
        save(output / 'writer_inputs.json', inputs)
        save(output / 'judgment.json', {'beats': judgments, 'prompt_versions': state['prompt_versions']})
        text = '\n\n'.join('\n'.join(j['display_lines'] + j['lines']) for j in judgments if j['display_lines'] or j['lines'])
        (output / 'judgment.txt').write_text(text, encoding='utf-8', newline='')
    state.update(status='partial' if failed else 'complete', writer='partial' if failed else 'complete')
    state['judgment_generated'] = any(j['status'] == 'validated' for j in judgments)
    if not state['judgment_generated']:
        reason = reason_with_hint(state.get('error', {}), 'Nenhuma resposta do Writer passou na validação.')
        no_judgment(output, reason)
        report('Nenhum julgamento foi gerado; judgment.txt explica o motivo.')
    save(output / 'run_status.json', state)
    save(output / 'debug_report.txt', {'inventory': profile.inventory, 'warnings': profile.warnings, 'coverage': context['coverage'], 'run': state})
    return script, (output / 'judgment.txt').read_text(encoding='utf-8') if state['judgment_generated'] else '', failed
