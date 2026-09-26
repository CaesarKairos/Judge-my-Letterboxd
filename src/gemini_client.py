from typing import Any


def generate_judgment(api_key: str, request: dict[str, Any]) -> tuple[str, dict]:
    from google import genai
    from google.genai import types

    with genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=120_000)) as client:
        response = client.models.generate_content(
            model=request['model'], contents=request['contents'],
            config=types.GenerateContentConfig(**request['config']))
        return response.text or '', response.model_dump(mode='json', exclude_none=True)
