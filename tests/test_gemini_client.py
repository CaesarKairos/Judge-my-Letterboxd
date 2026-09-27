import unittest
from unittest.mock import MagicMock, patch

from src.gemini_client import RETRYABLE_CODES, error_info, list_models, make_request, models_for, write_final


class QuotaError(Exception):
    code = 429


class MissingModelError(Exception):
    code = 404


class BadRequestError(Exception):
    code = 400


class GeminiClientTests(unittest.TestCase):
    def test_retryable_codes_include_quota_and_timeout(self):
        self.assertIn(429, RETRYABLE_CODES)
        self.assertIn(408, RETRYABLE_CODES)
        for code in (500, 502, 503, 504):
            self.assertIn(code, RETRYABLE_CODES)

    def test_request_records_fallback_chain_and_models_for_deduplicates(self):
        request = make_request('primary', 'system', 'message', .2, 'analyst',
                               ('fallback', 'fallback', 'primary'))
        self.assertEqual(request['fallback_models'], ['fallback', 'fallback', 'primary'])
        self.assertEqual(models_for(request), ['primary', 'fallback'])
        self.assertEqual(request['config']['response_mime_type'], 'application/json')

    def test_request_without_fallbacks_keeps_a_single_model(self):
        request = make_request('primary', 'system', 'message', .2, 'writer')
        self.assertEqual(request['fallback_models'], [])
        self.assertEqual(models_for(request), ['primary'])
    def test_quota_moves_to_next_model_and_reports_which_one_answered(self):
        request = make_request('primary', 'system', 'message', .2, 'writer', ('fallback', 'unused'))
        notes: list[str] = []
        with patch('src.gemini_client._call', side_effect=[QuotaError(), ('{"lines": []}', {'text': '{}'})]) as call:
            raw, response = write_final('synthetic-key', request, notes.append)
        self.assertEqual(raw, '{"lines": []}')
        self.assertEqual(response['served_model'], 'fallback')
        self.assertEqual(response['model_attempts'], [{'model': 'primary', 'code': 429,
                                                       'reason': 'rate_limit_or_quota_exhausted'}])
        self.assertEqual([item.args[1] for item in call.call_args_list], ['primary', 'fallback'])
        self.assertEqual(len(notes), 2)

    def test_list_models_uses_the_official_models_list(self):
        entry = MagicMock()
        entry.model_dump.return_value = {'name': 'models/gemini-flash-latest',
                                         'supportedGenerationMethods': ['generateContent']}
        with patch('google.genai.Client') as client:
            client.return_value.__enter__.return_value.models.list.return_value = [entry]
            self.assertEqual(list_models('synthetic-key'),
                             [{'name': 'models/gemini-flash-latest', 'supportedGenerationMethods': ['generateContent']}])

    def test_primary_model_is_used_when_it_answers(self):
        request = make_request('primary', 'system', 'message', .2, 'writer', ('fallback',))
        with patch('src.gemini_client._call', return_value=('{"lines": []}', {'text': '{}'})) as call:
            raw, response = write_final('synthetic-key', request)
        self.assertEqual(raw, '{"lines": []}')
        self.assertEqual(response, {'text': '{}', 'served_model': 'primary'})
        self.assertEqual(call.call_count, 1)

    def test_exhausted_chain_raises_with_every_attempt_recorded(self):
        request = make_request('primary', 'system', 'message', .2, 'analyst', ('fallback',))
        with patch('src.gemini_client._call', side_effect=[QuotaError(), MissingModelError()]):
            try:
                write_final('synthetic-key', request)
                self.fail('a corrente esgotada precisa propagar o erro')
            except MissingModelError as exc:
                info = error_info(exc)
        self.assertEqual(info['code'], 404)
        self.assertEqual([item['model'] for item in info['attempted_models']], ['primary', 'fallback'])
        self.assertEqual(info['reason'], 'api_failure')
        self.assertIn('fallback', info['hint'].casefold())

    def test_non_fallback_code_stops_before_the_next_model(self):
        request = make_request('primary', 'system', 'message', .2, 'writer', ('fallback',))
        with patch('src.gemini_client._call', side_effect=BadRequestError()) as call:
            self.assertRaises(BadRequestError, write_final, 'synthetic-key', request)
        self.assertEqual(call.call_count, 1)

    def test_quota_error_is_explained_with_recovery_hint(self):
        info = error_info(QuotaError())
        self.assertEqual(info['reason'], 'rate_limit_or_quota_exhausted')
        self.assertIn('429', info['message'])
        self.assertIn('GEMINI_FALLBACK_MODELS', info['hint'])

    def test_raw_error_details_never_leak_into_allowlisted_metadata(self):
        class SyntheticError(Exception):
            code = 500
            details = {'error': {'message': 'internal detail', 'details': [
                {'retryDelay': '7s', 'violations': [{'quotaId': 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'}]}]}}
        info = error_info(SyntheticError())
        self.assertEqual(info['limit_window'], 'day')
        self.assertEqual(info['retry_after_seconds_hint'], 7.0)
        self.assertNotIn('internal detail', str(info))


if __name__ == '__main__':
    unittest.main()
