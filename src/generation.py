"""Auditable pipeline: Analyst -> Editorial Moments -> Script Engine -> one Final Writer -> Presentation."""
import json
from pathlib import Path
from typing import Callable

from .ai_schemas import ANALYST_PROMPT_VERSION, WRITER_PROMPT_VERSION
from .config_v2 import GenerationConfig
from .context_builder import build_context, build_dataset, film_ids
from .final_writer_v2 import validate_final_writer
from .finding_pool import build_pool
from .gemini_client import analyze_semantically, error_info, list_models, make_request, write_final
from .model_discovery import build_chain, partition, record as discovery_record
from .models import Finding, UserProfile
from .opening import build_events as build_opening_events
from .opening import build_plan
from .presentation import build_presentation, script_text, validate_presentation
from .resources import bundle
from .run_quality import analyst_quality, writer_quality
from .run_storage import cache_response, no_judgment, read_cached
from .script_engine import build_script, final_writer_input
from .utils import dumps
from .semantic_validator import validate_semantic_findings

ARCHETYPE_FILMS = 4


def failure_hint(code: int | None) -> str:
    if code == 429:
        return ('Cota esgotada não se recupera repetindo agora: aguarde o limite renovar ou configure '
                'GEMINI_ANALYST_FALLBACK_MODELS / GEMINI_WRITER_FALLBACK_MODELS. Flash-Lite fica por último.')
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


def top_four_favorites(profile: UserProfile, ids: dict[str, str]) -> list[dict]:
    """The four favorite films, in export order. Short IDs keep the writer payload consistent."""
    chosen: list[dict] = []
    seen: set[str] = set()
    for favorite in profile.favorites:
        for key in favorite.get('film_keys', []):
            if key in seen or len(chosen) >= ARCHETYPE_FILMS:
                continue
            seen.add(key)
            film = profile.films[key]
            chosen.append({'film_key': ids.get(key, key), 'title': film.name, 'year': film.year,
                           'tags': film.tags[:6]})
    return chosen


def save(path: Path, value: object) -> None:
    path.write_text(dumps(value), encoding='utf-8', newline='')



def generate(profile: UserProfile, analysis: dict, findings: list[Finding], raw_export: dict,
             root: Path, config: GenerationConfig,
             api_key: str, dry_run: bool, analyze_only: bool, skip_analyst: bool,
             report: Callable[[str], None]) -> tuple[dict, str, bool]:
    """Two AI calls at most: one Analyst, one Final Writer. Everything else is local and auditable."""
    output = root / 'output'
    locale = bundle(config.language)
    analyst_prompt = (root / 'prompts' / 'analyst.txt').read_text(encoding='utf-8')
    writer_prompt = (root / 'prompts' / 'writer.txt').read_text(encoding='utf-8')
    context, message = None, ''
    context_error = ''
    try:
        context, message = build_context(profile, analysis, findings, analyst_prompt, config.max_context,
                                         config.language, raw_export if config.include_raw_export else None)
    except ValueError as exc:
        # Explicit, never silent: the run continues, but with structural content only.
        context_error = str(exc)
        report(context_error)
        report('Sem contexto dentro do orçamento, o Analyst não é chamado; o roteiro local é preservado.')
    # The pool/validator only needs the normalized evidence index; raw_export is already
    # present in the Analyst request and is intentionally not duplicated here.
    full_dataset = build_dataset(profile, analysis, findings, config.language)
    ids = film_ids(profile)
    save(output / 'ai_id_map.json', ids)

    # Discover text models ONCE, before either AI stage, then build independent
    # quality-ranked chains for Analyst and Writer.
    discovered, rejected_models = [], []
    discovery_state: dict = {'status': 'skipped', 'source': 'disabled'}
    if api_key and not dry_run and not context_error and not skip_analyst and config.discover_models:
        try:
            listing = list_models(api_key)
            discovered, rejected_models = partition(listing)
            discovery_state = {'status': 'ok', 'source': 'api', 'listed': len(listing), 'usable': len(discovered)}
            report(f"Descoberta de modelos: {len(discovered)} utilizáveis de {len(listing)} listados.")
        except Exception as exc:
            discovery_state = {'status': 'failed', 'source': 'api', **error_info(exc)}
            report(f"Descoberta de modelos indisponível: {discovery_state.get('message', '')}".strip())

    analyst_chain, analyst_dupes = build_chain(
        config.analyst_model, list(config.analyst_fallback_models), discovered
    )
    writer_chain, writer_dupes = build_chain(
        config.writer_model, list(config.writer_fallback_models), discovered
    )
    rejected_models = list(rejected_models) + analyst_dupes + writer_dupes

    if not context_error:
        (output / 'ai_context.json').write_text(message, encoding='utf-8', newline='')
        request = make_request(
            analyst_chain[0], analyst_prompt, message, config.analyst_temperature,
            'analyst', tuple(analyst_chain[1:])
        )
        save(output / 'ai_request.json', request)
    else:
        request = None
    state: dict = {'status': 'running', 'analyst': 'pending', 'writer': 'pending', 'judgment_generated': False,
                   'analyst_model': config.analyst_model, 'writer_model': config.writer_model,
                   'analyst_fallback_models': list(config.analyst_fallback_models),
                   'writer_fallback_models': list(config.writer_fallback_models),
                   'locale': locale.locale, 'calls': 0,
                   'prompt_versions': {'analyst': ANALYST_PROMPT_VERSION, 'writer': WRITER_PROMPT_VERSION}}
    status_path = output / 'run_status.json'
    if status_path.exists():
        state['previous_run'] = json.loads(status_path.read_text(encoding='utf-8')).get('previous_run')
    save(output / 'run_status.json', state)
    if not context_error:
        source = (f"{context['coverage']['raw_export_files']} arquivos do ZIP bruto + índice normalizado"
                  if context['coverage']['raw_export_included'] else 'somente índice normalizado (ANALYST_RAW_EXPORT=0)')
        report(f"Contexto Analyst: {len(analyst_prompt) + len(message):,} caracteres; {source}; "
               f"{len(context['reviews'])}/{len(profile.reviews)} reviews; sem truncamento.")
    semantic, rejected, failed = [], [], False
    if context_error:
        state['analyst'] = 'failed'
        state['analyst_error_type'] = 'ContextBudgetExceeded'
        state['error'] = {'type': 'ContextBudgetExceeded', 'code': None, 'reason': 'context_too_large',
                          'message': context_error,
                          'hint': 'Aumente MAX_CONTEXT_CHARS no .env ou defina ANALYST_RAW_EXPORT=0 para enviar '
                                  'somente o índice normalizado.'}
        failed = True
        report(state['error']['hint'])
    elif dry_run or not api_key:
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
            state['calls'] += 0 if cached else 1
            state['analyst_response_origin'] = 'cache' if cached else 'api'
            if cached:
                report('Analyst: resposta local reaproveitada para o mesmo pedido, sem consumir nova chamada.')
            if response.get('served_model'):
                state['analyst_model'] = response['served_model']
                state['analyst_quality_degraded'] = 'lite' in response['served_model'].casefold()
                report(f"Analyst servido por {response['served_model']}"
                       f"{' [QUALIDADE DEGRADADA: Lite]' if state['analyst_quality_degraded'] else ''}.")
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
    quality = analyst_quality(analysis, semantic, rejected)
    save(output / 'quality_report.json', {'analyst': quality})
    report(f"Analyst: {quality['returned_candidates']} retornados; {quality['accepted_candidates']} aceitos; "
           f"{quality['rejected_candidates']} rejeitados; mínimo editorial {quality['required_semantic_candidates']}.")
    if state['analyst'] in {'validated', 'validated_with_rejections'} and not quality['passes']:
        state['analyst'] = 'insufficient_editorial_material'
        state['error'] = {
            'type': 'EditorialQualityGate',
            'code': None,
            'reason': 'insufficient_editorial_material',
            'message': 'O Analyst não produziu material semântico suficiente para um julgamento de qualidade.'
        }
        failed = True
    pool = build_pool(full_dataset, semantic)
    save(output / 'finding_pool.json', pool)
    # Counts are reported by the quality gate above.


    # Editorial Moments: selected and display-first, before any AI call.
    evidence_budget = max(0, config.writer_max_context - len(writer_prompt) - 4000)
    script = build_script(pool, config.max_beats, evidence_budget, locale,
                          semantic_only=quality['passes'])
    moments = script['moments']
    save(output / 'editorial_moments.json', {'count': len(moments), 'moments': moments,
                                             'selection': script['selection'], 'excluded': script['excluded'],
                                             'policy': script['policy']})
    closer = next((m for m in moments if m.get('role') == 'closer'), None)
    beats = [m for m in moments if m.get('role') != 'closer']
    save(output / 'script.json', script)
    semantic_moments = sum(moment.get('origin') == 'semantic' for moment in moments)
    deterministic_moments = len(moments) - semantic_moments
    report(f"Script: {semantic_moments} semantic; {deterministic_moments} fallback determinístico; "
           f"{len(moments)} momentos totais.")
    quality_path = output / 'quality_report.json'
    quality_payload = json.loads(quality_path.read_text(encoding='utf-8')) if quality_path.exists() else {}
    quality_payload['script'] = {
        'semantic_moments': semantic_moments,
        'deterministic_fallbacks': deterministic_moments,
        'total_moments': len(moments),
        'passes': semantic_moments >= quality.get('required_semantic_candidates', 2)
    }
    save(quality_path, quality_payload)
    if state['analyst'] in {'validated', 'validated_with_rejections'} and not quality_payload['script']['passes']:
        state['analyst'] = 'insufficient_editorial_material'
        state['error'] = {
            'type': 'EditorialQualityGate',
            'code': None,
            'reason': 'insufficient_editorial_moments',
            'message': 'Poucos momentos semânticos sobreviveram à seleção editorial.'
        }
        failed = True

    # Model discovery already ran once before the Analyst.
    chain = writer_chain
    state['analyst_model_chain'] = analyst_chain
    state['writer_model_chain'] = writer_chain
    discovery_payload = discovery_record(
        config.writer_model, list(config.writer_fallback_models), discovered,
        rejected_models, writer_chain, discovery_state
    )
    discovery_payload['analyst_chain'] = analyst_chain
    discovery_payload['writer_chain'] = writer_chain
    save(output / 'model_discovery.json', discovery_payload)
    plan = build_plan(profile, analysis['overview'], locale)
    top_four = top_four_favorites(profile, ids)
    plan['archetype_requested'] = len(top_four) == ARCHETYPE_FILMS
    plan['top_four_archetype']['requested'] = plan['archetype_requested']
    if plan['archetype_requested']:
        plan['top_four_archetype']['fallback_used'] = True
        plan['top_four_archetype']['issues'] = ['Writer archetype unavailable']
    trimmed: list[str] = []
    while True:
        payload = final_writer_input(
            beats, closer, plan, locale, top_four if plan['archetype_requested'] else [],
            config.max_lines, config.max_words, analysis.get('overview'),
            analysis.get('review_style'), analysis.get('review_coverage'), config.writer_acid_level
        )
        payload['opening_slots']['archetype']['enabled'] = plan['archetype_requested']
        save(output / 'editorial_dossier.json', {
            'top_four_films': payload.get('top_four_films', []),
            'editorial_dossier': payload.get('editorial_dossier', {}),
            'moments': payload.get('moments', []),
            'closer': payload.get('closer')
        })
        size = len(writer_prompt) + len(json.dumps(payload, ensure_ascii=False, separators=(',', ':')))
        if size <= config.writer_max_context or len(beats) <= 3:
            break
        trimmed.append(beats.pop()['beat_id'])
    writer_moment_count = len(beats) + (1 if closer else 0)
    minimum_writer_moments = quality.get('required_semantic_candidates', 2)
    if trimmed and writer_moment_count < minimum_writer_moments:
        state['analyst'] = 'insufficient_editorial_material'
        state['error'] = {
            'type': 'EditorialQualityGate',
            'code': None,
            'reason': 'writer_context_trimmed_too_far',
            'message': (
                f'O budget do Writer reduziria o roteiro para {writer_moment_count} momentos; '
                f'o mínimo editorial é {minimum_writer_moments}.'
            )
        }
        failed = True
        quality_path = output / 'quality_report.json'
        quality_payload = json.loads(quality_path.read_text(encoding='utf-8')) if quality_path.exists() else {}
        quality_payload['writer_context'] = {
            'moments_after_trimming': writer_moment_count,
            'minimum_required': minimum_writer_moments,
            'trimmed_moments': trimmed,
            'passes': False,
        }
        save(quality_path, quality_payload)

    writer_request = make_request(config.writer_model, writer_prompt,
                                  json.dumps(payload, ensure_ascii=False, separators=(',', ':')),
                                  config.writer_temperature, 'writer', tuple(chain[1:]))
    save(output / 'final_writer_request.json', {'payload': payload, 'request': writer_request, 'request_chars': size,
                                                'trimmed_moments': trimmed, 'model_chain': chain})
    report(f"Pedido do Writer único: {size:,} caracteres; {len(beats)} mids"
           f"{f', {len(trimmed)} removidos pelo orçamento' if trimmed else ''}.")

    # One Final Writer call for the whole script, or a structural-only presentation.
    result, entries, closer_entry = None, [], None
    audit: dict = {'status': 'skipped', 'errors': [], 'warnings': []}
    if dry_run or not api_key or analyze_only or state['analyst'] not in {'validated', 'validated_with_rejections'}:
        state['writer'] = 'skipped'
        state['writer_skip_reason'] = (reason_with_hint(state.get('error', {}), 'Writer não executado.') if 'error' in state
                                       else 'Modo --analyze-only: reação do Writer desativada.' if analyze_only and not dry_run
                                       else state.get('reason', 'Writer não executado.'))
        audit['reason'] = state['writer_skip_reason']
        report(f"Writer pulado: {state['writer_skip_reason']}")
    else:
        state['writer'] = 'running'
        save(output / 'run_status.json', state)
        report('AI Writer final: uma chamada para o roteiro inteiro...')
        try:
            cached = read_cached(output, 'writer', writer_request)
            raw, response = cached or write_final(api_key, writer_request, report)
            state['calls'] += 0 if cached else 1
            audit['response_origin'] = 'cache' if cached else 'api'
            audit['raw_response'] = raw
            if response.get('served_model'):
                audit['served_model'] = response['served_model']
            if response.get('model_attempts'):
                audit['model_attempts'] = response['model_attempts']
            result, errors = validate_final_writer(raw, beats, closer, plan, locale, analysis['overview'],
                                                   config.max_lines, config.max_words)
            audit['errors'] = errors
            if result is None:
                failed = True
                audit['status'] = 'rejected'
                state['error'] = {'type': 'ContractViolation', 'code': None, 'reason': 'final_writer_contract',
                                  'message': 'Resposta do Writer fora do contrato; nenhum texto foi aceito.'}
                report('Resposta do Writer fora do contrato: ' + '; '.join(errors[:3]))
            else:
                state['writer'] = 'complete'
                audit['status'] = 'validated'
                audit['warnings'] = result['warnings']
                audit['dropped_lines'] = result['dropped_lines']
                live_quality = writer_quality(result, audit.get('served_model'), beats)
                report(f"Writer: {audit.get('served_model') or 'modelo desconhecido'}; "
                       f"{live_quality['reaction_lines']} linhas; {live_quality['silent_moments']} momentos em silêncio"
                       f"{'; QUALIDADE DEGRADADA (Lite)' if live_quality['quality_degraded'] else ''}.")
                cache_response(output, 'writer', writer_request, raw, response)
                plan['salutation'] = result['opening']['salutation']
                plan['adjective_pair'] = result['opening']['adjective_pair']
                plan['archetype'] = result['opening']['archetype']
                plan['archetype_text'] = result['opening']['archetype_phrase'] if plan['archetype_requested'] else ''
                if plan['archetype_requested']:
                    plan['top_four_archetype'] = result['opening']['top_four_archetype']
                plan['profile_reaction'] = result['opening']['profile_reaction']
                for warning in result['warnings'][:3]:
                    report(f'Aviso do Writer: {warning}')
        except Exception as exc:
            state['error'] = error_info(exc)
            failed = True
            audit.update(status='failed', errors=[type(exc).__name__], error_code=getattr(exc, 'code', None),
                         error_details=state['error'])
            report(state['error']['message'])
            hint = failure_hint(getattr(exc, 'code', None))
            if hint:
                report(hint)
    lines = result['beats'] if result else {}
    for moment in beats:
        template = humor_entry(moment, locale, config)
        moment_lines = template['lines'] if template else lines.get(moment['beat_id'], [])
        entries.append({'moment': moment, 'lines': moment_lines,
                        'render_strategy': template['render_strategy'] if template else 'ai',
                        'source': template['source'] if template else ('ai' if result else 'none'),
                        'status': 'written' if moment_lines else 'silence'})
    if closer:
        closer_lines = result['closer'] if result else []
        closer_entry = {'moment': closer, 'lines': closer_lines, 'render_strategy': 'ai',
                        'source': 'ai' if result else 'none', 'status': 'written' if closer_lines else 'silence'}
    plan['opening_events'] = build_opening_events(plan, plan['archetype_text'] or None, plan['profile_reaction'], locale)
    writer_q = writer_quality(result, audit.get('served_model'), beats)
    prior_quality = json.loads((output / 'quality_report.json').read_text(encoding='utf-8')) if (output / 'quality_report.json').exists() else {}
    save(output / 'writer_quality.json', writer_q)
    save(output / 'quality_report.json', {**prior_quality, 'writer': writer_q, 'writer_style': writer_q})
    render = {'ai_generation': 'complete' if result else ('skipped' if audit['status'] == 'skipped' else 'failed'),
              'model': config.writer_model, 'served_model': audit.get('served_model'), 'fallback_models': chain[1:],
              'quality_degraded': writer_q['quality_degraded'],
              'human_templates': config.humor_templates}
    ai_meta = {'origin': audit.get('response_origin', 'none'), 'attempts': audit.get('model_attempts', []),
               'warnings': audit.get('warnings', []), 'calls': state['calls']}
    presentation = build_presentation(plan, entries, closer_entry, render, ai_meta, locale)
    presentation_errors = validate_presentation(presentation)
    if presentation_errors:
        failed = True
        state['presentation_errors'] = presentation_errors
    save(output / 'presentation_script.json', presentation)
    save(output / 'final_writer_response.json', {**audit, 'prompt_version': WRITER_PROMPT_VERSION,
                                                 'parsed': result, 'presentation_errors': presentation_errors})
    text = script_text(presentation)
    if render['ai_generation'] != 'complete':
        reason = state.get('writer_skip_reason') or state.get('error', {}).get('message', 'Sem reação de IA.')
        text = ('[SEM REAÇÃO DE IA NESTA EXECUÇÃO — a estrutura e os dados abaixo são do backend]\n'
                f'{reason}\nConsulte run_status.json; execuções anteriores em output/runs/.\n\n{text}')
    (output / 'judgment.txt').write_text(text, encoding='utf-8', newline='')
    ai_done = render['ai_generation'] == 'complete'
    state['status'] = ('context_too_large' if context_error else
                       'partial' if failed else ('complete' if ai_done else 'local_only'))
    state['writer'] = 'complete' if ai_done else state['writer']
    state['judgment_generated'] = ai_done
    save(output / 'run_status.json', state)
    save(output / 'debug_report.txt', {'inventory': profile.inventory, 'warnings': profile.warnings,
                                       'coverage': context['coverage'] if context else
                                       {'complete': False, 'truncated': False, 'raw_export_included': False,
                                        'reason': 'context_over_budget'},
                                       'model_discovery': discovery_payload,
                                       'render': render, 'run': state})
    return script, text, failed


def condition_matches(condition: str | None, moment: dict) -> bool:
    if condition in (None, 'always'):
        return True
    if condition == 'all_sessions_same_rating':
        ratings = [s.get('rating') for s in moment['display'].get('sessions') or []]
        return len(ratings) >= 2 and None not in ratings and len(set(ratings)) == 1
    return False


def humor_entry(moment: dict, locale, config: GenerationConfig) -> dict | None:
    """HUMAN_TEMPLATE moments are written by us, never by the AI, and are labelled as such."""
    if not config.humor_templates:
        return None
    for template in locale.human_templates(moment['moment_type']):
        if condition_matches(template.get('condition'), moment):
            return {'lines': [{'text': text, 'effect': 'none'} for text in template.get('lines', [])],
                    'render_strategy': 'human_template', 'source': f"human_template:{template['id']}"}
    return None
