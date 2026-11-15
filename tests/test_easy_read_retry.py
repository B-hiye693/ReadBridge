import json
import unittest
import uuid

from starlette.requests import Request

import server.main as main_module
from server.ai import AIProviderError, MockAIProvider
from server.models import EasyReadRequest


class EasyReadRetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_fast_invalid_output_retries_then_falls_back_to_quality(self):
        class FlakyProvider:
            def __init__(self):
                self.calls = []

            async def easy_read(self, text, title, url, content_blocks=None, **kwargs):
                self.calls.append((kwargs["degraded"], kwargs["generation_mode"]))
                if len(self.calls) < 3:
                    raise AIProviderError(
                        "incomplete", code="response_validation_failed", retryable=True
                    )
                return await MockAIProvider().easy_read(
                    text, title, url, content_blocks, **kwargs
                )

        provider = FlakyProvider()
        original = main_module.ai_provider
        main_module.ai_provider = provider
        try:
            payload = EasyReadRequest(
                text="retry-test-" + uuid.uuid4().hex,
                title="Retry test",
                output_language="en-US",
                generation_mode="fast",
            )
            request = Request({"type": "http", "headers": []})
            response = await main_module.easy_read(payload, request)
            self.assertEqual(response.status_code, 200)
            self.assertTrue(json.loads(response.body)["success"])
            self.assertEqual(provider.calls, [
                (False, "fast"), (True, "fast"), (True, "quality")
            ])
        finally:
            main_module.ai_provider = original


if __name__ == "__main__":
    unittest.main()
