import csv
import io
import json
import re
import unicodedata
from html.parser import HTMLParser
from statistics import mean, median
from typing import Any


def normalize_title(value: str) -> str:
    return ' '.join(unicodedata.normalize('NFC', value).casefold().split())


def film_key(name: str, year: str) -> str:
    return json.dumps([normalize_title(name), year.strip()], ensure_ascii=False)


def parse_rating(value: str) -> float | None:
    try:
        rating = float(value)
        return rating if 0.5 <= rating <= 5 and rating * 2 == int(rating * 2) else None
    except (ValueError, TypeError, OverflowError):
        return None


def parse_tags(value: str) -> list[str]:
    return list(dict.fromkeys(t.strip() for t in next(csv.reader([value], skipinitialspace=True), []) if t.strip()))


def csv_rows(data: bytes) -> list[list[str]]:
    return list(csv.reader(io.StringIO(data.decode('utf-8-sig'), newline='')))


def records(rows: list[list[str]], header: int = 0) -> list[dict[str, str]]:
    if not rows:
        return []
    names = [x.strip() for x in rows[header]]
    return [dict(zip(names, row)) for row in rows[header + 1:] if any(row)]


def stats(values: list[float]) -> dict[str, Any]:
    return {'count': len(values), 'mean': mean(values) if values else None,
            'median': median(values) if values else None}


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def plain_text(text: str) -> str:
    parser = _TextExtractor()
    parser.feed(text)
    return ' '.join(parser.parts)


def words(text: str) -> list[str]:
    return re.findall(r"[^\W_]+(?:['’][^\W_]+)?", plain_text(text).casefold(), re.UNICODE)


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)
