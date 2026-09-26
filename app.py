"""Terminal entry point: parse -> analyze -> evidence -> context -> optional Gemini."""
import argparse
from dataclasses import asdict
import os
from pathlib import Path
import sys
from zipfile import BadZipFile

from src.analyzer import analyze
from src.context_builder import build_context
from src.findings import build_findings
from src.gemini_client import generate_judgment
from src.parser import read_export
from src.utils import dumps

ROOT = Path(__file__).resolve().parent


def choose_zip(directory: Path) -> Path | None:
    files = sorted(p for p in directory.iterdir() if p.is_file() and p.suffix.casefold() == '.zip')
    if not files:
        print('Nenhum ZIP encontrado na pasta atual. Coloque aqui seu export do Letterboxd.')
        return None
    if len(files) == 1:
        return files[0]
    for index, path in enumerate(files, 1):
        print(f'{index}. {path.name}')
    while True:
        try:
            selected = int(input('Escolha o número do ZIP (Ctrl+C para sair): '))
            if 1 <= selected <= len(files):
                return files[selected - 1]
        except ValueError:
            pass
        print('Seleção inválida.')


def save_json(path: Path, value: object) -> None:
    path.write_text(dumps(value), encoding='utf-8', newline='')


def run() -> int:
    parser = argparse.ArgumentParser(description='Judge My Letterboxd — Backend Prototype')
    parser.add_argument('--dry-run', action='store_true', help='Analisa e gera debug sem chamar Gemini')
    parser.add_argument('--show-findings', action='store_true', help='Mostra todos os findings')
    args = parser.parse_args()
    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / '.env')
    except ImportError:
        print('python-dotenv não instalado: usando somente variáveis de ambiente do sistema.')
    print('Judge My Letterboxd — Backend Prototype\n')
    path = choose_zip(Path.cwd())
    if path is None:
        return 0
    output = ROOT / 'output'
    output.mkdir(exist_ok=True)
    # Clear only known generated files, so a failed run cannot expose stale results as new.
    for name in ('profile_summary.json', 'extracted_profile.json', 'findings.json', 'ai_context.json',
                 'ai_request.json', 'ai_response.json', 'judgment.txt', 'debug_report.txt', 'run_status.json'):
        (output / name).unlink(missing_ok=True)
    (output / 'judgment.txt').write_text('', encoding='utf-8')
    save_json(output / 'run_status.json', {'status': 'started'})
    print(f'ZIP encontrado: {path.name}\nLendo export...')
    profile = read_export(path)
    for item in profile.inventory:
        if item['status'] == 'read':
            print(f"  OK {item['file']}")
    analysis = analyze(profile)
    findings = build_findings(profile, analysis)
    save_json(output / 'extracted_profile.json', asdict(profile))
    save_json(output / 'profile_summary.json', analysis)
    save_json(output / 'findings.json', [asdict(f) for f in findings])
    overview = analysis['overview']
    print('\nPerfil:')
    for key, label in [('watched_films', 'filmes vistos'), ('rated_films', 'ratings'),
                       ('diary_entries', 'sessões'), ('reviews', 'reviews'), ('watchlist', 'filmes na watchlist'),
                       ('explicit_rewatches', 'rewatches explícitos'), ('own_lists', 'listas próprias'),
                       ('liked_films', 'filmes curtidos'), ('liked_reviews', 'reviews curtidas'), ('liked_lists', 'listas curtidas')]:
        print(f'  {overview[key]} {label}')
    print(f"  {len(analysis['tags'])} tags distintas\n\nFindings detectados: {len(findings)}")
    for i, finding in enumerate(findings if args.show_findings else findings[:5], 1):
        print(f'{i}. [{finding.score}] {finding.summary}')
    system = (ROOT / 'prompts' / 'judge.txt').read_text(encoding='utf-8')
    context, message = build_context(profile, analysis, findings, system,
                                     int(os.getenv('MAX_CONTEXT_CHARS', '300000')), os.getenv('JUDGE_LANGUAGE', 'pt-BR'))
    (output / 'ai_context.json').write_text(message, encoding='utf-8', newline='')
    request = {'model': os.getenv('GEMINI_MODEL', 'gemini-flash-latest'), 'contents': message,
               'config': {'system_instruction': system, 'temperature': .8}}
    save_json(output / 'ai_request.json', request)
    print(f'\nContexto preparado: {len(message) + len(system)} caracteres (dados + prompt).')
    print(f"Reviews incluídas: {context['coverage']['included']['reviews']}/{len(profile.reviews)}")
    report = {'inventory': profile.inventory, 'warnings': profile.warnings, 'coverage': context['coverage'],
              'privacy': 'profile.csv: only Favorite Films retained; local original texts may contain personal data',
              'sources_present': [i['file'] for i in profile.inventory if i['status'] == 'read']}
    (output / 'debug_report.txt').write_text(dumps(report), encoding='utf-8')
    key = os.getenv('GEMINI_API_KEY', '').strip()
    if args.dry_run or not key:
        reason = '--dry-run' if args.dry_run else 'GEMINI_API_KEY não configurada'
        print(f'Gemini pulado: {reason}. Análise local concluída.')
        save_json(output / 'run_status.json', {'status': 'local_complete', 'gemini': 'skipped', 'reason': reason})
    else:
        print('Enviando para Gemini...')
        try:
            judgment, response = generate_judgment(key, request)
            save_json(output / 'ai_response.json', response)
            (output / 'judgment.txt').write_text(judgment, encoding='utf-8', newline='')
            save_json(output / 'run_status.json', {'status': 'complete' if judgment else 'empty_response'})
            print('\n────────────────────────────\nJUDGMENT\n────────────────────────────')
            print(judgment, end='')
            print('\n────────────────────────────')
            if not judgment:
                print('Gemini não retornou texto. Consulte ai_response.json.')
        except Exception as exc:
            # SDK messages may include request text or credentials: never persist str(exc).
            save_json(output / 'run_status.json', {'status': 'gemini_failed', 'error_type': type(exc).__name__})
            print(f'Falha no Gemini ({type(exc).__name__}). Verifique chave, modelo e conexão. Análise local preservada.')
            return 1
    print('\nArquivos de debug salvos em output/')
    return 0


def main() -> int:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    try:
        return run()
    except (KeyboardInterrupt, EOFError):
        print('\nExecução cancelada.')
        return 130
    except (OSError, BadZipFile, ValueError, RuntimeError) as exc:
        print(f'Não foi possível concluir a análise local ({type(exc).__name__}): {exc}')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
