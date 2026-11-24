---
name: docx
description: "Use this skill whenever the user wants to read, analyze, summarize, or extract information from DOCX files. This includes questions about file content, tables, or any other file metadata. If the user selects or mentions a .docx file, use this skill."
---

## Reading DOCX files

The workspace has a Python script at `/opt/readers/extract_text.py` for extracting text from DOCX files.

### How to use

```bash
/opt/system-venv/bin/python /opt/readers/extract_text.py <file_path>
```

Output JSON:
```json
{"ok": true, "text": "...", "pages": 0, "format": "markdown"}
```

- Paragraphs and tables are extracted, tables rendered as markdown
- `pages` is always 0 for DOCX (DOCX has no fixed page structure)

### Getting file metadata

```bash
# File size
ls -lh /path/to/file.docx

# File size in bytes
stat -c %s /path/to/file.docx
```

### File locations

- Uploaded files (inbox): `/workspace/inbox/<filename>`
- Project files: `/workspace/<filename>`

### Important

- Use `/opt/system-venv/bin/python` for the document reader
- Do NOT use the built-in `read` tool for DOCX files — it will return binary gibberish
- If extraction fails, report the error to the user rather than guessing content
