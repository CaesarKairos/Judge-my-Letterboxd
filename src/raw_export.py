"""Faithful, non-selective JSON representation of the entire Letterboxd export ZIP."""
from pathlib import Path
from zipfile import ZipFile
import base64

from .utils import csv_rows

MAX_TOTAL_BYTES = 200_000_000
MAX_FILE_BYTES = 50_000_000


def read_raw_export(path: Path) -> dict:
    """Read every file in the ZIP without applying product/editorial filtering.

    CSV files are preserved as arrays of rows instead of being coerced into one
    header shape; this matters for Letterboxd list exports, which can contain
    metadata rows before the actual member table. deleted/ and orphaned/ are kept
    too. Nothing here is used as active profile state; this is the faithful copy
    supplied to the AI Analyst.
    """
    with ZipFile(path) as archive:
        infos = [info for info in archive.infolist() if not info.is_dir()]
        total = sum(info.file_size for info in infos)
        if total > MAX_TOTAL_BYTES:
            raise ValueError('ZIP excede o limite descompactado de 200 MB.')

        files: list[dict] = []
        for info in infos:
            if info.file_size > MAX_FILE_BYTES:
                raise ValueError(f'Arquivo do export excede 50 MB: {info.filename}')
            blob = archive.read(info)
            item = {
                'path': info.filename.replace('\\', '/'),
                'bytes': info.file_size,
            }
            if info.filename.casefold().endswith('.csv'):
                rows = csv_rows(blob)
                item.update(format='csv', rows=rows, row_count=len(rows))
            else:
                try:
                    text = blob.decode('utf-8-sig')
                    item.update(format='text', text=text)
                except UnicodeDecodeError:
                    item.update(format='base64', content=base64.b64encode(blob).decode('ascii'))
            files.append(item)

    return {
        'format': 'letterboxd-export-json-v1',
        'archive_name': path.name,
        'file_count': len(files),
        'total_uncompressed_bytes': total,
        'files': files,
    }
