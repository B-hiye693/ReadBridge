"""服务配置。敏感信息仅通过后端环境变量读取。"""

from __future__ import annotations

from functools import lru_cache
from typing import Optional

from pydantic import AliasChoices, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "阅桥 ReadBridge API"
    app_version: str = "0.2.0"
    ai_provider: str = Field(
        default="mock",
        validation_alias=AliasChoices("AI_PROVIDER", "READBRIDGE_AI_PROVIDER"),
    )
    qwen_api_key: Optional[SecretStr] = Field(default=None, validation_alias="QWEN_API_KEY")
    qwen_model: str = Field(default="qwen-plus", validation_alias="QWEN_MODEL")
    qwen_fast_model: str = Field(default="qwen-flash", validation_alias="QWEN_FAST_MODEL")
    qwen_base_url: str = Field(
        default="",
        validation_alias="QWEN_BASE_URL",
    )
    qwen_timeout_seconds: float = Field(default=120.0, validation_alias="QWEN_TIMEOUT_SECONDS")
    qwen_max_completion_tokens: int = Field(
        default=4200,
        validation_alias="QWEN_MAX_COMPLETION_TOKENS",
    )
    performance_logs: bool = Field(default=True, validation_alias="PERFORMANCE_LOGS")
    easy_read_mode: str = Field(default="fast", validation_alias="EASY_READ_MODE")
    easy_read_max_input_chars: int = Field(default=20_000, validation_alias="EASY_READ_MAX_INPUT_CHARS")
    easy_read_max_blocks: int = Field(default=100, validation_alias="EASY_READ_MAX_BLOCKS")
    easy_read_cache_ttl_seconds: int = Field(default=900, validation_alias="EASY_READ_CACHE_TTL_SECONDS")
    easy_read_cache_max_entries: int = Field(default=64, validation_alias="EASY_READ_CACHE_MAX_ENTRIES")
    tts_provider: str = Field(default="browser", validation_alias="TTS_PROVIDER")
    tts_model: str = Field(default="cosyvoice-v3-flash", validation_alias="TTS_MODEL")
    tts_api_key: Optional[SecretStr] = Field(default=None, validation_alias="TTS_API_KEY")
    tts_base_url: str = Field(default="", validation_alias="TTS_BASE_URL")
    tts_voice: str = Field(default="longyingling_v3", validation_alias="TTS_VOICE")
    tts_timeout_seconds: float = Field(default=60.0, validation_alias="TTS_TIMEOUT_SECONDS")
    tts_audio_format: str = Field(default="mp3", validation_alias="TTS_AUDIO_FORMAT")
    tts_instruction: str = Field(default="", validation_alias="TTS_INSTRUCTION")
    tts_cache_max_entries: int = Field(default=64, validation_alias="TTS_CACHE_MAX_ENTRIES")
    tts_cache_max_bytes: int = Field(default=32 * 1024 * 1024, validation_alias="TTS_CACHE_MAX_BYTES")

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
