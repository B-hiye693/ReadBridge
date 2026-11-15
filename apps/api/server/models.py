"""API 请求和响应的数据模型。"""

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator


class ExplainRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=10_000, description="需要解释的原文")
    output_language: Literal["auto", "zh-CN", "en-US"] = Field(
        default="auto", description="输出语言；auto 表示跟随原文"
    )
    generation_mode: Literal["fast", "quality"] = Field(
        default="quality", description="生成模式；桌面端可显式使用 fast"
    )

    @field_validator("text")
    @classmethod
    def normalize_text(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("文本不能为空")
        return normalized


class KeywordExplanation(BaseModel):
    word: str
    explanation: str


class ExplainData(BaseModel):
    original: str
    simple: str
    keywords: list[KeywordExplanation]
    example: str


class ExplainResponse(BaseModel):
    success: bool = True
    data: ExplainData


class ContentBlock(BaseModel):
    id: str = Field(..., pattern=r"^rb-\d+$", max_length=32)
    type: str = Field(..., max_length=32)
    text: str = Field(..., min_length=1, max_length=4_000)
    heading_context: str = Field(default="", max_length=500)


class EasyReadRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=60_000, description="网页正文")
    title: str = Field(default="", max_length=500, description="网页标题")
    url: str = Field(default="", max_length=2_000, description="网页地址")
    content_blocks: list[ContentBlock] = Field(
        default_factory=list,
        max_length=1_500,
        description="正文提取阶段生成的可追溯内容块",
    )
    degraded: bool = Field(default=False, description="长文失败后的单次精简重试")
    strategy: str = Field(default="", max_length=80)
    truncated: bool = False
    metrics: dict[str, Any] = Field(default_factory=dict)
    output_language: Literal["auto", "zh-CN", "en-US"] = Field(
        default="auto", description="输出语言；auto 表示跟随原文"
    )
    generation_mode: Literal["fast", "quality"] = Field(
        default="quality", description="生成模式；fast 使用低延迟模型和较紧凑输出"
    )

    @field_validator("text")
    @classmethod
    def normalize_page_text(cls, value: str) -> str:
        normalized = "\n".join(
            line.strip() for line in value.splitlines() if line.strip()
        )
        if not normalized:
            raise ValueError("网页正文不能为空")
        return normalized
class EasyReadSection(BaseModel):
    icon: str = "📌"
    heading: str
    content: str
    source_text: str = ""
    source_block_ids: list[str] = Field(default_factory=list, max_length=12)


class DifficultWord(BaseModel):
    word: str
    simple: str
    source_text: str = ""
    source_block_ids: list[str] = Field(default_factory=list, max_length=12)


class EasyReadKeyPoint(BaseModel):
    label: str
    value: str
    source_text: str = ""
    source_block_ids: list[str] = Field(default_factory=list, max_length=12)


class ActionGuidance(BaseModel):
    needed: bool = False
    title: str = "你需要做什么？"
    steps: list[str] = Field(default_factory=list)
    source_text: str = ""
    source_block_ids: list[str] = Field(default_factory=list, max_length=12)


class EasyReadData(BaseModel):
    title: str
    one_sentence: str
    sections: list[EasyReadSection]
    key_points: list[EasyReadKeyPoint]
    difficult_words: list[DifficultWord]
    action: ActionGuidance


class EasyReadResponse(BaseModel):
    success: bool = True
    data: EasyReadData


class ErrorDetail(BaseModel):
    message: str
    code: str = ""
    provider_status: Optional[int] = None
    request_id: str = ""
    retryable: bool = False


class ErrorResponse(BaseModel):
    success: bool = False
    error: ErrorDetail


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=600)
    language: Literal["zh-CN", "en-US"] = "zh-CN"
    voice: str = Field(default="", max_length=80, pattern=r"^[A-Za-z0-9_-]*$")
    rate: float = Field(default=0.9, ge=0.5, le=2.0)
    style: Literal["normal", "warm", "gentle", "clear"] = "warm"

    @field_validator("text")
    @classmethod
    def normalize_tts_text(cls, value: str) -> str:
        normalized = "\n".join(line.strip() for line in value.splitlines() if line.strip())
        if not normalized:
            raise ValueError("朗读文本不能为空")
        return normalized


class TTSVoice(BaseModel):
    id: str
    name: str
    language: str = "zh-CN"
    gender: Literal["female", "male", "unknown"] = "unknown"


class TTSVoicesResponse(BaseModel):
    success: bool = True
    provider: str
    provider_name: str
    default_voice: str
    voices: list[TTSVoice]
    neural: bool = False
