"""Locale bundles and HUMAN_TEMPLATE humor resources. No runtime translation."""
import hashlib
import json
from functools import lru_cache
from pathlib import Path
from typing import Any

RESOURCES = Path(__file__).resolve().parent.parent / 'resources'
DEFAULT_LOCALE = 'pt-BR'
FALLBACK_LOCALES = {'pt-BR', 'en-US', 'en', 'pt'}


class LocaleBundle:
    """Static localized strings: the AI only fills slots, never restructures text."""

    def __init__(self, locale: str, data: dict[str, Any], humor: dict[str, Any]):
        self.locale = locale
        self.data = data
        self.humor = humor
        self.phrases: dict[str, str] = data.get('phrases', {})
        self.pools: dict[str, Any] = data.get('pools', {})
        self.stat_labels: dict[str, str] = data.get('stat_labels', {})
        self.moment_labels: dict[str, str] = data.get('moment_labels', {})

    def phrase(self, key: str, **params: Any) -> str:
        """A localized structural phrase; unknown keys fail loudly instead of leaking a key."""
        try:
            template = self.phrases[key]
        except KeyError as exc:
            raise KeyError(f'frase ausente no locale {self.locale}: {key}') from exc
        return template.format(**params) if params else template

    def pool(self, name: str) -> list:
        return list(self.pools.get(name, []))

    def salutations(self) -> list[str]:
        """Short greetings, never a catchphrase; a missing pool fails loudly."""
        options = self.pool('salutations')
        if not options:
            raise KeyError(f'pool ausente no locale {self.locale}: salutations')
        return options

    def adjective_pairs(self) -> list[dict[str, str]]:
        return [p for p in self.pool('taste_adjective_pairs') if 'negative' in p and 'positive' in p]

    def stat_label(self, key: str) -> str:
        return self.stat_labels.get(key, key)

    def moment_label(self, key: str) -> str:
        return self.moment_labels.get(key, key)

    def human_templates(self, moment_type: str) -> list[dict]:
        return [t for t in self.humor.get('templates', []) if t.get('moment_type') == moment_type]

    def stable_index(self, seed: str) -> int:
        """Per-account, stable choice: same account, same identity, variation across accounts."""
        return int(hashlib.sha256(f'{self.locale}:{seed}'.encode('utf-8')).hexdigest(), 16)


def resolve_locale(language: str) -> str:
    for candidate in (language, DEFAULT_LOCALE, 'en-US'):
        if candidate and (RESOURCES / 'locales' / f'{candidate}.json').is_file():
            return candidate
    raise ValueError(f'locale sem recursos: {language}')


@lru_cache(maxsize=8)
def bundle(language: str) -> LocaleBundle:
    locale = resolve_locale(language)
    data = json.loads((RESOURCES / 'locales' / f'{locale}.json').read_text(encoding='utf-8'))
    humor_path = RESOURCES / 'humor' / f"{'pt-BR' if locale.startswith('pt') else 'en'}.json"
    humor = json.loads(humor_path.read_text(encoding='utf-8')) if humor_path.is_file() else {'templates': []}
    return LocaleBundle(locale, data, humor)
