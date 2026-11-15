"""根据正文结构建立主题覆盖计划，并审计 Easy Read 结果。"""

from __future__ import annotations

import re
from typing import Any

from .models import ContentBlock


MAX_TOPIC_GROUPS = 15


def _representative_ids(ids: list[str], limit: int = 12) -> list[str]:
    if len(ids) <= limit:
        return ids
    indexes = {0, len(ids) - 1, len(ids) // 2}
    indexes.update(round(index * (len(ids) - 1) / (limit - 1)) for index in range(limit))
    return [ids[index] for index in sorted(indexes)[:limit]]


def _fallback_heading(block: ContentBlock, position: int) -> str:
    if block.type == "table_row":
        return "表格信息"
    if block.type == "list_item":
        return "要点列表"
    if block.type == "quote":
        return "人物观点或引用"
    text = re.sub(r"\s+", " ", block.text).strip()
    return text[:32] or f"主题 {position + 1}"


def group_content_blocks(blocks: list[ContentBlock]) -> list[dict[str, Any]]:
    """按标题上下文和连续位置分组，不要求每个段落都成为独立主题。"""
    groups: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None

    for position, block in enumerate(blocks):
        heading = block.heading_context.strip()
        starts_topic = block.type in {"heading", "quote"}
        if current is None or starts_topic or (heading and heading != current["heading_context"]):
            current = {
                "heading": (block.text if block.type == "heading" else heading.split(" > ")[-1]) or _fallback_heading(block, position),
                "heading_context": heading,
                "block_ids": [],
                "block_types": [],
                "text_length": 0,
                "position": position,
                "samples": [],
            }
            groups.append(current)
        elif not heading and len(current["block_ids"]) >= 4:
            current = {
                "heading": _fallback_heading(block, position),
                "heading_context": "",
                "block_ids": [],
                "block_types": [],
                "text_length": 0,
                "position": position,
                "samples": [],
            }
            groups.append(current)

        current["block_ids"].append(block.id)
        current["block_types"].append(block.type)
        current["text_length"] += len(block.text)
        if block.type != "heading" and len(current["samples"]) < 2:
            current["samples"].append(re.sub(r"\s+", " ", block.text).strip()[:180])

    return groups


def _importance(group: dict[str, Any], total: int) -> float:
    types = set(group["block_types"])
    score = min(group["text_length"] / 500, 4)
    score += 2.5 if "heading" in types else 0
    score += 1.5 if types & {"table_row", "quote"} else 0
    score += 1 if "list_item" in types else 0
    sample = " ".join(group["samples"])
    score += 1 if re.search(r"\d|年|月|日|%|原因|结果|结论|风险|必须|需要", sample) else 0
    position = group["position"]
    if position == 0 or position >= max(0, total - 2):
        score += 1
    return score


def select_important_groups(groups: list[dict[str, Any]], limit: int = MAX_TOPIC_GROUPS) -> list[dict[str, Any]]:
    if len(groups) <= limit:
        return groups
    required = {0, len(groups) // 2, len(groups) - 1}
    ranked = sorted(
        range(len(groups)),
        key=lambda index: _importance(groups[index], len(groups)),
        reverse=True,
    )
    selected = set(required)
    for index in ranked:
        if len(selected) >= limit:
            break
        selected.add(index)
    return [groups[index] for index in sorted(selected)]


def recommend_section_range(blocks: list[ContentBlock], text_length: int) -> tuple[int, int]:
    groups = select_important_groups(group_content_blocks(blocks)) if blocks else []
    topic_count = len(groups)
    structural_count = sum(block.type in {"heading", "table_row", "list_item", "quote"} for block in blocks)
    if text_length < 2_500 and len(blocks) < 18:
        lower, upper = 3, 5
    elif text_length < 8_000 and structural_count < 30:
        lower, upper = 5, 8
    elif text_length < 25_000:
        lower, upper = 8, 12
    else:
        lower, upper = 10, 15
    if topic_count:
        lower = min(lower, topic_count)
        # 明确存在的独立主题不能因为文章字数较短而被固定上限截掉。
        upper = min(MAX_TOPIC_GROUPS, max(lower, upper, topic_count))
    return max(1, lower), max(1, upper)


def infer_article_type(blocks: list[ContentBlock]) -> str:
    types = [block.type for block in blocks]
    text = "\n".join(block.text for block in blocks[:120])
    if types.count("table_row") >= 3 or "code" in types:
        return "技术文档"
    if types.count("quote") >= 2 or re.search(r"(表示|说道|认为|提到)[：:]", text):
        return "访谈或观点文章"
    if re.search(r"(办理|申请|携带|提交|步骤|材料)", text):
        return "办事指南或通知"
    return "一般文章"


def coverage_plan(blocks: list[ContentBlock], text_length: int) -> dict[str, Any]:
    groups = select_important_groups(group_content_blocks(blocks))
    lower, upper = recommend_section_range(blocks, text_length)
    topics = []
    important_ids: list[str] = []
    for index, group in enumerate(groups, 1):
        ids = _representative_ids(group["block_ids"])
        important_ids.extend(ids)
        topics.append({
            "topic_id": f"topic-{index}",
            "heading": group["heading"][:80],
            "block_ids": ids,
            "block_types": list(dict.fromkeys(group["block_types"])),
            "position": "beginning" if index == 1 else "end" if index == len(groups) else "middle",
            "sample": " ".join(group["samples"])[:300],
        })
    return {
        "article_type": infer_article_type(blocks),
        "recommended_section_range": {"min": lower, "max": upper},
        "topic_groups": topics,
        "important_block_ids": list(dict.fromkeys(important_ids)),
    }


def audit_coverage(section_block_ids: list[list[str]], plan: dict[str, Any]) -> dict[str, Any]:
    cited = {block_id for ids in section_block_ids for block_id in ids}
    groups = plan.get("topic_groups", [])
    covered = []
    omitted = []
    for group in groups:
        is_covered = bool(cited.intersection(group.get("block_ids", [])))
        (covered if is_covered else omitted).append(group)
    ratio = len(covered) / len(groups) if groups else 1.0
    return {
        "article_type": plan.get("article_type", "一般文章"),
        "covered_block_ids": sorted(cited),
        "important_block_ids": plan.get("important_block_ids", []),
        "coverage_ratio": round(ratio, 3),
        "possibly_omitted_topics": [group.get("heading", "未命名主题") for group in omitted],
    }
