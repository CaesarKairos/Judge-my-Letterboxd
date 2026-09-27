"""Preserve runs and reuse only validated responses to identical requests."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil


def archive_run(output: Path, names: tuple[str, ...]) -> str | None:
    existing = [output / name for name in names if (output / name).is_file()]
    if not existing:
        return None
    archive = output / 'runs' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    archive.mkdir(parents=True)
    for path in existing:
        shutil.copy2(path, archive / path.name)
    return str(archive.relative_to(output))


def cache_path(output: Path, stage: str, request: dict) -> Path:
    digest = hashlib.sha256(json.dumps(request, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()
    return output / 'cache' / f'{stage}_{digest}.json'


def read_cached(output: Path, stage: str, request: dict) -> tuple[str, dict] | None:
    try:
        data = json.loads(cache_path(output, stage, request).read_text(encoding='utf-8'))
        if isinstance(data['raw'], str) and isinstance(data['response'], dict):
            return data['raw'], data['response']
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def cache_response(output: Path, stage: str, request: dict, raw: str, response: dict) -> None:
    path = cache_path(output, stage, request)
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps({'raw': raw, 'response': response}, ensure_ascii=False), encoding='utf-8')


def no_judgment(output: Path, reason: str) -> None:
    (output / 'judgment.txt').write_text(
        '[STATUS DO PROGRAMA — NÃO É UM JULGAMENTO DA IA]\n'
        f'Nenhum julgamento foi gerado nesta execução.\n{reason}\n'
        'Consulte run_status.json. Execuções anteriores são preservadas em output/runs/.\n', encoding='utf-8')
