"""AI Provider 抽象层与第一阶段 Mock 实现。"""

from __future__ import annotations

from abc import ABC, abstractmethod
import logging
import re

from .models import (
    ActionGuidance,
    ContentBlock,
    DifficultWord,
    EasyReadData,
    EasyReadKeyPoint,
    EasyReadSection,
    ExplainData,
    KeywordExplanation,
)
from .easy_read_quality import clean_easy_read_result
from .coverage import coverage_plan

logger = logging.getLogger(__name__)


class AIProviderError(RuntimeError):
    """可安全返回给前端的 AI 错误；原始异常只保留在服务端异常链中。"""

    def __init__(self, message: str, *, code: str = "unknown_provider_error",
                 status_code: int = 502, retryable: bool = False,
                 provider_status: int | None = None, request_id: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.retryable = retryable
        self.provider_status = provider_status
        self.request_id = request_id

    def public_detail(self, fallback_request_id: str = "") -> dict[str, object]:
        return {
            "code": self.code, "message": str(self),
            "request_id": self.request_id or fallback_request_id,
            "provider_status": self.provider_status,
            "retryable": self.retryable,
        }


class AIProvider(ABC):
    """所有真实模型接入都应实现此接口。"""

    @abstractmethod
    async def explain(self, text: str, output_language: str = "auto", generation_mode: str = "quality") -> ExplainData:
        raise NotImplementedError

    @abstractmethod
    async def easy_read(
        self, text: str, title: str, url: str,
        content_blocks: list[ContentBlock] | None = None,
        *, degraded: bool = False, request_id: str = "", output_language: str = "auto", generation_mode: str = "quality",
    ) -> EasyReadData:
        raise NotImplementedError


class MockAIProvider(AIProvider):
    """无需模型即可演示完整链路的确定性实现。"""

    _TERM_HINTS = {
        "鉴于": "考虑到、因为",
        "切实": "认真并真正做到",
        "生命财产安全": "人的安全和财物安全",
        "相关人员": "与这件事有关的人",
        "极端天气": "非常严重或少见的天气",
        "频发": "经常发生",
        "实施": "开始执行",
        "须": "必须、需要",
    }

    # 句内替换需要兼顾前后语法，和单独展示给用户的术语解释分开维护。
    _TEXT_REPLACEMENTS = {
        **_TERM_HINTS,
        "生命财产安全": "安全（包括人身和财物）",
        "相关人员": "有关人员的",
    }

    _DIFFICULT_WORDS = {
        **_TERM_HINTS,
        "最大动压": "物体高速飞行时，空气对它产生压力最大的阶段",
        "运载火箭": "把卫星或其他设备送入太空的火箭",
        "交通管制": "在一段时间内限制车辆或行人通行",
        "临时性": "只在一段时间内实行，不是永久的",
    }

    async def explain(self, text: str, output_language: str = "auto", generation_mode: str = "quality") -> ExplainData:
        use_english = output_language == "en-US" or (output_language == "auto" and not re.search(r"[\u3400-\u9fff]", text))
        if use_english:
            cleaned = re.sub(r"\s+", " ", text).strip()
            return ExplainData(
                original=text,
                simple=f"In simple terms: {self._shorten(cleaned, 260)}",
                keywords=[KeywordExplanation(word="Main point", explanation="Focus on what happened, why it matters, and whether any action is required.")],
                example="For example, identify the main event first, then check the evidence and the next step.",
            )
        simple = self._simplify(text)
        keywords = [
            KeywordExplanation(word=term, explanation=meaning)
            for term, meaning in self._TERM_HINTS.items()
            if term in text
        ][:5]

        if not keywords:
            keywords = [
                KeywordExplanation(
                    word="重点信息",
                    explanation="这段话最重要的是弄清楚发生了什么，以及你是否需要采取行动。",
                )
            ]

        return ExplainData(
            original=text,
            simple=simple,
            keywords=keywords,
            example="例如：先确认这件事是否与你有关，再按照文中的时间、地点和步骤去做。",
        )

    async def easy_read(
        self, text: str, title: str, url: str,
        content_blocks: list[ContentBlock] | None = None,
        *, degraded: bool = False, request_id: str = "", output_language: str = "auto", generation_mode: str = "quality",
    ) -> EasyReadData:
        """生成可演示完整交互的结构化 Mock 数据，不推测原文事实。"""
        use_english = output_language == "en-US" or (output_language == "auto" and not re.search(r"[\u3400-\u9fff]", text))
        if use_english:
            sentences = self._sentences(text)
            first = self._shorten(sentences[0], 120)
            return EasyReadData(
                title=self._shorten(title or "Current document", 80),
                one_sentence=first,
                sections=[EasyReadSection(icon="📌", heading="What is this about?", content=first, source_text=sentences[0])],
                key_points=[EasyReadKeyPoint(label="Main point", value=first, source_text=sentences[0])],
                difficult_words=[],
                action=ActionGuidance(needed=False, title="What do you need to do?", steps=[]),
            )
        sentences = self._sentences(text)
        first = sentences[0]
        result_source = self._find_sentence(
            sentences, ("失败", "成功", "结果", "造成", "导致", "宣布", "异常")
        )
        reason_source = self._find_sentence(
            sentences, ("由于", "因为", "原因", "为了", "鉴于")
        )
        time_source = self._find_sentence(
            sentences, ("年", "月", "日", "时", "今天", "昨日", "目前", "从现在")
        )
        place_source = self._find_sentence(
            sentences, ("在", "位于", "地点", "地区", "现场", "海南", "北京", "上海")
        )

        sections = [
            self._section("📌", "发生了什么？", first),
        ]
        if result_source and result_source != first:
            sections.append(self._section("📊", "结果怎么样？", result_source))
        if reason_source:
            sections.append(self._section("🔍", "为什么？", reason_source))
        elif result_source:
            sections.append(
                EasyReadSection(
                    icon="🔍",
                    heading="为什么？",
                    content="原文没有说明具体原因。",
                    source_text="",
                )
            )
        if time_source and time_source not in {first, result_source, reason_source}:
            sections.append(self._section("🕒", "什么时候？", time_source))
        if place_source and place_source not in {
            first,
            result_source,
            reason_source,
            time_source,
        }:
            sections.append(self._section("📍", "在哪里？", place_source))

        # 有结构化正文块时，按覆盖计划生成演示卡片，确保 Mock 也能覆盖并列主题。
        if content_blocks:
            block_map = {block.id: block for block in content_blocks}
            planned_sections = []
            for topic in coverage_plan(content_blocks, len(text))["topic_groups"]:
                evidence_blocks = [
                    block_map[block_id]
                    for block_id in topic["block_ids"]
                    if block_id in block_map and block_map[block_id].type != "heading"
                ]
                if not evidence_blocks:
                    evidence_blocks = [
                        block_map[block_id]
                        for block_id in topic["block_ids"]
                        if block_id in block_map
                    ]
                if not evidence_blocks:
                    continue
                source = evidence_blocks[0].text
                planned_sections.append(EasyReadSection(
                    icon="📌",
                    heading=self._shorten(topic["heading"], 50),
                    content=self._plain_sentence(source, 180),
                    source_text=source,
                    source_block_ids=[evidence_blocks[0].id],
                ))
            if planned_sections:
                sections = planned_sections

        key_sources: list[str] = []
        for source in (first, result_source, time_source, place_source):
            if source and source not in key_sources:
                key_sources.append(source)
        key_points = [
            EasyReadKeyPoint(
                label=self._key_point_label(item),
                value=self._plain_sentence(item, 85),
                source_text=item,
            )
            for item in key_sources[:4]
        ]

        difficult_words = [
            DifficultWord(word=term, simple=meaning)
            for term, meaning in self._DIFFICULT_WORDS.items()
            if term in text
        ][:5]

        action_source = self._find_sentence(
            sentences, ("需要", "必须", "应当", "请", "携带", "办理", "更换路线")
        )
        action = ActionGuidance(
            needed=bool(action_source),
            steps=[self._plain_sentence(action_source, 90)] if action_source else [],
            source_text=action_source,
        )
        one_sentence_source = result_source or first
        result = EasyReadData(
            title=self._shorten(title or "当前网页", 80),
            one_sentence=self._plain_sentence(one_sentence_source, 100),
            sections=sections[:15],
            key_points=key_points,
            difficult_words=difficult_words,
            action=action,
        )
        self._attach_mock_evidence_blocks(result, content_blocks or [])
        report = clean_easy_read_result(result, text, content_blocks or [])
        logger.info(
            "ReadBridge EasyRead | Provider: mock | Model: rules | Input: %d chars | "
            "Sections: %d | KeyPoints: %d | DifficultWords: %d | RejectedEvidence: %d | Coverage: %.1f%%",
            len(text), len(result.sections), len(result.key_points),
            len(result.difficult_words), report.rejected_evidence,
            report.coverage_ratio * 100,
        )
        return result

    @staticmethod
    def _attach_mock_evidence_blocks(result: EasyReadData, blocks: list[ContentBlock]) -> None:
        """Mock 模式也返回真实存在的块编号，便于离线演示定位链路。"""
        def ids_for(source: str, word: str = "") -> list[str]:
            normalized_source = re.sub(r"\s+", "", source or "")
            normalized_word = re.sub(r"\s+", "", word or "")
            matches = []
            for block in blocks:
                block_text = re.sub(r"\s+", "", block.text)
                if normalized_source and (normalized_source in block_text or block_text in normalized_source):
                    matches.append(block.id)
                elif normalized_word and normalized_word in block_text:
                    matches.append(block.id)
                if len(matches) == 3:
                    break
            return matches

        for section in result.sections:
            section.source_block_ids = ids_for(section.source_text)
        for point in result.key_points:
            point.source_block_ids = ids_for(point.source_text)
        for word in result.difficult_words:
            word.source_text = next((block.text for block in blocks if word.word in block.text), "")
            word.source_block_ids = ids_for(word.source_text, word.word)
        result.action.source_block_ids = ids_for(result.action.source_text)

    def _section(self, icon: str, heading: str, source: str) -> EasyReadSection:
        return EasyReadSection(
            icon=icon,
            heading=heading,
            content=self._plain_sentence(source, 150),
            source_text=source,
        )

    @staticmethod
    def _key_point_label(source: str) -> str:
        if any(term in source for term in ("年", "月", "日", "时", "今天", "昨日")):
            return "时间"
        if any(term in source for term in ("地点", "位于", "海南", "北京", "上海")):
            return "地点"
        if any(term in source for term in ("失败", "成功", "结果", "造成", "导致")):
            return "结果"
        return "重点"

    @staticmethod
    def _sentences(text: str) -> list[str]:
        items = [
            item.strip()
            for item in re.split(r"(?<=[。！？!?；;])|\n+", text)
            if item.strip()
        ]
        return items or [text.strip()]

    @staticmethod
    def _find_sentence(sentences: list[str], terms: tuple[str, ...]) -> str:
        return next((item for item in sentences if any(term in item for term in terms)), "")

    def _plain_sentence(self, text: str, limit: int) -> str:
        result = text
        for term, meaning in self._TEXT_REPLACEMENTS.items():
            result = result.replace(term, meaning)
        result = re.sub(r"[；;]", "。", result)
        result = re.sub(r"\s+", " ", result).strip()
        return self._shorten(result, limit)

    def _simplify(self, text: str) -> str:
        result = text
        for term, meaning in self._TEXT_REPLACEMENTS.items():
            result = result.replace(term, meaning)

        # 将常见长句分隔符改成短句，方便认知阅读。
        result = re.sub(r"[；;]", "。", result)
        result = re.sub(r"[，,](?=.{12,})", "。", result)
        result = re.sub(r"。+", "。", result).strip(" 。")
        if len(result) > 260:
            result = result[:260].rstrip() + "……"
        return f"简单来说：{result}。"

    @staticmethod
    def _shorten(text: str, limit: int = 100) -> str:
        cleaned = re.sub(r"\s+", " ", text).strip()
        return cleaned if len(cleaned) <= limit else cleaned[:limit].rstrip() + "……"


def create_ai_provider(
    provider_name: str,
    *,
    qwen_api_key: str | None = None,
    qwen_model: str = "qwen-plus",
    qwen_fast_model: str = "qwen-flash",
    qwen_base_url: str = "",
    qwen_timeout_seconds: float = 120.0,
    qwen_max_completion_tokens: int = 6000,
    easy_read_max_input_chars: int = 20_000,
    easy_read_max_blocks: int = 100,
    performance_logs: bool = True,
) -> AIProvider:
    """根据后端配置创建 Provider；浏览器端永远不接触模型密钥。"""
    normalized_name = provider_name.strip().lower()
    if normalized_name == "mock":
        return MockAIProvider()
    if normalized_name == "qwen":
        # 延迟导入，确保离线 Mock 模式不强制加载真实模型客户端。
        from .qwen_provider import QwenAIProvider

        return QwenAIProvider(
            api_key=qwen_api_key,
            model=qwen_model,
            fast_model=qwen_fast_model,
            base_url=qwen_base_url,
            timeout_seconds=qwen_timeout_seconds,
            max_completion_tokens=qwen_max_completion_tokens,
            easy_read_max_input_chars=easy_read_max_input_chars,
            easy_read_max_blocks=easy_read_max_blocks,
            performance_logs=performance_logs,
        )
    raise ValueError(f"不支持的 AI Provider: {provider_name}")
