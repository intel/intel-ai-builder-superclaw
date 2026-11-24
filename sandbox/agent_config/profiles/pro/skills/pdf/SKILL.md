---
name: pdf
description: "Use this skill whenever the user wants to read, analyze, summarize, or extract information from PDF files. This includes questions about file content, page count, file size, tables, or any other file metadata. If the user selects or mentions a .pdf file, use this skill."
---

## Working with PDF files

PDF files cannot be read directly. The workflow is two steps:

1. **Parse once** — call `parse_pdf` to extract all pages and save to a markdown file.
2. **Read from markdown** — all subsequent reads and searches use the returned markdown file path.

---

### Step 1: Parse the PDF with `parse_pdf`

Call `parse_pdf` exactly once per PDF file. It extracts **all pages** using advanced table extraction and saves the full content as a markdown file:

```
parse_pdf(file_path="/workspace/inbox/report.pdf")
```

The tool returns the path to the generated markdown file, e.g.:
```
PDF parsed successfully (42 pages). Markdown saved to: /workspace/tmp/pdf_md/report_3a7f2b1c9d4e.md
```

The markdown filename includes the source file stem plus a short id for uniqueness (e.g. `report_3a7f2b1c9d4e.md`).

**Important rules for this step:**
- Call `parse_pdf` once — results are cached, repeated calls are instant.
- Never pass page range arguments. The tool always parses the complete PDF.
- The "process large files in chunks" guideline does NOT apply here — `parse_pdf` handles all pages internally regardless of file size.

---

### Step 2: Read from the markdown file

Once parsed, use **Read** and **Grep** tools on the returned markdown path — never on the original `.pdf` file.

**For PDFs with 10 or fewer pages:**
- You may read the full markdown: `Read("/workspace/tmp/pdf_md/report_3a7f2b1c9d4e.md")`

**For PDFs with more than 10 pages — NEVER read the full file directly. Always use this two-step approach:**
1. Search for keywords first: `Grep("keyword", "/workspace/tmp/pdf_md/report_3a7f2b1c9d4e.md")`
2. Read only the lines around each match: `Read("/workspace/tmp/pdf_md/report_3a7f2b1c9d4e.md", start_line=N, end_line=M)`

This avoids context overflow and keeps responses focused. Each page in the markdown is marked with `<!-- Page N -->`, so you can navigate by page number using Grep on that marker.

The markdown content format:
- Each page opens with `<!-- Page N -->` as a section header
- Tables are rendered as markdown tables (<=10 rows) or `Row N: col = val` lines (>10 rows)

---

### File locations

- Uploaded files (inbox): `/workspace/inbox/<filename>`
- Project files: `/workspace/<filename>`

### Important

- Never use Read/Grep directly on `.pdf` files — always go through `parse_pdf` first.
- After parsing, work only with the markdown file; ignore the original PDF.
- The markdown path is GIVEN to you in the `parse_pdf` result — you already have it, there is nothing to search for. NEVER Glob/Grep/list the workspace to "find" a PDF's markdown (e.g. `**/*.md`, `<name>.md`, `<name>.pdf.md`); the returned path is the single source of truth.
- A data/corpus directory may contain a decoy sidecar named `<name>.pdf.md` next to the source `.pdf`. That is NOT the extracted output — it is reference data outside your read scope. Ignore it even if a search surfaces it.
- The real output always lives under `/workspace/tmp/pdf_md/` and is named `<stem>_<id>.md` (note: NOT `.pdf.md`). If you are about to read a path that does not start with `/workspace/tmp/pdf_md/`, stop — you have the wrong path; return to the path `parse_pdf` gave you. Never fall back to running the Python reader yourself.
- For PDFs over 10 pages, always Grep first, then Read targeted line ranges — never read the full markdown at once.
- If extraction fails, report the error to the user rather than guessing content.