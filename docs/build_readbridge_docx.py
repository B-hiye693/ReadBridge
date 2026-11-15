from pathlib import Path
import re

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "阅桥ReadBridge-PPT项目介绍文案.md"
OUTPUT = ROOT / "阅桥ReadBridge项目介绍PPT制作内容.docx"

FONT_CN = "Microsoft YaHei"
FONT_EN = "Aptos"
ACCENT = "347866"
TEXT = "26352F"
MUTED = "667A71"
LIGHT = "E8F1ED"


def set_font(run, size=None, bold=None, color=None, italic=None):
    run.font.name = FONT_EN
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), FONT_CN)
    run._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), FONT_EN)
    run._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), FONT_EN)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic
    if color:
        run.font.color.rgb = RGBColor.from_string(color)


def add_page_number(paragraph):
    paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = paragraph.add_run("第 ")
    set_font(run, 8.5, color=MUTED)
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = " PAGE "
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.extend([begin, instr, end])
    tail = paragraph.add_run(" 页")
    set_font(tail, 8.5, color=MUTED)


def set_cell_shading(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def setup_styles(doc):
    normal = doc.styles["Normal"]
    normal.font.name = FONT_EN
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), FONT_CN)
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = RGBColor.from_string(TEXT)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.35

    title = doc.styles["Title"]
    title.font.name = FONT_EN
    title._element.rPr.rFonts.set(qn("w:eastAsia"), FONT_CN)
    title.font.size = Pt(28)
    title.font.bold = True
    title.font.color.rgb = RGBColor(0, 0, 0)
    title.paragraph_format.space_after = Pt(14)
    title_ppr = title._element.get_or_add_pPr()
    border = title_ppr.find(qn("w:pBdr"))
    if border is not None:
        title_ppr.remove(border)

    for name, size, before, after in (
        ("Heading 1", 19, 14, 8),
        ("Heading 2", 15, 12, 6),
        ("Heading 3", 11.5, 9, 4),
    ):
        style = doc.styles[name]
        style.font.name = FONT_EN
        style._element.rPr.rFonts.set(qn("w:eastAsia"), FONT_CN)
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.keep_with_next = True

    for name in ("List Bullet", "List Number"):
        style = doc.styles[name]
        style.font.name = FONT_EN
        style._element.rPr.rFonts.set(qn("w:eastAsia"), FONT_CN)
        style.font.size = Pt(10.5)
        style.font.color.rgb = RGBColor.from_string(TEXT)
        style.paragraph_format.left_indent = Cm(0.65)
        style.paragraph_format.first_line_indent = Cm(-0.3)
        style.paragraph_format.space_after = Pt(4)
        style.paragraph_format.line_spacing = 1.25

    quote = doc.styles["Quote"]
    quote.font.name = FONT_EN
    quote._element.rPr.rFonts.set(qn("w:eastAsia"), FONT_CN)
    quote.font.size = Pt(10.5)
    quote.font.italic = False
    quote.font.color.rgb = RGBColor.from_string(MUTED)
    quote.paragraph_format.left_indent = Cm(0.7)
    quote.paragraph_format.right_indent = Cm(0.7)
    quote.paragraph_format.space_after = Pt(8)

    if "Code Block" not in [s.name for s in doc.styles]:
        code = doc.styles.add_style("Code Block", WD_STYLE_TYPE.PARAGRAPH)
        code.font.name = "Consolas"
        code._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
        code.font.size = Pt(9)
        code.font.color.rgb = RGBColor.from_string(TEXT)
        code.paragraph_format.left_indent = Cm(0.7)
        code.paragraph_format.space_before = Pt(4)
        code.paragraph_format.space_after = Pt(4)


def add_inline(paragraph, text, base_bold=False, color=TEXT):
    pieces = re.split(r"(\*\*.*?\*\*|`.*?`)", text)
    for piece in pieces:
        if not piece:
            continue
        if piece.startswith("**") and piece.endswith("**"):
            run = paragraph.add_run(piece[2:-2])
            set_font(run, bold=True, color=color)
        elif piece.startswith("`") and piece.endswith("`"):
            run = paragraph.add_run(piece[1:-1])
            run.font.name = "Consolas"
            run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), FONT_CN)
            run.font.size = Pt(9.5)
            run.font.color.rgb = RGBColor.from_string(ACCENT)
        else:
            run = paragraph.add_run(piece)
            set_font(run, bold=base_bold, color=color)


def clean_heading(text):
    text = re.sub(r"[：:，、]+", " ", text)
    text = re.sub(r"[—–-]{2,}", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def add_cover(doc):
    p = doc.add_paragraph(style="Title")
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(105)
    p.add_run("阅桥 ReadBridge 项目介绍")

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("PPT 制作内容稿")
    set_font(r, 17, bold=True, color=ACCENT)
    p.paragraph_format.space_after = Pt(22)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("跨网页 文件与 Windows 应用的 AI 认知无障碍阅读助手")
    set_font(r, 12, color=TEXT)

    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(26)
    r = p.add_run("当前版本  Windows 桌面客户端 v9")
    set_font(r, 10, color=MUTED)
    doc.add_page_break()


def add_overview_table(doc):
    table = doc.add_table(rows=1, cols=2)
    table.autofit = False
    table.columns[0].width = Cm(4.0)
    table.columns[1].width = Cm(12.0)
    table.rows[0].cells[0].text = "内容"
    table.rows[0].cells[1].text = "说明"
    for cell in table.rows[0].cells:
        set_cell_shading(cell, ACCENT)
        for run in cell.paragraphs[0].runs:
            set_font(run, 10, bold=True, color="FFFFFF")
        cell.paragraphs[0].alignment = WD_ALIGN_PARAGRAPH.CENTER
    rows = [
        ("文档用途", "提供给 PPT 制作者直接使用的逐页文案和视觉建议"),
        ("推荐页数", "15 页 16比9 横版演示文稿"),
        ("内容范围", "背景 用户 功能 技术架构 隐私 测试结果 演示流程与规划"),
        ("视觉方向", "墨绿色 浅绿色与白色 重点突出清晰温和可信和易读"),
    ]
    for idx, (a, b) in enumerate(rows):
        cells = table.add_row().cells
        cells[0].text, cells[1].text = a, b
        if idx % 2:
            for cell in cells:
                set_cell_shading(cell, "F3F7F5")
        for cidx, cell in enumerate(cells):
            cell.vertical_alignment = 1
            for p in cell.paragraphs:
                p.paragraph_format.space_after = Pt(3)
                for run in p.runs:
                    set_font(run, 9.5, bold=(cidx == 0), color=TEXT)
    doc.add_paragraph()


def build():
    doc = Document()
    section = doc.sections[0]
    section.top_margin = Cm(1.9)
    section.bottom_margin = Cm(1.7)
    section.left_margin = Cm(2.2)
    section.right_margin = Cm(2.2)
    setup_styles(doc)

    header = section.header.paragraphs[0]
    header.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    r = header.add_run("阅桥 ReadBridge  PPT 制作内容稿")
    set_font(r, 8.5, color=MUTED)
    add_page_number(section.footer.paragraphs[0])

    add_cover(doc)
    doc.add_heading("文档说明", level=1)
    p = doc.add_paragraph()
    add_inline(p, "本稿将阅桥当前功能整理为可直接制作 PPT 的逐页内容。每页均包含展示文字，并在需要时补充视觉建议和演讲备注。制作者可以删减字数，但应保留功能边界、隐私说明和测试限制。")

    lines = SOURCE.read_text(encoding="utf-8").splitlines()
    in_code = False
    code_lines = []
    skip_first_title = True
    for raw in lines:
        line = raw.rstrip()
        stripped = line.strip()
        if stripped.startswith("```"):
            if not in_code:
                in_code = True
                code_lines = []
            else:
                p = doc.add_paragraph(style="Code Block")
                p.add_run("\n".join(code_lines))
                in_code = False
            continue
        if in_code:
            code_lines.append(line)
            continue
        if not stripped or stripped == "---":
            continue
        if skip_first_title and stripped.startswith("# "):
            skip_first_title = False
            continue
        if stripped == "# 二、逐页 PPT 文案":
            continue
        if stripped.startswith("## 第 ") and "页" in stripped:
            doc.add_page_break()
            doc.add_heading(clean_heading(stripped[3:]), level=1)
            continue
        if stripped.startswith("# "):
            doc.add_page_break()
            doc.add_heading(clean_heading(stripped[2:]), level=1)
        elif stripped.startswith("## "):
            doc.add_heading(clean_heading(stripped[3:]), level=1)
        elif stripped.startswith("### "):
            heading = clean_heading(stripped[4:])
            if heading == "架构流程":
                doc.add_page_break()
            elif heading == "结束语":
                continue
            doc.add_heading(heading, level=2)
        elif stripped.startswith("#### "):
            doc.add_heading(clean_heading(stripped[5:]), level=3)
        elif stripped.startswith("> "):
            p = doc.add_paragraph(style="Quote")
            add_inline(p, stripped[2:], color=MUTED)
        elif re.match(r"^[-*] ", stripped):
            p = doc.add_paragraph(style="List Bullet")
            add_inline(p, stripped[2:])
        elif re.match(r"^\d+\. ", stripped):
            match = re.match(r"^(\d+)\.\s+(.*)$", stripped)
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.65)
            p.paragraph_format.first_line_indent = Cm(-0.55)
            p.paragraph_format.space_after = Pt(4)
            add_inline(p, f"{match.group(1)}.  {match.group(2)}")
        else:
            p = doc.add_paragraph()
            add_inline(p, stripped)

    core = doc.core_properties
    core.title = "阅桥 ReadBridge 项目介绍 PPT 制作内容"
    core.subject = "阅桥项目的逐页 PPT 文案 视觉建议和演示说明"
    core.author = "ReadBridge 项目组"
    core.keywords = "阅桥 ReadBridge 认知无障碍 AI 阅读助手 PPT"
    doc.save(OUTPUT)
    print(OUTPUT)


if __name__ == "__main__":
    build()
