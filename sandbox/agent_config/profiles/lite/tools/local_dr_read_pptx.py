#!/usr/bin/env python3
"""
Extract text content from a .pptx file and return it as markdown.

Usage: python3 local_dr_read_pptx.py '{"file_path": "/abs/path/to/file.pptx"}'

Requires: python-pptx  (pip install python-pptx)
"""

import json
import sys
from pathlib import Path


def table_to_markdown(table) -> str:
    rows = []
    for i, row in enumerate(table.rows):
        cells = [cell.text.strip().replace("\n", " ") for cell in row.cells]
        rows.append("| " + " | ".join(cells) + " |")
        if i == 0:
            rows.append("| " + " | ".join("---" for _ in cells) + " |")
    return "\n".join(rows)


def read_pptx(file_path: str) -> str:
    try:
        from pptx import Presentation
        from pptx.util import Pt
    except ImportError:
        return "ERROR: python-pptx is not installed. Run: pip install python-pptx"

    path = Path(file_path)
    if not path.exists():
        return f"ERROR: File not found: {file_path}"
    if path.suffix.lower() != ".pptx":
        return f"ERROR: Expected a .pptx file, got: {path.suffix}"

    try:
        prs = Presentation(file_path)
    except Exception as e:
        return f"ERROR: Could not open {file_path}: {e}"

    total_slides = len(prs.slides)
    lines = [
        f"# {path.name}",
        f"*{total_slides} slide{'s' if total_slides != 1 else ''}*\n",
    ]

    for slide_num, slide in enumerate(prs.slides, 1):
        # Extract title
        title_text = ""
        if slide.shapes.title and slide.shapes.title.has_text_frame:
            title_text = slide.shapes.title.text.strip()

        lines.append(f"## Slide {slide_num}{': ' + title_text if title_text else ''}")

        for shape in slide.shapes:
            # Skip the title shape — already captured above
            if shape == slide.shapes.title:
                continue

            if shape.has_text_frame:
                paragraphs = []
                for para in shape.text_frame.paragraphs:
                    text = para.text.strip()
                    if not text:
                        continue
                    # Preserve bullet-level indentation
                    level = para.level if para.level else 0
                    prefix = "  " * level + "- " if level > 0 else ""
                    paragraphs.append(f"{prefix}{text}")
                if paragraphs:
                    lines.append("\n".join(paragraphs))

            elif shape.has_table:
                lines.append(table_to_markdown(shape.table))

        lines.append("")  # blank line between slides

    return "\n".join(lines)


def main() -> int:
    if len(sys.argv) < 2:
        print("ERROR: No arguments provided. Pass JSON: {\"file_path\": \"...\"}")
        return 1

    try:
        args = json.loads(sys.argv[1])
        file_path = args.get("file_path", "")
    except (json.JSONDecodeError, AttributeError):
        file_path = sys.argv[1]

    if not file_path:
        print("ERROR: file_path is required.")
        return 1

    print(read_pptx(file_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
