from dataclasses import dataclass, field
from typing import Any


@dataclass
class DiaryEntry:
    id: str
    film_key: str
    date: str
    logged_date: str
    rating: float | None
    rewatch: bool
    tags: list[str]
    uri: str
    source: str


@dataclass
class ReviewRecord(DiaryEntry):
    text: str


@dataclass
class FilmRecord:
    key: str
    name: str
    year: str
    rating: float | None = None
    watched: bool = False
    watchlist: bool = False
    liked: bool = False
    favorite: bool = False
    uris: list[str] = field(default_factory=list)
    diary_ids: list[str] = field(default_factory=list)
    review_ids: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    list_ids: list[str] = field(default_factory=list)
    dates: dict[str, list[str]] = field(default_factory=dict)
    sources: list[str] = field(default_factory=list)


@dataclass
class ListRecord:
    id: str
    name: str
    description: str
    tags: list[str]
    members: list[dict[str, Any]]
    source: str


@dataclass
class UserProfile:
    films: dict[str, FilmRecord] = field(default_factory=dict)
    diary: list[DiaryEntry] = field(default_factory=list)
    reviews: list[ReviewRecord] = field(default_factory=list)
    lists: list[ListRecord] = field(default_factory=list)
    liked_reviews: list[dict[str, str]] = field(default_factory=list)
    liked_lists: list[dict[str, str]] = field(default_factory=list)
    comments: list[dict[str, str]] = field(default_factory=list)
    favorites: list[dict[str, Any]] = field(default_factory=list)
    inventory: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    handle: str = ''
    display_name: str = ''


@dataclass
class Finding:
    id: str
    type: str
    score: int
    confidence: float
    summary: str
    evidence: dict[str, Any]
    film_keys: list[str]
    sources: list[str]
    sample_size: int = 0
    metric: str = ''
    baseline: dict[str, Any] | None = None
    difference: float | None = None
