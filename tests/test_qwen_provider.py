import json
from pathlib import Path
from types import SimpleNamespace
import unittest

from server.ai import AIProviderError, MockAIProvider, create_ai_provider
from server.qwen_provider import QwenAIProvider
from server.coverage import coverage_plan, recommend_section_range
from server.easy_read_quality import clean_easy_read_result, find_evidence, preserves_uncertainty
from server.models import ActionGuidance, ContentBlock, EasyReadData, EasyReadSection


class FakeCompletions:
    def __init__(self, content: str, finish_reason: str = "stop"):
        self.content = content
        self.finish_reason = finish_reason
        self.last_kwargs = None

    async def create(self, **kwargs):
        self.last_kwargs = kwargs
        message = SimpleNamespace(content=self.content)
        usage = SimpleNamespace(prompt_tokens=120, completion_tokens=80)
        return SimpleNamespace(choices=[SimpleNamespace(message=message, finish_reason=self.finish_reason)], usage=usage)


class FakeClient:
    def __init__(self, content: str, finish_reason: str = "stop"):
        self.completions = FakeCompletions(content, finish_reason)
        self.chat = SimpleNamespace(completions=self.completions)


def make_provider(content: str, finish_reason: str = "stop") -> tuple[QwenAIProvider, FakeClient]:
    client = FakeClient(content, finish_reason)
    provider = QwenAIProvider(
        api_key="local-test-key",
        model="qwen-plus",
        base_url="https://example.invalid/compatible-mode/v1",
        client=client,
    )
    return provider, client


class QwenProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_fast_mode_uses_fast_model_and_small_output_budget(self):
        payload = json.dumps({
            "original": "test", "simple": "simple", "keywords": [], "example": "example"
        })
        client = FakeClient(payload)
        provider = QwenAIProvider(
            api_key="local-test-key", model="qwen-plus", fast_model="qwen-flash",
            base_url="https://example.invalid/compatible-mode/v1", client=client,
        )
        await provider.explain("test", "en-US", "fast")
        self.assertEqual(client.completions.last_kwargs["model"], "qwen-flash")
        self.assertEqual(client.completions.last_kwargs["max_completion_tokens"], 1100)

    async def test_real_client_does_not_inherit_environment_proxy(self):
        provider = QwenAIProvider(
            api_key="local-test-key",
            model="qwen-plus",
            base_url="https://example.invalid/compatible-mode/v1",
        )
        client = provider._create_client()
        self.assertFalse(client._client._trust_env)
        await provider.aclose()

    def test_coverage_plan_contains_beginning_middle_and_end_topics(self):
        blocks = [
            ContentBlock(id=f"rb-{index}", type="heading", text=f"主题{index}", heading_context=f"主题{index}")
            for index in range(1, 25)
        ]
        plan = coverage_plan(blocks, 20_000)
        positions = {group["position"] for group in plan["topic_groups"]}
        all_ids = {block_id for group in plan["topic_groups"] for block_id in group["block_ids"]}
        self.assertEqual(positions, {"beginning", "middle", "end"})
        self.assertIn("rb-1", all_ids)
        self.assertIn("rb-24", all_ids)
        self.assertLessEqual(len(plan["topic_groups"]), 15)

    def test_eight_independent_topics_are_not_forced_to_five(self):
        blocks = []
        sections = []
        original_parts = []
        for index in range(1, 9):
            heading = f"主题{index}"
            source = f"第{index}部分说明独立事实{index}，并给出数据{index}。"
            heading_id = f"rb-{index * 2 - 1}"
            source_id = f"rb-{index * 2}"
            original_parts.extend((heading, source))
            blocks.extend([
                ContentBlock(id=heading_id, type="heading", text=heading, heading_context=heading),
                ContentBlock(id=source_id, type="paragraph", text=source, heading_context=heading),
            ])
            sections.append(EasyReadSection(
                heading=heading,
                content=f"这是独立事实{index}。",
                source_text=source,
                source_block_ids=[source_id],
            ))
        result = EasyReadData(
            title="八个主题", one_sentence="文章介绍八个主题。", sections=sections,
            key_points=[], difficult_words=[], action=ActionGuidance(),
        )
        report = clean_easy_read_result(result, "\n\n".join(original_parts), blocks)
        self.assertEqual(len(result.sections), 8)
        self.assertEqual(report.coverage_ratio, 1.0)
        self.assertEqual(recommend_section_range(blocks, 1000)[1], 8)

    def test_related_but_distinct_viewpoints_are_not_deduplicated(self):
        sources = ["人的工作单位发生变化。", "AI可以全天运行并支持并行任务。"]
        blocks = [
            ContentBlock(id=f"rb-{index}", type="paragraph", text=source, heading_context="工作变化")
            for index, source in enumerate(sources, 1)
        ]
        result = EasyReadData(
            title="变化", one_sentence="文章说明工作方式发生变化。",
            sections=[
                EasyReadSection(heading="工作单位", content="人的工作单位发生变化。", source_text=sources[0], source_block_ids=["rb-1"]),
                EasyReadSection(heading="运行方式", content="AI可以全天运行并支持并行任务。", source_text=sources[1], source_block_ids=["rb-2"]),
            ], key_points=[], difficult_words=[], action=ActionGuidance(),
        )
        clean_easy_read_result(result, "\n\n".join(sources), blocks)
        self.assertEqual(len(result.sections), 2)

    def test_invalid_source_is_recovered_from_valid_block_id(self):
        source = "原文中的可靠事实。"
        blocks = [ContentBlock(id="rb-1", type="paragraph", text=source)]
        result = EasyReadData(
            title="恢复证据", one_sentence="这里有可靠事实。",
            sections=[EasyReadSection(
                heading="事实", content="这里有可靠事实。", source_text="模型写错的证据", source_block_ids=["rb-1"],
            )], key_points=[], difficult_words=[], action=ActionGuidance(),
        )
        clean_easy_read_result(result, source, blocks)
        self.assertEqual(result.sections[0].source_text, source)

    def test_invalid_source_and_block_id_remove_section(self):
        result = EasyReadData(
            title="无证据", one_sentence="测试。",
            sections=[EasyReadSection(
                heading="编造", content="原文没有的内容。", source_text="不存在", source_block_ids=["rb-99"],
            )], key_points=[], difficult_words=[], action=ActionGuidance(),
        )
        clean_easy_read_result(result, "真实原文。", [])
        self.assertEqual(result.sections, [])

    def test_exact_duplicate_is_still_removed(self):
        source = "这是同一个可靠事实。"
        result = EasyReadData(
            title="去重", one_sentence=source,
            sections=[
                EasyReadSection(heading="事实", content="同一个事实。", source_text=source),
                EasyReadSection(heading="重复", content="同一个事实。", source_text=source),
            ], key_points=[], difficult_words=[], action=ActionGuidance(),
        )
        clean_easy_read_result(result, source, [])
        self.assertEqual(len(result.sections), 1)

    async def test_mock_preserves_three_parallel_topics(self):
        topics = ["软件生产方式变化", "人的工作单位变化", "开源交换物变化"]
        blocks = []
        original = []
        for index, topic in enumerate(topics, 1):
            blocks.extend([
                ContentBlock(id=f"rb-{index * 2 - 1}", type="heading", text=topic, heading_context=topic),
                ContentBlock(id=f"rb-{index * 2}", type="paragraph", text=f"{topic}是第{index}个独立观点。", heading_context=topic),
            ])
            original.extend([topic, f"{topic}是第{index}个独立观点。"])
        result = await MockAIProvider().easy_read("\n\n".join(original), "三个变化", "https://example.com", blocks)
        used_ids = {block_id for section in result.sections for block_id in section.source_block_ids}
        self.assertTrue({"rb-2", "rb-4", "rb-6"}.issubset(used_ids))

    def test_table_rows_and_people_can_remain_independent_facts(self):
        sources = ["接口数量 | 2路", "默认形态 | 干接点", "张三认为成本下降。", "李四认为合作方式改变。"]
        blocks = [ContentBlock(id=f"rb-{index}", type="table_row" if index < 3 else "quote", text=source) for index, source in enumerate(sources, 1)]
        result = EasyReadData(
            title="多个事实", one_sentence="文章包含参数和人物观点。",
            sections=[EasyReadSection(
                heading=f"事实{index}", content=source, source_text=source, source_block_ids=[f"rb-{index}"],
            ) for index, source in enumerate(sources, 1)],
            key_points=[], difficult_words=[], action=ActionGuidance(),
        )
        clean_easy_read_result(result, "\n".join(sources), blocks)
        self.assertEqual(len(result.sections), 4)

    def test_factory_keeps_mock_as_default_option(self):
        self.assertIsInstance(create_ai_provider("mock"), MockAIProvider)

    async def test_missing_key_fails_without_network_request(self):
        provider = QwenAIProvider(
            api_key="",
            model="qwen-plus",
            base_url="https://example.invalid/compatible-mode/v1",
        )
        with self.assertRaisesRegex(AIProviderError, "QWEN_API_KEY"):
            await provider.explain("测试文本")

    async def test_missing_base_url_fails_without_network_request(self):
        provider = QwenAIProvider(
            api_key="local-test-key",
            model="qwen-plus",
            base_url="",
        )
        with self.assertRaisesRegex(AIProviderError, "QWEN_BASE_URL"):
            await provider.explain("测试文本")

    async def test_explain_accepts_fenced_json_and_preserves_original(self):
        response = {
            "original": "模型改写的文本",
            "simple": "这是一段简单解释。",
            "keywords": [{"word": "术语", "explanation": "简单说明"}],
            "example": "这是例子。",
        }
        provider, client = make_provider(
            f"```json\n{json.dumps(response, ensure_ascii=False)}\n```"
        )
        result = await provider.explain("服务器收到的原文")
        self.assertEqual(result.original, "服务器收到的原文")
        self.assertEqual(result.simple, "这是一段简单解释。")
        request = client.completions.last_kwargs
        self.assertEqual(request["response_format"], {"type": "json_object"})
        self.assertFalse(request["extra_body"]["enable_thinking"])

    async def test_easy_read_validates_source_text(self):
        source = "官方宣布，任务没有成功。"
        response = {
            "title": "测试文章",
            "one_sentence": "任务没有成功。",
            "sections": [
                {
                    "icon": "📊",
                    "heading": "结果怎么样？",
                    "content": "任务没有成功。",
                    "source_text": source,
                },
                {
                    "icon": "🔍",
                    "heading": "为什么？",
                    "content": "原文没有说明具体原因。",
                    "source_text": "模型编造的原文",
                },
            ],
            "key_points": [
                {"label": "结果", "value": "任务没有成功", "source_text": source},
                {"label": "影响", "value": "可能影响后续计划", "source_text": "原文没有这句话"},
            ],
            "difficult_words": [{"word": "入轨", "simple": "进入轨道"}],
            "action": {"needed": False, "title": "你需要做什么？", "steps": ["不应保留"], "source_text": source},
        }
        provider, _ = make_provider(
            f"结果如下：{json.dumps(response, ensure_ascii=False)}"
        )
        result = await provider.easy_read(source, "测试文章", "https://example.com")
        self.assertEqual(result.sections[0].source_text, source)
        self.assertEqual(len(result.sections), 1)
        self.assertEqual(result.sections[0].source_text, source)
        self.assertEqual(len(result.key_points), 1)
        self.assertEqual(result.key_points[0].label, "结果")
        self.assertEqual(result.difficult_words, [])
        self.assertEqual(result.action.steps, [])

    async def test_easy_read_validates_and_preserves_real_block_ids(self):
        source = "接口说明\n\n表格：\n| 路数 | 2路 |\n| 默认形态 | 干接点 |"
        blocks = [
            ContentBlock(id="rb-1", type="heading", text="接口说明"),
            ContentBlock(id="rb-2", type="table_row", text="路数 | 2路", heading_context="接口说明"),
            ContentBlock(id="rb-3", type="table_row", text="默认形态 | 干接点", heading_context="接口说明"),
        ]
        response = {
            "title": "DI使用说明",
            "one_sentence": "数字输入共有2路。",
            "sections": [{
                "icon": "📌", "heading": "路数", "content": "共有2路数字输入。",
                "source_text": "路数 | 2路", "source_block_ids": ["rb-2", "rb-999"],
            }],
            "key_points": [{
                "label": "默认形态", "value": "干接点",
                "source_text": "默认形态 | 干接点", "source_block_ids": ["rb-3"],
            }],
            "difficult_words": [{
                "word": "干接点", "simple": "一种触点形态。",
                "source_text": "默认形态 | 干接点", "source_block_ids": ["rb-3", "rb-404"],
            }],
            "action": {"needed": False, "title": "", "steps": [], "source_text": "", "source_block_ids": ["rb-999"]},
        }
        provider, client = make_provider(json.dumps(response, ensure_ascii=False))
        result = await provider.easy_read(source, "DI使用说明", "https://example.com", blocks)
        self.assertEqual(result.sections[0].source_block_ids, ["rb-2"])
        self.assertEqual(result.key_points[0].source_block_ids, ["rb-3"])
        self.assertEqual(result.difficult_words[0].source_block_ids, ["rb-3"])
        self.assertEqual(result.difficult_words[0].source_text, "默认形态 | 干接点")
        self.assertEqual(result.action.source_block_ids, [])
        prompt = client.completions.last_kwargs["messages"][1]["content"]
        self.assertIn('"id": "rb-2"', prompt)
        self.assertIn('"text": ""', prompt)

    async def test_easy_read_quality_removes_duplicates_and_unproved_action(self):
        source = "通知：10月12日前，请携带身份证到服务中心办理。"
        response = {
            "title": "办理通知",
            "one_sentence": "请在规定时间携带身份证办理业务。" * 8,
            "sections": [
                {"icon": "📌", "heading": "要做什么？", "content": "请携带身份证办理。", "source_text": "请携带身份证到服务中心办理。"},
                {"icon": "📌", "heading": "重复", "content": "请携带身份证办理。", "source_text": "请携带身份证到服务中心办理。"},
            ],
            "key_points": [{"label": "材料", "value": "身份证", "source_text": "请携带身份证到服务中心办理。"}],
            "difficult_words": [],
            "action": {"needed": True, "title": "你需要做什么？", "steps": ["去网上提交"], "source_text": "请在线提交"},
        }
        provider, _ = make_provider(json.dumps(response, ensure_ascii=False))
        result = await provider.easy_read(source, "办理通知", "https://example.com")
        self.assertEqual(len(result.sections), 1)
        self.assertLessEqual(len(result.one_sentence), 241)
        self.assertFalse(result.action.needed)

    def test_evidence_allows_whitespace_and_common_punctuation_only(self):
        original = "官方宣布：任务 没有成功。原因正在调查。"
        self.assertEqual(
            find_evidence("官方宣布:任务没有成功。", original),
            "官方宣布：任务 没有成功。",
        )
        self.assertEqual(find_evidence("任务提前失败。", original), "")
        self.assertTrue(preserves_uncertainty("原因尚不清楚。", "目前还不知道原因。"))
        self.assertFalse(preserves_uncertainty("上部似乎发生变形。", "上部发生了变形。"))

    async def test_unsupported_absolute_claim_in_word_explanation_is_removed(self):
        source = "最大动压点附近，火箭以极高速度飞行，承受很强的大气作用力。"
        response = {
            "title": "科普",
            "one_sentence": "火箭经过最大动压点。",
            "sections": [{"icon": "🚀", "heading": "飞行", "content": "火箭高速飞行。", "source_text": source}],
            "key_points": [],
            "difficult_words": [{"word": "最大动压点", "simple": "火箭飞得最快的时刻"}],
            "action": {"needed": False, "title": "", "steps": [], "source_text": ""},
        }
        provider, _ = make_provider(json.dumps(response, ensure_ascii=False))
        result = await provider.easy_read(source, "科普", "https://example.com")
        self.assertEqual(result.difficult_words, [])

    async def test_invalid_structure_raises_provider_error(self):
        provider, _ = make_provider('{"simple":"字段不完整"}')
        with self.assertRaisesRegex(AIProviderError, "数据结构"):
            await provider.explain("测试文本")

    async def test_invalid_json_raises_provider_error(self):
        provider, _ = make_provider("not json")
        with self.assertRaisesRegex(AIProviderError, "有效的 JSON"):
            await provider.explain("测试文本")

    async def test_finish_reason_length_is_classified_as_retryable_truncation(self):
        provider, _ = make_provider('{"title":"incomplete"', "length")
        with self.assertRaises(AIProviderError) as raised:
            await provider.easy_read("测试正文", "测试", "https://example.com", request_id="req-length")
        self.assertEqual(raised.exception.code, "truncated_model_output")
        self.assertTrue(raised.exception.retryable)
        self.assertEqual(raised.exception.request_id, "req-length")

    async def test_provider_429_is_not_retryable(self):
        class RateLimitCompletions:
            async def create(self, **_kwargs):
                error = RuntimeError("rate limited"); error.status_code = 429; raise error
        client = SimpleNamespace(chat=SimpleNamespace(completions=RateLimitCompletions()))
        provider = QwenAIProvider(api_key="test", model="qwen-plus", base_url="https://example.invalid", client=client)
        with self.assertRaises(AIProviderError) as raised:
            await provider.easy_read("测试", "测试", "https://example.com", request_id="req-429")
        self.assertEqual(raised.exception.code, "quota_exceeded")
        self.assertFalse(raised.exception.retryable)

    async def test_provider_timeout_is_retryable(self):
        APITimeoutError = type("APITimeoutError", (RuntimeError,), {})
        class TimeoutCompletions:
            async def create(self, **_kwargs): raise APITimeoutError("timeout")
        client = SimpleNamespace(chat=SimpleNamespace(completions=TimeoutCompletions()))
        provider = QwenAIProvider(api_key="test", model="qwen-plus", base_url="https://example.invalid", client=client)
        with self.assertRaises(AIProviderError) as raised:
            await provider.easy_read("测试", "测试", "https://example.com", request_id="req-timeout")
        self.assertEqual(raised.exception.code, "provider_timeout")
        self.assertTrue(raised.exception.retryable)

    async def test_five_fixture_types_keep_valid_mock_structure(self):
        fixture_dir = Path(__file__).parent / "fixtures" / "easy_read"
        provider = MockAIProvider()
        fixture_names = {
            "news.txt", "notice.txt", "science.txt", "service_guide.txt", "technical.txt"
        }
        self.assertEqual({path.name for path in fixture_dir.glob("*.txt")}, fixture_names)
        for path in fixture_dir.glob("*.txt"):
            text = path.read_text(encoding="utf-8").strip()
            result = await provider.easy_read(text, path.stem, "https://example.com")
            self.assertTrue(result.one_sentence)
            self.assertGreaterEqual(len(result.sections), 1)
            self.assertLessEqual(len(result.sections), 5)
            for section in result.sections:
                self.assertTrue(section.heading)
                self.assertTrue(section.content)
                if section.source_text:
                    self.assertIn(section.source_text, text)
            for point in result.key_points:
                self.assertTrue(point.label)
                self.assertTrue(point.value)
                self.assertIn(point.source_text, text)
            for word in result.difficult_words:
                self.assertIn(word.word, text)


if __name__ == "__main__":
    unittest.main()
