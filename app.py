"""Terminal orchestration; local measurements and AI stages remain separate."""
import argparse
from dataclasses import asdict
import os
from pathlib import Path
import sys
from zipfile import BadZipFile

from dotenv import load_dotenv
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from src.analyzer import analyze
from src.findings import build_findings
from src.generation import GenerationConfig, generate, save
from src.parser import read_export
from src.run_storage import archive_run, no_judgment

ROOT = Path(__file__).resolve().parent
console = Console(markup=False, highlight=False)
GENERATED = ('profile_summary.json', 'extracted_profile.json', 'raw_export.json', 'findings.json', 'deterministic_findings.json',
             'semantic_findings.json', 'semantic_validation.json', 'finding_pool.json', 'script.json',
             'writer_inputs.json', 'judgment.json', 'ai_context.json', 'ai_request.json', 'ai_response.json',
             'analyst_response.json', 'ai_id_map.json', 'judgment.txt', 'debug_report.txt', 'run_status.json')


def choose_zip(directory: Path) -> Path | None:
    files = sorted(p for p in directory.iterdir() if p.is_file() and p.suffix.casefold() == '.zip')
    if not files:
        console.print('Nenhum ZIP encontrado na pasta atual. Coloque aqui seu export do Letterboxd.', style='yellow')
        return None
    if len(files) == 1:
        return files[0]
    for index, path in enumerate(files, 1):
        console.print(f'{index}. {path.name}')
    while True:
        try:
            selected = int(input('Escolha o número do ZIP (Ctrl+C para sair): '))
            if 1 <= selected <= len(files):
                return files[selected - 1]
        except ValueError:
            pass
        console.print('Seleção inválida.', style='yellow')


def show_profile(analysis: dict, findings: list, show_all: bool) -> None:
    table = Table(title='Perfil · medições locais', header_style='bold cyan')
    table.add_column('Métrica')
    table.add_column('Total', justify='right')
    for key, label in [('watched_films', 'Filmes vistos'), ('rated_films', 'Ratings atuais'),
                       ('diary_entries', 'Sessões'), ('reviews', 'Reviews'), ('watchlist', 'Watchlist'),
                       ('explicit_rewatches', 'Rewatches explícitos'), ('own_lists', 'Listas próprias'),
                       ('liked_films', 'Filmes curtidos'), ('liked_reviews', 'Reviews curtidas'), ('liked_lists', 'Listas curtidas')]:
        table.add_row(label, str(analysis['overview'][key]))
    table.add_row('Tags distintas', str(len(analysis['tags'])))
    console.print(table)
    console.print(f'{len(findings)} findings determinísticos', style='bold')
    for finding in findings if show_all else findings[:5]:
        console.print(Text(f'  {finding.score:3} · {finding.summary}'))


def show_script(script: dict) -> None:
    table = Table(title='Roteiro selecionado pelo Python', header_style='bold cyan')
    for label in ('#', 'Tipo', 'Origem', 'Finding'):
        table.add_column(label)
    for beat in script['beats']:
        table.add_row(str(beat['position']), beat['beat_type'], beat['origin'], Text(', '.join(beat['finding_ids']) or 'overview'))
    console.print(table)


def run() -> int:
    parser = argparse.ArgumentParser(description='Judge My Letterboxd — Backend Prototype')
    parser.add_argument('--dry-run', action='store_true', help='Análise e roteiro locais; nenhuma chamada à IA')
    parser.add_argument('--analyze-only', action='store_true', help='Executa Analyst e Script Engine; pula Writer')
    parser.add_argument('--no-analyst', action='store_true',
                        help='Pula o Analyst e escreve o julgamento apenas com findings determinísticos')
    parser.add_argument('--show-findings', action='store_true', help='Mostra todos os findings determinísticos')
    args = parser.parse_args()
    load_dotenv(ROOT / '.env')
    config = GenerationConfig.from_env()
    console.print(Panel(Text('Judge My Letterboxd\nBackend Prototype · Analyst → Script Engine → Writer'), border_style='cyan'))
    path = choose_zip(Path.cwd())
    if path is None:
        return 0
    output = ROOT / 'output'
    output.mkdir(exist_ok=True)
    previous = archive_run(output, GENERATED)
    for name in GENERATED:
        (output / name).unlink(missing_ok=True)
    no_judgment(output, 'A geração ainda não foi concluída.')
    save(output / 'run_status.json', {'status': 'started', 'previous_run': previous})
    if previous:
        console.print(f'Execução anterior preservada em output/{previous}/', style='dim')
    console.print(Text(f'ZIP: {path.name}'))
    with console.status('Lendo export e calculando evidências...', spinner='dots'):
        profile = read_export(path)
        analysis = analyze(profile)
        findings = build_findings(profile, analysis)
    save(output / 'extracted_profile.json', asdict(profile))
    save(output / 'raw_export.json', profile.raw_export)
    console.print(f'ZIP completo convertido: {len(profile.raw_export)} arquivos → output/raw_export.json', style='dim')
    save(output / 'profile_summary.json', analysis)
    for name in ('findings.json', 'deterministic_findings.json'):
        save(output / name, [asdict(f) for f in findings])
    show_profile(analysis, findings, args.show_findings)
    script, judgment, failed = generate(profile, analysis, findings, ROOT, config,
                                        os.getenv('GEMINI_API_KEY', '').strip(), args.dry_run,
                                        args.analyze_only, args.no_analyst,
                                        lambda text: console.print(Text(text)))
    show_script(script)
    if judgment:
        console.rule('JUDGMENT', style='cyan')
        console.print(Text(judgment))
        console.rule(style='cyan')
    console.print('Arquivos de auditoria salvos em output/', style='green')
    if failed:
        console.print('Execução parcial: consulte run_status.json e as validações por etapa.', style='yellow')
    return 1 if failed else 0


def main() -> int:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    try:
        return run()
    except (KeyboardInterrupt, EOFError):
        console.print('Execução cancelada. Outputs já gravados foram preservados.', style='yellow')
        return 130
    except (OSError, BadZipFile, ValueError, RuntimeError) as exc:
        console.print(f'Não foi possível concluir ({type(exc).__name__}): {exc}', style='red')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
