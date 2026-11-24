---
name: pptx
description: "Use this skill whenever the user wants to read, analyze, summarize, or extract information from PowerPoint files (.pptx). This includes questions about slide content, slide count, tables in slides, or any other presentation metadata. If the user selects or mentions a .pptx file, use this skill."
---

## Reading PowerPoint files

The workspace has a Python script at `/opt/readers/extract_text.py` for extracting text from PPTX files.

### Step 1: Always check file info first

Before reading content, get the file metadata:

```bash
/opt/system-venv/bin/python /opt/readers/extract_text.py <file_path> --info
```

Output:
```json
{"ok": true, "file": "...", "size_bytes": 204800, "total_slides": 20, "type": ".pptx"}
```

### Step 2: Read only the slides you need

**For small presentations (≤10 slides):** read the entire file:
```bash
/opt/system-venv/bin/python /opt/readers/extract_text.py <file_path>
```

**For larger presentations:** read specific slides:
```bash
# Read a single slide
/opt/system-venv/bin/python /opt/readers/extract_text.py <file_path> --slides 1

# Read a range of slides
/opt/system-venv/bin/python /opt/readers/extract_text.py <file_path> --slides 1-5
```

**Strategy for common questions:**
- "What is this presentation about?" → read slides 1-3 first
- "Summarize this presentation" → read in batches (1-10, 11-20, ...) and synthesize
- "What does slide 8 say?" → read slide 8 only

### Output format

The script outputs JSON to stdout:
```json
{"ok": true, "text": "...", "total_slides": 20, "format": "markdown", "slide_range": "1-5"}
```

- Each slide is prefixed with `Slide #N:`
- Tables in slides are rendered with `header = value` format

### File locations

- Uploaded files (inbox): `/workspace/inbox/<filename>`
- Project files: `/workspace/<filename>`

### Important

- Use `/opt/system-venv/bin/python` for the document reader
- Do NOT use the built-in `read` tool for PPTX files — it will return binary gibberish
- Always run `--info` first for files you haven't seen before
- If extraction fails, report the error to the user rather than guessing content
