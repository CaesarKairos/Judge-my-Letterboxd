"""Model discovery: capability filtering, heuristic preference, chain order and fallbacks."""
import unittest

from src.model_discovery import build_chain, cached_discovery, model_id, partition, rank, record, usable
from src.presentation import validate_presentation  # noqa: F401  (contract modules stay importable together)


def model(name, methods=('generateContent',), **extra):
    return {'name': f'models/{name}', 'supportedGenerationMethods': list(methods), **extra}


LISTING = [model('gemini-flash-latest'), model('gemini-flash-lite-latest'),
           model('gemini-2.5-pro-preview'), model('gemini-2.0-flash-exp'),
           model('text-embedding-004', methods=('embedContent',)),
           model('gemini-2.5-flash-preview-tts'), model('gemini-flash-image'),
           model('gemini-2.0-flash-live-2.5'), model('gemma-3-27b-it'),
           model('internal-vision-model', methods=('countTokens',)),
           model('gemini-flash-2.0-deprecated', state='DEPRECATED')]


class DiscoveryTests(unittest.TestCase):
    def test_only_generate_content_text_models_are_usable(self):
        accepted, rejected = partition(LISTING)
        self.assertEqual(accepted, ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-pro-preview',
                                    'gemini-2.0-flash-exp', 'gemma-3-27b-it'])
        reasons = {item['model']: item['reason'] for item in rejected}
        self.assertIn('embedding', reasons['text-embedding-004'])
        self.assertIn('não suporta generateContent', reasons['internal-vision-model'])
        self.assertIn('tts', reasons['gemini-2.5-flash-preview-tts'])
        self.assertIn('image', reasons['gemini-flash-image'])
        self.assertIn('live', reasons['gemini-2.0-flash-live-2.5'])
        self.assertIn('lifecycle', reasons['gemini-flash-2.0-deprecated'])

    def test_heuristic_preference_prefers_stable_flash_then_latest(self):
        self.assertGreater(rank('gemini-flash-latest'), rank('gemini-flash-lite-latest'))
        self.assertGreater(rank('gemini-flash-latest'), rank('gemini-2.5-pro-preview'))
        self.assertGreater(rank('gemini-flash-latest'), rank('gemini-2.0-flash-exp'))
        self.assertGreater(rank('gemini-flash-latest'), rank('gemma-3-27b-it'))

    def test_chain_order_is_explicit_first_then_discovered_and_deduplicated(self):
        accepted, _ = partition(LISTING)
        chain, rejected = build_chain('gemini-flash-latest', ['gemini-flash-lite-latest', 'custom-model'], accepted)
        self.assertEqual(chain[0], 'gemini-flash-latest')
        self.assertIn('gemini-2.0-flash-exp', chain)
        self.assertTrue('gemini-flash-lite-latest' not in chain or chain.index('gemini-2.0-flash-exp') < chain.index('gemini-flash-lite-latest'))
        self.assertEqual(len(chain), len(set(chain)))
        self.assertTrue(any('fora do limite' in item['reason'] or 'duplicado' in item['reason'] for item in rejected))

    def test_model_id_strips_the_provider_prefix(self):
        self.assertEqual(model_id({'name': 'models/gemini-flash-latest'}), 'gemini-flash-latest')
        self.assertEqual(usable({'name': ''})[0], False)

    def test_record_is_auditable_metadata_only(self):
        accepted, refused = partition(LISTING)
        chain, duplicates = build_chain('gemini-flash-latest', [], accepted)
        payload = record('gemini-flash-latest', [], accepted, refused + duplicates, chain,
                         {'status': 'ok', 'source': 'api', 'listed': len(LISTING), 'usable': len(accepted)})
        self.assertEqual(payload['primary_model'], 'gemini-flash-latest')
        self.assertEqual(payload['chain'], chain)
        self.assertEqual(payload['discovery']['usable'], len(accepted))
        self.assertEqual(payload['discovered_models'], sorted(accepted))
        self.assertNotIn('api_key', str(payload))

    def test_discovery_cache_is_optional_and_short_lived(self):
        import tempfile
        from datetime import datetime, timedelta, timezone
        from pathlib import Path

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            self.assertIsNone(cached_discovery(output))
            fresh = {'fetched_at': datetime.now(timezone.utc).isoformat(), 'discovered_models': ['a']}
            (output / 'model_discovery.json').write_text(
                __import__('json').dumps(fresh), encoding='utf-8')
            self.assertEqual(cached_discovery(output)['discovered_models'], ['a'])
            stale = {'fetched_at': (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()}
            (output / 'model_discovery.json').write_text(
                __import__('json').dumps(stale), encoding='utf-8')
            self.assertIsNone(cached_discovery(output))
            (output / 'model_discovery.json').write_text('not json', encoding='utf-8')
            self.assertIsNone(cached_discovery(output))
    def test_discovered_ladder_is_capped_and_audited(self):
        accepted, _ = partition(LISTING)
        chain, rejected = build_chain('gemini-flash-latest', [], accepted, limit=2)
        # The primary is already in the listing, so only one extra discovered model survives the cap.
        self.assertEqual(chain, ['gemini-flash-latest', 'gemini-2.0-flash-exp'])
        self.assertTrue(any('fora do limite' in item['reason'] for item in rejected))

    def test_non_text_families_are_excluded_by_name(self):
        family = [model('gemini-3.5-transcribe'), model('lyria-3.5'), model('nano-banana-pro-preview'),
                  model('antigravity-preview-latest'), model('gemini-2.5-computer-use-preview-10-2025'),
                  model('gemini-3.1-pro-preview-customtools'), model('lyria-realtime-exp')]
        accepted, rejected = partition(family)
        self.assertEqual(accepted, [])
        self.assertEqual(len(rejected), len(family))


if __name__ == '__main__':
    unittest.main()