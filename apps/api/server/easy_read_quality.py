"""Easy Read 输出的事实证据校验与温和质量清理。"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from .coverage import audit_coverage, coverage_plan, recommend_section_range
from .models import ContentBlock, EasyReadData


_PUNCTUATION = str.maketrans(
    {
        "，": ",", "。": ".", "；": ";", "：": ":", "！": "!", "？": "?",
        "（": "(", "）": ")", "【": "[", "】": "]", "“": '"', "”": '"',
        "‘": "'", "’": "'", "、": ",", "—": "-", "–": "-", "…": ".",
    }
)
_HIGH_RISK_ASSERTIONS = ("最快", "最早", "最晚", "唯一", "必然", "肯定", "一定会", "完全", "全部")
_UNCERTAINTY_EQUIVALENTS = {
    "似乎": ("似乎", "看起来", "好像"),
    "据称": ("据称", "称", "表示"),
    "有人认为": ("有人认为", "有人说"),
    "尚未确认": ("尚未确认", "还没有确认", "没有确认", "未确认"),
    "尚不清楚": ("尚不清楚", "还不知道", "不清楚", "不知道"),
}


@dataclass
class QualityReport:
    rejected_evidence: int = 0
    removed_sections: int = 0
    removed_key_points: int = 0
    removed_difficult_words: int = 0
    coverage_ratio: float = 1.0
    covered_block_ids: list[str] | None = None
    important_block_ids: list[str] | None = None
    possibly_omitted_topics: list[str] | None = None


def _normalized_with_positions(value: str) -> tuple[str, list[int]]:
    normalized: list[str] = []
    positions: list[int] = []
    for index, original_char in enumerate(value):
        for char in unicodedata.normalize("NFKC", original_char).translate(_PUNCTUATION):
            if char.isspace():
                continue
            normalized.append(char.lower())
            positions.append(index)
    return "".join(normalized), positions


def find_evidence(source: str, original: str) -> str:
    """允许空白和常见标点差异，但不使用语义相似来放宽证据。"""
    candidate, _ = _normalized_with_positions(source.strip())
    haystack, positions = _normalized_with_positions(original)
    if not candidate or not haystack:
        return ""
    start = haystack.find(candidate)
    if start < 0:
        return ""
    end = start + len(candidate) - 1
    return original[positions[start] : positions[end] + 1].strip()


def _shorten_at_sentence(text: str, limit: int) -> str:
    cleaned = re.sub(r"[ \t]+", " ", text).strip()
    # 英文同一信息通常占用更多字符，不能沿用按汉字设计的上限，
    # 否则会在单词或句子中间出现“总结到一半”。
    chinese = len(re.findall(r"[\u3400-\u9fff]", cleaned))
    latin = len(re.findall(r"[A-Za-z]", cleaned))
    effective_limit = limit * 2 if latin > chinese * 2 else limit
    if len(cleaned) <= effective_limit:
        return cleaned
    prefix = cleaned[:effective_limit]
    boundary = max(prefix.rfind(mark) for mark in "。！？!?.")
    if boundary >= effective_limit // 2:
        return prefix[: boundary + 1]
    if latin > chinese * 2:
        word_boundary = prefix.rfind(" ")
        if word_boundary >= effective_limit // 2:
            prefix = prefix[:word_boundary]
    return prefix.rstrip(" ,;，；") + "…"


def _fingerprint(text: str) -> str:
    return re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", text)).lower()


def preserves_uncertainty(source: str, generated: str) -> bool:
    """防止简化时把原文的保留语气改成确定事实。"""
    return all(
        marker not in source or any(equivalent in generated for equivalent in equivalents)
        for marker, equivalents in _UNCERTAINTY_EQUIVALENTS.items()
    )


def _validated_block_ids(ids: list[str], valid_ids: set[str]) -> list[str]:
    """只保留本次输入真实存在的块编号，并保持模型返回顺序。"""
    seen: set[str] = set()
    return [block_id for block_id in ids if block_id in valid_ids and not (block_id in seen or seen.add(block_id))][:12]


def _evidence_from_blocks(ids: list[str], blocks: dict[str, ContentBlock], original: str) -> str:
    texts = [blocks[block_id].text for block_id in ids if block_id in blocks]
    if not texts:
        return ""
    combined = "\n".join(texts)
    evidence = find_evidence(combined, original)
    if evidence:
        return evidence
    # 非连续多块无法合成一段时，至少保留首个经过原文验证的证据块。
    return next((matched for text in texts if (matched := find_evidence(text, original))), "")


def _infer_block_ids(source: str, blocks: dict[str, ContentBlock]) -> list[str]:
    normalized_source, _ = _normalized_with_positions(source)
    if not normalized_source:
        return []
    matches = []
    for block_id, block in blocks.items():
        normalized_block, _ = _normalized_with_positions(block.text)
        if normalized_block and (
            normalized_block in normalized_source or normalized_source in normalized_block
        ):
            matches.append(block_id)
        if len(matches) == 12:
            break
    return matches


def _is_duplicate_section(
    fingerprint: str,
    source_fingerprint: str,
    block_ids: set[str],
    previous: list[tuple[str, str, set[str]]],
) -> bool:
    """只删除相同核心事实；相关主题、不同证据和不同观点继续保留。"""
    for previous_fingerprint, previous_source, previous_ids in previous:
        if fingerprint == previous_fingerprint:
            return True
        overlap = len(block_ids & previous_ids) / max(1, len(block_ids | previous_ids))
        same_source = bool(source_fingerprint and source_fingerprint == previous_source)
        near_same_text = (
            min(len(fingerprint), len(previous_fingerprint)) >= 30
            and (fingerprint in previous_fingerprint or previous_fingerprint in fingerprint)
        )
        if near_same_text and (same_source or overlap >= 0.8):
            return True
    return False


def clean_easy_read_result(
    result: EasyReadData,
    original: str,
    content_blocks: list[ContentBlock] | None = None,
) -> QualityReport:
    """就地清理局部问题；仅在 Pydantic 无法构造整体结构时由上层报错。"""
    report = QualityReport()
    blocks = {block.id: block for block in (content_blocks or [])}
    valid_block_ids = set(blocks)
    # one_sentence 仍沿用旧接口字段名，但产品上展示为“全文概览”。
    # 给 2 至 4 个短句留出空间，避免概览只剩一个过度简化的结论。
    result.one_sentence = _shorten_at_sentence(result.one_sentence, 240)

    clean_sections = []
    section_records: list[tuple[str, str, set[str]]] = []
    _, max_sections = recommend_section_range(content_blocks or [], len(original))
    for section in result.sections[:max_sections]:
        section.heading = section.heading.strip()
        section.content = _shorten_at_sentence(section.content, 360)
        if not section.heading or not section.content:
            report.removed_sections += 1
            continue
        section.source_block_ids = _validated_block_ids(section.source_block_ids, valid_block_ids)
        evidence = find_evidence(section.source_text, original) or _evidence_from_blocks(section.source_block_ids, blocks, original)
        if evidence and not section.source_block_ids:
            section.source_block_ids = _infer_block_ids(evidence, blocks)
        if not evidence or not preserves_uncertainty(evidence, section.content):
            report.rejected_evidence += 1
            report.removed_sections += 1
            continue
        section.source_text = evidence
        fingerprint = _fingerprint(section.content)
        source_fingerprint = _fingerprint(evidence)
        block_ids = set(section.source_block_ids)
        if not fingerprint or _is_duplicate_section(
            fingerprint, source_fingerprint, block_ids, section_records
        ):
            report.removed_sections += 1
            continue
        section_records.append((fingerprint, source_fingerprint, block_ids))
        clean_sections.append(section)
        if len(clean_sections) == max_sections:
            break
    result.sections = clean_sections

    clean_points = []
    seen_points: set[tuple[str, str]] = set()
    for point in result.key_points[:8]:
        point.label = _shorten_at_sentence(point.label, 20)
        point.value = _shorten_at_sentence(point.value, 100)
        point.source_block_ids = _validated_block_ids(point.source_block_ids, valid_block_ids)
        evidence = find_evidence(point.source_text, original) or _evidence_from_blocks(point.source_block_ids, blocks, original)
        if evidence and not point.source_block_ids:
            point.source_block_ids = _infer_block_ids(evidence, blocks)
        identity = (_fingerprint(point.label), _fingerprint(point.value))
        if (
            not point.label
            or not point.value
            or not evidence
            or not preserves_uncertainty(evidence, point.value)
            or identity in seen_points
        ):
            report.removed_key_points += 1
            if point.source_text and not evidence:
                report.rejected_evidence += 1
            continue
        point.source_text = evidence
        seen_points.add(identity)
        clean_points.append(point)
        if len(clean_points) == 6:
            break
    result.key_points = clean_points

    clean_words = []
    seen_words: set[str] = set()
    normalized_original, _ = _normalized_with_positions(original)
    for item in result.difficult_words[:8]:
        word = item.word.strip()
        normalized_word, _ = _normalized_with_positions(word)
        item.simple = _shorten_at_sentence(item.simple, 120)
        item.source_block_ids = _validated_block_ids(item.source_block_ids, valid_block_ids)
        evidence = find_evidence(item.source_text, original) or _evidence_from_blocks(item.source_block_ids, blocks, original)
        if not evidence:
            evidence = find_evidence(word, original)
        has_unsupported_assertion = any(
            term in item.simple and term not in original for term in _HIGH_RISK_ASSERTIONS
        )
        if (
            not word
            or not item.simple
            or normalized_word not in normalized_original
            or normalized_word in seen_words
            or has_unsupported_assertion
        ):
            report.removed_difficult_words += 1
            continue
        item.word = word
        item.source_text = evidence
        if evidence and not item.source_block_ids:
            item.source_block_ids = _infer_block_ids(evidence, blocks)
        seen_words.add(normalized_word)
        clean_words.append(item)
        if len(clean_words) == 5:
            break
    result.difficult_words = clean_words

    if result.action.needed:
        result.action.source_block_ids = _validated_block_ids(result.action.source_block_ids, valid_block_ids)
        evidence = find_evidence(result.action.source_text, original) or _evidence_from_blocks(result.action.source_block_ids, blocks, original)
        steps = [_shorten_at_sentence(step, 120) for step in result.action.steps if step.strip()]
        if not evidence or not steps:
            if result.action.source_text and not evidence:
                report.rejected_evidence += 1
            result.action.needed = False
            result.action.steps = []
            result.action.source_text = ""
        else:
            result.action.source_text = evidence
            if not result.action.source_block_ids:
                result.action.source_block_ids = _infer_block_ids(evidence, blocks)
            result.action.steps = steps[:5]
    else:
        result.action.steps = []
        result.action.source_text = ""
        result.action.source_block_ids = []

    plan = coverage_plan(content_blocks or [], len(original))
    audit = audit_coverage(
        [section.source_block_ids for section in result.sections], plan
    )
    report.coverage_ratio = audit["coverage_ratio"]
    report.covered_block_ids = audit["covered_block_ids"]
    report.important_block_ids = audit["important_block_ids"]
    report.possibly_omitted_topics = audit["possibly_omitted_topics"]

    return report
