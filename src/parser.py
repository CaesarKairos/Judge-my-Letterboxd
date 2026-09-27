"""Read a Letterboxd ZIP in memory and preserve every file as JSON-ready data."""
from base64 import b64encode
from hashlib import sha256
from pathlib import Path, PurePosixPath
from zipfile import ZipFile

from .models import DiaryEntry, FilmRecord, ListRecord, ReviewRecord, UserProfile
from .utils import csv_rows, film_key, parse_rating, parse_tags, records

FILM_FILES = {'watched.csv', 'ratings.csv', 'diary.csv', 'reviews.csv',
              'watchlist.csv', 'likes/films.csv'}
KNOWN = FILM_FILES | {'profile.csv', 'comments.csv', 'likes/reviews.csv', 'likes/lists.csv'}
MAX_FILE_BYTES = 50_000_000
MAX_TOTAL_BYTES = 200_000_000


def merge_film(profile: UserProfile, row: dict[str, str], source: str) -> FilmRecord | None:
    name, year = row.get('Name', '').strip(), row.get('Year', '').strip()
    if not name:
        profile.warnings.append(f'{source}: linha sem Name ignorada.')
        return None
    key = film_key(name, year)
    film = profile.films.setdefault(key, FilmRecord(key, name, year))
    for uri in [row.get('Letterboxd URI', ''), row.get('URL', '')]:
        if uri and uri not in film.uris:
            film.uris.append(uri)
    if source not in film.sources:
        film.sources.append(source)
    date = row.get('Date', '')
    if date:
        film.dates.setdefault(source, []).append(date)
    return film


def read_list(profile: UserProfile, source: str, rows: list[list[str]]) -> None:
    header = next((i for i, r in enumerate(rows) if 'Name' in r and 'Year' in r), None)
    if header is None:
        profile.warnings.append(f'{source}: cabeçalho de membros não encontrado.')
        return
    meta_header = next((i for i, r in enumerate(rows[:header]) if 'Name' in r and 'Description' in r), None)
    meta = {}
    if meta_header is not None and meta_header + 1 < header:
        meta = dict(zip(rows[meta_header], rows[meta_header + 1]))
    own_list = ListRecord(source, meta.get('Name', PurePosixPath(source).stem),
                          meta.get('Description', ''), parse_tags(meta.get('Tags', '')), [], source)
    for row in records(rows, header):
        film = merge_film(profile, row, source)
        if film:
            own_list.members.append({'film_key': film.key, 'position': row.get('Position', ''),
                                     'description': row.get('Description', '')})
            if source not in film.list_ids:
                film.list_ids.append(source)
    profile.lists.append(own_list)


def raw_file_record(source: str, raw: bytes) -> dict:
    """Convert one ZIP member into JSON-safe data without silently discarding its contents."""
    base = {'file': source, 'bytes': len(raw), 'sha256': sha256(raw).hexdigest()}
    if source.casefold().endswith('.csv'):
        rows = csv_rows(raw)
        return {**base, 'kind': 'csv', 'row_count': len(rows), 'rows': rows}
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        return {**base, 'kind': 'binary_base64', 'content_base64': b64encode(raw).decode('ascii')}
    return {**base, 'kind': 'text', 'text': text}


def read_export(path: Path) -> UserProfile:
    profile = UserProfile()
    favorite_refs: list[str] = []
    with ZipFile(path) as archive:
        if sum(i.file_size for i in archive.infolist()) > MAX_TOTAL_BYTES:
            raise ValueError('ZIP excede o limite descompactado de 200 MB.')
        for info in archive.infolist():
            if info.is_dir():
                continue
            source = info.filename.replace('\\', '/')
            parts = PurePosixPath(source).parts
            item = {'file': source, 'bytes': info.file_size, 'status': 'unknown'}
            profile.inventory.append(item)

            if info.file_size > MAX_FILE_BYTES:
                raise ValueError(f'Arquivo excede 50 MB: {source}')

            raw = archive.read(info)
            raw_record = raw_file_record(source, raw)
            profile.raw_export.append(raw_record)
            item['raw_exported'] = True

            if '..' in parts or source.startswith('/'):
                item['status'] = 'unsafe_path_ignored_by_normalizer'
                continue
            if parts and parts[0] in {'deleted', 'orphaned'}:
                item['status'] = 'inactive_ignored_by_normalizer'
                continue

            is_list = len(parts) == 2 and parts[0] == 'lists' and source.endswith('.csv')
            if source not in KNOWN and not is_list:
                item['status'] = 'raw_only'
                continue
            if raw_record['kind'] != 'csv':
                item['status'] = 'known_non_csv_ignored_by_normalizer'
                continue

            rows = raw_record['rows']
            item.update(status='read', rows=max(0, len(rows) - 1))
            if is_list:
                read_list(profile, source, rows)
                continue

            data = records(rows)
            if source == 'profile.csv':
                for row in data:
                    favorite_refs.extend(parse_tags(row.get('Favorite Films', '')))
            elif source in {'comments.csv', 'likes/reviews.csv', 'likes/lists.csv'}:
                target = {'comments.csv': profile.comments, 'likes/reviews.csv': profile.liked_reviews,
                          'likes/lists.csv': profile.liked_lists}[source]
                target.extend({k: r.get(k, '') for k in ('Date', 'Content', 'Comment') if k in r} for r in data)
            else:
                for index, row in enumerate(data, 1):
                    film = merge_film(profile, row, source)
                    if film is None:
                        continue
                    if source == 'ratings.csv':
                        film.rating = parse_rating(row.get('Rating', ''))
                        if row.get('Rating') and film.rating is None:
                            profile.warnings.append(f'{source}:{index}: rating inválido ignorado.')
                    elif source == 'watched.csv':
                        film.watched = True
                    elif source == 'watchlist.csv':
                        film.watchlist = True
                    elif source == 'likes/films.csv':
                        film.liked = True
                    else:
                        entry = dict(id=f'{source}:{index}', film_key=film.key,
                                     date=row.get('Watched Date', ''), logged_date=row.get('Date', ''),
                                     rating=parse_rating(row.get('Rating', '')),
                                     rewatch=row.get('Rewatch', '').casefold() in {'yes', 'true', '1'},
                                     tags=parse_tags(row.get('Tags', '')), uri=row.get('Letterboxd URI', ''), source=source)
                        film.tags = list(dict.fromkeys(film.tags + entry['tags']))
                        if source == 'diary.csv':
                            profile.diary.append(DiaryEntry(**entry))
                            film.diary_ids.append(entry['id'])
                        else:
                            profile.reviews.append(ReviewRecord(**entry, text=row.get('Review', '')))
                            film.review_ids.append(entry['id'])

    for ref in favorite_refs:
        matches = [f.key for f in profile.films.values() if ref.rstrip('/') in {u.rstrip('/') for u in f.uris}]
        profile.favorites.append({'reference': ref, 'film_keys': matches,
                                  'status': 'resolved' if len(matches) == 1 else 'unresolved'})
        if len(matches) == 1:
            profile.films[matches[0]].favorite = True
    return profile
