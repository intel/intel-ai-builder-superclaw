#!/usr/bin/env python3
"""Thin CLI launcher for the file-parser (PDF/DOCX/PPTX/XLSX/CSV extractor).

The real implementation lives in ``extract_text_impl``. This launcher is kept as
a tiny ``.py`` so callers can keep invoking
``python /opt/readers/extract_text.py <file> [options]`` unchanged.

Run ``extract_text_impl`` for the full usage/options documentation.
"""
import sys
from pathlib import Path

# The readers import each other as top-level modules. The Windows-native readers
# venv runs under a ._pth file, which leaves the script directory off sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from extract_text_impl import main

if __name__ == "__main__":
    main()
