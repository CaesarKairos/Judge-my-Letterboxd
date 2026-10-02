"""Lossless, deliberately non-editorial Freeform pipeline for the local prototype."""
from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import mimetypes
from pathlib import Path
from zipfile import ZipFile

from .gemini_client import write_final

TEXT_SUFFIXES = {'.csv', '.txt', '.json', '.md', '.html', '.xml', '.yaml', '.yml', '.log'}


def build_archives(path: Path, binary_inline_limit: int = 256 * 1024) -> tuple[dict, dict, dict]:
    files, rows_count, text_chars, reviews, lists, unknown = [], 0, 0, 0, 0, 0
    with ZipFile(path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            name = info.filename.replace('\\', '/')
            if name.startswith('/') or '..' in Path(name).parts:
                raise ValueError(f'Caminho inseguro no ZIP: {name}')
            data = archive.read(info)
            mime = mimetypes.guess_type(name)[0] or 'application/octet-stream'
            common = {'path': name, 'size': len(data), 'mime_type': mime,
                      'sha256': hashlib.sha256(data).hexdigest()}
            suffix = Path(name).suffix.casefold()
            textual = suffix in TEXT_SUFFIXES or (b'\0' not in data[:8192])
            if textual:
                raw = data.decode('utf-8', errors='replace'); text_chars += len(raw)
                if suffix == '.csv':
                    parsed = list(csv.reader(io.StringIO(raw, newline='')))
                    rows = [{'ref': f'{name}#row:{index}', 'index': index, 'cells': cells}
                            for index, cells in enumerate(parsed, 1)]
                    rows_count += len(rows)
                    if name.casefold() == 'reviews.csv': reviews = max(0, len(rows) - 1)
                    if name.casefold().startswith('lists/'): lists += 1
                    known = name.casefold() in {'profile.csv', 'watched.csv', 'ratings.csv', 'diary.csv',
                                                'reviews.csv', 'watchlist.csv', 'comments.csv'} or \
                            name.casefold().startswith(('likes/', 'lists/'))
                    unknown += int(not known)
                    files.append({**common, 'format': 'csv', 'raw_text': raw,
                                  'headers': parsed[0] if parsed else [], 'rows': rows})
                else:
                    unknown += 1
                    files.append({**common, 'format': 'text', 'raw_text': raw, 'ref': f'{name}#text'})
            else:
                unknown += 1
                item = {**common, 'format': 'binary', 'ref': f'{name}#binary'}
                if len(data) <= binary_inline_limit: item['base64'] = base64.b64encode(data).decode('ascii')
                else: item['base64_omitted'] = True
                files.append(item)
    meta = {'filename': path.name, 'file_count': len(files), 'row_count': rows_count,
            'text_chars': text_chars, 'reviews': reviews, 'lists': lists, 'unknown_files': unknown}
    lossless = {'version': 1, 'archive': meta, 'files': files}
    ai_files = []
    for file in files:
        if file['format'] == 'csv':
            ai_files.append({key: value for key, value in file.items() if key != 'raw_text'})
        elif file['format'] == 'binary':
            ai_files.append({key: value for key, value in file.items() if key not in {'base64', 'base64_omitted'}} |
                            {'base64_in_lossless': 'base64' in file})
        else: ai_files.append(file)
    ai = {'version': 1, 'archive': meta, 'files': ai_files}
    diagnostics = {**meta, 'archive_lossless_chars': len(json.dumps(lossless, ensure_ascii=False)),
                   'archive_ai_chars': len(json.dumps(ai, ensure_ascii=False))}
    return lossless, ai, diagnostics


def run_freeform(path: Path, root: Path, config, api_key: str, dry_run: bool, report=print) -> tuple[dict, bool]:
    out = root / 'output' / 'freeform'; out.mkdir(parents=True, exist_ok=True)
    lossless, ai, diagnostics = build_archives(path)
    for name, value in [('archive.lossless.json', lossless), ('archive.ai.json', ai)]:
        (out / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    report(f"Freeform archive: {diagnostics['file_count']} files, {diagnostics['row_count']} rows, "
           f"{diagnostics['archive_lossless_chars']} chars")
    max_chars = int(__import__('os').getenv('FREEFORM_MAX_PAYLOAD_CHARS', '1800000'))
    payload = json.dumps(ai, ensure_ascii=False, separators=(',', ':'))
    if len(payload) > max_chars: raise ValueError(f"freeform_context_too_large: payload_chars={len(payload)} file_count={diagnostics['file_count']}")
    prompt = (root / 'prompts' / 'judge-voice.txt').read_text(encoding='utf-8') + '\n\n' + \
             (root / 'prompts' / 'freeform-judge.txt').read_text(encoding='utf-8')
    request = {'model': config.writer_model, 'fallback_models': list(config.writer_fallback_models),
               'contents': '<ARCHIVE_DATA>\n' + payload + '\n</ARCHIVE_DATA>', 'config': {
                   'system_instruction': prompt, 'temperature': .8,
                   'automatic_function_calling': {'disable': True}, 'response_mime_type': 'application/json'}}
    (out / 'request-meta.json').write_text(json.dumps({**diagnostics, 'request_chars': len(prompt)+len(payload),
        'model_chain': [config.writer_model, *config.writer_fallback_models], 'main_calls': 0 if dry_run else 1}, indent=2), encoding='utf-8')
    if dry_run or not api_key:
        presentation = {'version': 'presentation-v2', 'pipeline_mode': 'freeform', 'events': [],
                        'profile_review': None, 'generation_meta': {'pipeline': 'freeform'},
                        'render': {'ai_generation': 'skipped', 'model': config.writer_model},
                        'ai': {'origin': 'none', 'calls': 0}, 'beats': []}
        (out / 'presentation.json').write_text(json.dumps(presentation, ensure_ascii=False, indent=2), encoding='utf-8')
        return presentation, False
    raw, response = write_final(api_key, request, report)
    (out / 'model-response.json').write_text(json.dumps({'raw': raw, 'metadata': response}, ensure_ascii=False, indent=2), encoding='utf-8')
    result = json.loads(raw)
    refs = {row['ref'] for file in ai['files'] for row in file.get('rows', [])} | {file['ref'] for file in ai['files'] if file.get('ref')}
    moments = [m for m in result.get('moments', []) if m.get('evidence_refs') and set(m['evidence_refs']) <= refs][:20]
    events=[]
    for moment in moments:
        events.append({'type':'custom_attachment','title':moment.get('title') or moment.get('type','custom'),
                       'label':moment.get('display_text',''),'evidence_refs':moment['evidence_refs']})
        events += [{'type':'message','segments':[{'text':str(line),'effect':'none'}]} for line in moment.get('lines',[])[:5]]
    presentation={'version':'presentation-v2','pipeline_mode':'freeform','events':events,'profile_review':result.get('profile_review'),
                  'generation_meta':{'pipeline':'freeform','freeform_judge':{'model':response.get('served_model'),'main_calls':1}},
                  'render':{'ai_generation':'complete','model':'gemini','served_model':response.get('served_model')},
                  'ai':{'origin':'api','calls':1},'beats':moments,'explainability':{'mode':'freeform','archive':diagnostics}}
    (out / 'presentation.json').write_text(json.dumps(presentation, ensure_ascii=False, indent=2), encoding='utf-8')
    return presentation, False
