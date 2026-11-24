---
name: ocr-document-parse
description: Use this skill whenever the user wants OCR for a scanned document
  page, PDF page image, screenshot, form, receipt, slide, or paper note and the
  result should be clean Markdown. Use it to convert an image into structured
  Markdown with reading order, headings, and tables preserved. RapidOCR extracts
  the raw text/boxes locally, then the local chat model reformats it into
  Markdown. If the user mentions OCR, scan, document image, page image, or
  convert image to Markdown/text for RAG, use this skill. You do NOT need vision
  / image-reading ability to use this skill and the image is never shown to any
  model — call it immediately in the same turn, without asking the user for
  permission or confirmation first, and never reply that you can't read images
  directly.
---

# Document Parse to Markdown

OCR a page image into Markdown. No vision model needed — RapidOCR extracts text locally.

## How to OCR

Call the `ocr` tool with the absolute image path:

```json
{"file_path": "/workspace/scanned_jpg.jpg"}
```

Or delegate to local-file-agent:

```
task('local-file-agent', 'Call the ocr tool on /workspace/scanned_jpg.jpg and format the result as Markdown')
```

Either method works. local-file-agent has ocr permission.

## After You Get the OCR Result

 **STOP. Do NOT call `edit`. Do NOT modify any file.**

The OCR result is TEXT.

NEVER do this: `edit(file="/workspace/scanned_jpg.jpg", ...)`

## Formatting the OCR Output

The `ocr` tool returns a JSON object. `text` is the full transcription, one line
per newline; `lines[i]` holds line i's confidence and, when detection ran, its
`box` in image pixels:

```json
{
  "text": "Invoice #1042\nDate: 2026-07-18",
  "lines": [
    {"confidence": 0.98, "box": [[34,20],[210,20],[210,44],[34,44]]},
    {"confidence": 0.95, "box": [[34,52],[190,52],[190,74],[34,74]]}
  ]
}
```

Format rules:
- Build the Markdown from the lines of `text`; copy each line unchanged
- Order lines top-to-bottom, left-to-right using box coordinates; if a line has no `box`, keep the given order
- Render aligned rows as Markdown tables
- Mark confidence < 0.5 as `[unreadable: <text>]`
- Do not invent text not in the OCR output

## FINAL REMINDER

After OCR completes: **reply with Markdown text. No edit.**
