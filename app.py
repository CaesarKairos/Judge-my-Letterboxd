"""Terminal orchestration; local measurements and AI stages remain separate."""
import argparse
from dataclasses import asdict
import json
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
from src.raw_export import read_raw_export
from src.run_storage import archive_run, no_judgment

ROOT = Path(__file__).resolve().parent
console = Console(markup=False, highlight=False)
GENERATED = ('profile_summary.json', 'extracted_profile.json', 'findings.json', 'deterministic_findings.json',
             'semantic_findings.json', 'semantic_validation.json', 'finding_pool.json', 'script.json',
             'editorial_moments.json', 'model_discovery.json', 'final_writer_request.json',
             'final_writer_response.json', 'presentation_script.json', 'ai_context.json', 'ai_request.json',
             'ai_response.json', 'analyst_response.json', 'ai_id_map.json', 'judgment.txt', 'debug_report.txt',
             'run_status.json', 'raw_export.json')
# Outputs da arquitetura antiga (uma chamada Writer por beat): removidos sem arquivar,
# porque o equivalente atual vive em editorial_moments/final_writer_response/presentation.
RETIRED = ('writer_inputs.json', 'judgment.json')


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


def show_moments(moments: list[dict]) -> None:
    table = Table(title='Momentos editoriais selecionados pelo Python (display-first)', header_style='bold cyan')
    for label in ('#', 'Tipo', 'Papel', 'Display', 'Origem', 'Finding'):
        table.add_column(label)
    for moment in moments:
        table.add_row(moment['beat_id'], moment['moment_type'], moment.get('role', 'moment'),
                      moment['display'].get('kind', '-'), moment['origin'],
                      Text(', '.join(moment['finding_ids'])))
    console.print(table)


def show_presentation(script: dict) -> None:
    """Read the experience as the frontend will: typing, pause, correction, data, reaction."""
    from src.presentation import event_text

    console.rule('EXPERIÊNCIA (presentation_script.json)', style='magenta')
    for event in script['events']:
        kind, text = event['type'], event_text(event).strip()
        if kind == 'typing':
            console.print(Text(f'  … ({event["duration"]})', style='dim'))
        elif kind == 'pause':
            console.print(Text('  ·', style='dim'))
        elif kind in {'correction', 'strike'}:
            console.print(Text(f'  {text}', style='yellow'))
        elif kind == 'message':
            console.print(Text(f'  {text}'))
        else:
            console.print(Text(f'  [{kind}] {text}', style='cyan'))
    console.rule(style='magenta')


def run() -> int:
    parser = argparse.ArgumentParser(description='Judge My Letterboxd — Backend Prototype')
    parser.add_argument('--dry-run', action='store_true', help='Análise e roteiro locais; nenhuma chamada à IA')
    parser.add_argument('--analyze-only', action='store_true', help='Executa Analyst e Script Engine; pula Writer')
    parser.add_argument('--no-analyst', action='store_true',
                        help='Pula o Analyst e escreve o julgamento apenas com findings determinísticos')
    parser.add_argument('--show-findings', action='store_true', help='Mostra todos os findings determinísticos')
    parser.add_argument('--show-events', action='store_true', help='Mostra o presentation_script.json completo')
    args = parser.parse_args()
    load_dotenv(ROOT / '.env')
    config = GenerationConfig.from_env()
    console.print(Panel(Text('Judge My Letterboxd\nBackend · Analyst → Momentos → Script Engine → Final Writer → Presentation'),
                        border_style='cyan'))
    path = choose_zip(Path.cwd())
    if path is None:
        return 0
    output = ROOT / 'output'
    output.mkdir(exist_ok=True)
    previous = archive_run(output, GENERATED)
    for name in GENERATED:
        (output / name).unlink(missing_ok=True)
    for name in RETIRED:
        (output / name).unlink(missing_ok=True)
    no_judgment(output, 'A geração ainda não foi concluída.')
    save(output / 'run_status.json', {'status': 'started', 'previous_run': previous})
    if previous:
        console.print(f'Execução anterior preservada em output/{previous}/', style='dim')
    console.print(Text(f'ZIP: {path.name}'))
    with console.status('Lendo export e calculando evidências...', spinner='dots'):
        raw_export = read_raw_export(path)
        profile = read_export(path)
        analysis = analyze(profile)
        findings = build_findings(profile, analysis)
    save(output / 'raw_export.json', raw_export)
    save(output / 'extracted_profile.json', asdict(profile))
    save(output / 'profile_summary.json', analysis)
    for name in ('findings.json', 'deterministic_findings.json'):
        save(output / name, [asdict(f) for f in findings])
    show_profile(analysis, findings, args.show_findings)
    script, judgment, failed = generate(profile, analysis, findings, raw_export, ROOT, config,
                                        os.getenv('GEMINI_API_KEY', '').strip(), args.dry_run,
                                        args.analyze_only, args.no_analyst,
                                        lambda text: console.print(Text(text)))
    show_moments(script['moments'])
    presentation = json.loads((output / 'presentation_script.json').read_text(encoding='utf-8'))
    show_presentation(presentation)
    if args.show_events:
        console.print(Text(json.dumps(presentation, ensure_ascii=False, indent=2)))
    console.print(f"Chamadas de IA: {presentation['ai'].get('calls', 0)}"
                  f" (origin: {presentation['ai'].get('origin', 'none')},"
                  f" modelo: {presentation['render'].get('served_model') or presentation['render']['model']})",
                  style='green')
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
