"""Generation configuration v2 with independent Analyst/Writer model policy."""
from dataclasses import dataclass
import os


def _models(name: str, legacy: str = '') -> tuple[str, ...]:
    declared = os.getenv(name, '') or (os.getenv(legacy, '') if legacy else '')
    result, seen = [], set()
    for candidate in declared.replace(',', ' ').split():
        if candidate and candidate not in seen:
            seen.add(candidate)
            result.append(candidate)
    return tuple(result)


@dataclass
class GenerationConfig:
    language: str = 'pt-BR'
    max_context: int = 1_000_000
    max_beats: int = 12
    writer_max_context: int = 100_000
    max_lines: int = 4
    max_words: int = 14
    analyst_temperature: float = .2
    writer_temperature: float = .75
    writer_acid_level: float = .75
    analyst_model: str = 'gemini-flash-latest'
    writer_model: str = 'gemini-flash-latest'
    analyst_fallback_models: tuple[str, ...] = ()
    writer_fallback_models: tuple[str, ...] = ()
    discover_models: bool = True
    humor_templates: bool = False
    include_raw_export: bool = True

    # Compatibility properties for code/tests that still inspect the legacy names.
    @property
    def model(self) -> str:
        return self.writer_model

    @property
    def fallback_models(self) -> tuple[str, ...]:
        return self.writer_fallback_models

    @classmethod
    def from_env(cls) -> 'GenerationConfig':
        legacy_model = os.getenv('GEMINI_MODEL', 'gemini-flash-latest')
        config = cls(
            language=os.getenv('JUDGE_LANGUAGE', 'pt-BR'),
            max_context=int(os.getenv('MAX_CONTEXT_CHARS', '1000000')),
            max_beats=int(os.getenv('SCRIPT_MAX_BEATS', '12')),
            writer_max_context=int(os.getenv('WRITER_MAX_CONTEXT_CHARS', '100000')),
            max_lines=int(os.getenv('WRITER_MAX_LINES', '4')),
            max_words=int(os.getenv('WRITER_MAX_WORDS_PER_LINE', '14')),
            analyst_temperature=float(os.getenv('ANALYST_TEMPERATURE', '.2')),
            writer_temperature=float(os.getenv('WRITER_TEMPERATURE', '.75')),
            writer_acid_level=float(os.getenv('WRITER_ACID_LEVEL', '.75')),
            analyst_model=os.getenv('GEMINI_ANALYST_MODEL', legacy_model),
            writer_model=os.getenv('GEMINI_WRITER_MODEL', legacy_model),
            analyst_fallback_models=_models('GEMINI_ANALYST_FALLBACK_MODELS', 'GEMINI_FALLBACK_MODELS'),
            writer_fallback_models=_models('GEMINI_WRITER_FALLBACK_MODELS', 'GEMINI_FALLBACK_MODELS'),
            discover_models=os.getenv('MODEL_DISCOVERY', '1') not in {'0', 'false', 'no'},
            humor_templates=os.getenv('JUDGE_HUMOR_TEMPLATES', '0') in {'1', 'true', 'yes'},
            include_raw_export=os.getenv('ANALYST_RAW_EXPORT', '1') not in {'0', 'false', 'no'},
        )
        if not 1 <= config.max_beats <= 14:
            raise ValueError('SCRIPT_MAX_BEATS deve estar entre 1 e 14.')
        if not 1 <= config.max_lines <= 4:
            raise ValueError('WRITER_MAX_LINES deve estar entre 1 e 4.')
        if not 2 <= config.max_words <= 24:
            raise ValueError('WRITER_MAX_WORDS_PER_LINE deve estar entre 2 e 24.')
        if not 0 <= config.analyst_temperature <= 2 or not 0 <= config.writer_temperature <= 2:
            raise ValueError('Temperaturas devem estar entre 0 e 2.')
        if not 0 <= config.writer_acid_level <= 1:
            raise ValueError('WRITER_ACID_LEVEL deve estar entre 0 e 1.')
        return config
