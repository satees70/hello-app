#!/usr/bin/env python3
"""Build a bilingual (English + Bahasa Malaysia) PDF from the two manual markdown drafts."""
import re
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, PageBreak,
                                Table, TableStyle, HRFlowable)

DOCS = "/Users/satees/Documents/CLOUDE/hello-app/docs"
OUT = f"{DOCS}/EASWARI-Manual-Bilingual.pdf"

# Replace symbols/emoji that the core PDF fonts can't render
REPLACE = [
    ("📷 ", ""), ("📷", ""), ("🔔", ""), ("✎ ", ""), ("✎", ""), ("★", "*"),
    ("⏳ ", ""), ("⏳", ""), ("⚠", "!"), ("→", "->"), ("✓ ", ""), ("✓", ""),
    ("💬", "(chat)"), ("▸ ", "> "), ("▸", ">"), ("➕ ", "+ "), ("➕", "+"),
    ("🇬🇧", ""), ("🇲🇾", ""), ("🏭", ""),
]

def clean(s):
    for a, b in REPLACE:
        s = s.replace(a, b)
    return s

def inline(s):
    s = clean(s)
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"`(.+?)`", r'<font face="Courier">\1</font>', s)
    return s

styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Title"], fontSize=20, spaceAfter=10, textColor=colors.HexColor("#1d4ed8"))
H2 = ParagraphStyle("H2", parent=styles["Heading1"], fontSize=14, spaceBefore=12, spaceAfter=6, textColor=colors.HexColor("#111827"))
BODY = ParagraphStyle("Body", parent=styles["Normal"], fontSize=10.5, leading=15, spaceAfter=4)
BULLET = ParagraphStyle("Bullet", parent=BODY, leftIndent=14, bulletIndent=4, spaceAfter=2)
NUM = ParagraphStyle("Num", parent=BODY, leftIndent=14, spaceAfter=2)
SHOT = ParagraphStyle("Shot", parent=BODY, textColor=colors.HexColor("#9ca3af"), fontName="Helvetica-Oblique", spaceBefore=2, spaceAfter=6)
PARTHEAD = ParagraphStyle("Part", parent=styles["Title"], fontSize=24, textColor=colors.HexColor("#1d4ed8"), spaceAfter=8)

def build_story(md, story):
    lines = md.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        if not line.strip():
            story.append(Spacer(1, 4)); i += 1; continue
        if line.startswith("|"):  # table block
            rows = []
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not re.match(r"^[-: ]+$", "".join(cells)):  # skip separator
                    rows.append(cells)
                i += 1
            data = [[Paragraph(inline(c), BODY) for c in r] for r in rows]
            t = Table(data, colWidths=[35*mm, 130*mm])
            t.setStyle(TableStyle([
                ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#d1d5db")),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f3f4f6")),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            story.append(Spacer(1, 4)); story.append(t); story.append(Spacer(1, 6)); continue
        if line.startswith("# "):
            story.append(Paragraph(inline(line[2:]), H1))
        elif line.startswith("## "):
            story.append(Paragraph(inline(line[3:]), H2))
        elif line.startswith("### "):
            story.append(Paragraph(inline(line[4:]), H2))
        elif line.strip() == "---":
            story.append(Spacer(1, 2)); story.append(HRFlowable(width="100%", thickness=0.6, color=colors.HexColor("#e5e7eb"))); story.append(Spacer(1, 2))
        elif clean(line).lstrip().startswith("[Screenshot"):
            story.append(Paragraph(inline(line.strip()), SHOT))
        elif line.lstrip().startswith("- "):
            story.append(Paragraph(inline(line.lstrip()[2:]), BULLET, bulletText="•"))
        elif re.match(r"^\s*\d+\.\s", line):
            story.append(Paragraph(inline(line.strip()), NUM))
        else:
            story.append(Paragraph(inline(line.strip()), BODY))
        i += 1

def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()

story = []
# Cover
story.append(Spacer(1, 60))
story.append(Paragraph("EASWARI / AVINA", H1))
story.append(Paragraph("Production Team Manual &nbsp;&middot;&nbsp; Panduan Pasukan Pengeluaran", H2))
story.append(Spacer(1, 8))
story.append(Paragraph("Bilingual: English (Part 1) and Bahasa Malaysia (Bahagian 2).", BODY))
story.append(Paragraph("Wording draft — screenshots to be added at each [Screenshot] marker.", SHOT))
story.append(PageBreak())

story.append(Paragraph("PART 1 — ENGLISH", PARTHEAD))
story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#1d4ed8")))
story.append(Spacer(1, 8))
build_story(read(f"{DOCS}/PRODUCTION-MANUAL.md"), story)

story.append(PageBreak())
story.append(Paragraph("BAHAGIAN 2 — BAHASA MALAYSIA", PARTHEAD))
story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#1d4ed8")))
story.append(Spacer(1, 8))
build_story(read(f"{DOCS}/PANDUAN-PENGELUARAN-BM.md"), story)

doc = SimpleDocTemplate(OUT, pagesize=A4, topMargin=18*mm, bottomMargin=18*mm, leftMargin=18*mm, rightMargin=18*mm,
                        title="EASWARI Production Manual (EN/BM)")
doc.build(story)
print("WROTE", OUT)
