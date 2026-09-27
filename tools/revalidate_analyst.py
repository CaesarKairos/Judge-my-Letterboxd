"""Offline revalidation of the stored Analyst answer: iterate on the prompt without quota.

Usage:
    python tools/revalidate_analyst.py [--context-budget N] [--raw-export]

Reads the ZIP in the project root plus output/analyst_response.json (written by the last
run), rebuilds the Analyst context locally and runs the same validator the pipeline uses.
It prints accepted/rejected counts, the error classes and one line per rejected candidate,
so a prompt fix can be measured in seconds and zero API calls.
"""
import argparse
import json
from collections import Counter
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.analyzer import analyze  # noqa: E402
from src.context_builder import build_context  # noqa: E402
from src.findings import build_findings  # noqa: E402
from src.parser import read_export  # noqa: E402
from src.raw_export import read_raw_export  # noqa: E402
from src.semantic_validator import validate_semantic_findings  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description='Revalida a resposta do Analyst sem chamar a IA')
    parser.add_argument('--context-budget', type=int, default=1000000, help='MAX_CONTEXT_CHARS usado no teste')
    parser.add_argument('--raw-export', action='store_true', help='Inclui o ZIP bruto, como ANALYST_RAW_EXPORT=1')
    args = parser.parse_args()
    archives = sorted(path for path in ROOT.iterdir() if path.suffix.casefold() == '.zip')
    stored = ROOT / 'output' / 'analyst_response.json'
    if not archives or not stored.is_file():
        print('Precisa de um ZIP no projeto e de output/analyst_response.json de uma execução real.')
        return 1
    profile = read_export(archives[0])
    analysis = analyze(profile)
    findings = build_findings(profile, analysis)
    prompt = (ROOT / 'prompts' / 'analyst.txt').read_text(encoding='utf-8')
    raw_export = read_raw_export(archives[0]) if args.raw_export else None
    context, message = build_context(profile, analysis, findings, prompt, args.context_budget, 'pt-BR', raw_export)
    raw = json.loads(stored.read_text(encoding='utf-8'))['raw_response']
    accepted, rejected = validate_semantic_findings(raw, context)
    print(f'contexto: {len(prompt) + len(message):,} caracteres'
          f' (raw_export={"incluído" if raw_export else "excluído"})')
    print(f'aceitos: {len(accepted)} | rejeitados: {len(rejected)}')
    for item in accepted:
        print(f"  OK  {item['id'][:40]:42} {item['type']:20} i={item['interestingness']:.2f} c={item['confidence']:.2f}"
              f" {item.get('score_normalization') or ''}{item.get('bounded_lists') or ''}")
    classes = Counter(error.split(':')[0] for item in rejected for error in item['errors'])
    if classes:
        print('classes de erro:', classes.most_common())
    for item in rejected:
        print(f"  REJ {str(item['candidate'].get('id'))[:40]:42} {item['errors'][:3]}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
