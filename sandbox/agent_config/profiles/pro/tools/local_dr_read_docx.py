#!/usr/bin/env python3
"""
Extract content from a .docx file and return it as markdown.

Usage: python3 local_dr_read_docx.py '{"file_path": "/abs/path/to/file.docx"}'

Requires: python-docx  (pip install python-docx)
"""

import json
import sys
from pathlib import Path

# Word heading styles → markdown prefix
HEADING_MAP = {
    "Heading 1": "# ",
    "Heading 2": "## ",
    "Heading 3": "### ",
    "Heading 4": "#### ",
    "Title":     "# ",
    "Subtitle":  "## ",
}

# List-style paragraph styles
LIST_STYLES = {"List Paragraph", "List Bullet", "List Number"}


def table_to_markdown(table) -> str:
    rows = []
    for i, row in enumerate(table.rows):
        cells = [
            cell.text.strip().replace("\n", " ").replace("|", "\\|")
            for cell in row.cells
        ]
        rows.append("| " + " | ".join(cells) + " |")
        if i == 0:
            rows.append("| " + " | ".join("---" for _ in cells) + " |")
    return "\n".join(rows)


def read_docx(file_path: str) -> str:
    try:
        from docx import Document
        from docx.oxml.ns import qn
    except ImportError:
        return "ERROR: python-docx is not installed. Run: pip install python-docx"

    path = Path(file_path)
    if not path.exists():
        return f"ERROR: File not found: {file_path}"
    if path.suffix.lower() != ".docx":
        return f"ERROR: Expected a .docx file, got: {path.suffix}"

    try:
        doc = Document(file_path)
    except Exception as e:
        return f"ERROR: Could not open {file_path}: {e}"

    lines = [f"# {path.name}\n"]

    # Iterate document body elements in order to preserve table/paragraph interleaving
    from docx.oxml import OxmlElement
    body = doc.element.body

    for child in body:
        tag = child.tag.split("}")[-1] if "}" in child.tag else child.tag

        if tag == "p":
            # Paragraph
            from docx.text.paragraph import Paragraph
            para = Paragraph(child, doc)
            text = para.text.strip()
            if not text:
                lines.append("")
                continue

            style_name = para.style.name if para.style else ""

            if style_name in HEADING_MAP:
                lines.append(f"{HEADING_MAP[style_name]}{text}")
            elif style_name in LIST_STYLES or (para.style and "List" in style_name):
                # Preserve indentation level via numPr ilvl
                ilvl = 0
                num_pr = child.find(f".//{{{child.nsmap.get('w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')}}}ilvl")
                if num_pr is not None:
                    val = num_pr.get(f"{{{child.nsmap.get('w', 'http://schemas.openxmlformats.org/wordprocessingml/2006/main')}}}val")
                    ilvl = int(val) if val is not None else 0
                lines.append("  " * ilvl + f"- {text}")
            else:
                lines.append(text)

        elif tag == "tbl":
            # Table
            from docx.table import Table
            tbl = Table(child, doc)
            lines.append("")
            lines.append(table_to_markdown(tbl))
            lines.append("")

    return "\n".join(lines)


def main() -> int:
    if len(sys.argv) < 2:
        print('ERROR: No arguments provided. Pass JSON: {"file_path": "..."}')
        return 1

    try:
        args = json.loads(sys.argv[1])
        file_path = args.get("file_path", "")
    except (json.JSONDecodeError, AttributeError):
        file_path = sys.argv[1]

    if not file_path:
        print("ERROR: file_path is required.")
        return 1

    print(read_docx(file_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
