import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from zipfile import ZipFile

import app
from src.gemini_client import generate_judgment


class CLITests(unittest.TestCase):
    def test_discovery_none_single_multiple(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            root = Path(directory)
            self.assertIsNone(app.choose_zip(root))
            (root / 'a.zip').touch()
            self.assertEqual(app.choose_zip(root).name, 'a.zip')
            (root / 'b.ZIP').touch()
            with patch('builtins.input', side_effect=['bad', '9', '2']):
                self.assertEqual(app.choose_zip(root).name, 'b.ZIP')

    def run_app(self, root: Path, arguments: list[str], api_key: str = '') -> int:
        with patch.object(app, 'ROOT', root), patch.object(app.Path, 'cwd', return_value=root), \
                patch('sys.argv', ['app.py'] + arguments), \
                patch.dict(os.environ, {'GEMINI_API_KEY': api_key, 'MAX_CONTEXT_CHARS': '300000'}), \
                contextlib.redirect_stdout(io.StringIO()):
            return app.main()

    def prepare(self, root: Path) -> None:
        (root / 'prompts').mkdir()
        (root / 'prompts' / 'judge.txt').write_text('Synthetic prompt', encoding='utf-8')
        with ZipFile(root / 'synthetic.zip', 'w') as archive:
            archive.writestr('ratings.csv', 'Name,Year,Rating\nSynthetic,2000,4\n')

    def test_without_key_and_dry_run_never_call_gemini(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(app, 'generate_judgment') as call:
            root = Path(directory)
            self.prepare(root)
            self.assertEqual(self.run_app(root, []), 0)
            self.assertEqual(self.run_app(root, ['--dry-run'], 'synthetic-key'), 0)
            call.assert_not_called()
            self.assertEqual((root / 'output' / 'judgment.txt').read_text(), '')
            self.assertEqual(json.loads((root / 'output' / 'run_status.json').read_text())['gemini'], 'skipped')

    def test_exact_text_and_request_and_stale_response(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.prepare(root)
            response = 'Primeira linha.\n\nÚltima linha.\n'
            with patch.object(app, 'generate_judgment', return_value=(response, {'text': response})) as call:
                self.assertEqual(self.run_app(root, [], 'synthetic-key'), 0)
                saved = json.loads((root / 'output' / 'ai_request.json').read_text(encoding='utf-8'))
                self.assertEqual(saved, call.call_args.args[1])
                self.assertEqual((root / 'output' / 'judgment.txt').read_bytes(), response.encode('utf-8'))
            self.assertEqual(self.run_app(root, ['--dry-run']), 0)
            self.assertFalse((root / 'output' / 'ai_response.json').exists())

    def test_sdk_configuration_without_network(self):
        from google.genai import types
        request = {'model': 'synthetic-model', 'contents': '{}',
                   'config': {'system_instruction': 'test', 'temperature': .8}}
        response = MagicMock(text='ok')
        response.model_dump.return_value = {'text': 'ok'}
        with patch('google.genai.Client') as client:
            client.return_value.__enter__.return_value.models.generate_content.return_value = response
            self.assertEqual(generate_judgment('synthetic-key', request), ('ok', {'text': 'ok'}))
            arguments = client.return_value.__enter__.return_value.models.generate_content.call_args.kwargs
            self.assertIsInstance(arguments['config'], types.GenerateContentConfig)
            self.assertEqual(arguments['contents'], '{}')


if __name__ == '__main__':
    unittest.main()
