---
name: docx-create
description: "Use this skill when the user wants a new Word document (.docx) created: a report, proposal, memo, meeting notes, or Markdown turned into Word. Writes the content as Markdown and converts it to a styled .docx with a title page and table of contents. To read or summarize an existing .docx, use the docx skill instead."
---

<!-- Adapted from github/awesome-copilot@2746e462c143 skills/md-to-docx (MIT, LICENSE). Modified by the SuperClaw project; see README.md. -->

# Create Word documents

`<skill_dir>` below means the base directory shown when this skill loaded.
`node` is already installed and the converter needs nothing else. Do not run `npm install`, and do
not install Pandoc, LibreOffice or other tools.

## Workflow

1. **Write the content as Markdown** in the user's workspace, for example
   `/workspace/<name>/<name>.md`. Start it with front matter:

   ```markdown
   ---
   title: Quarterly Report — Q3 2026
   date: 2026-10-23
   ---

   # Quarterly Report

   ## 1. Summary
   ...
   ```

   `title` goes on the title page; text after `—` becomes the subtitle. `date`, `version` and
   `audience` are optional and shown only when given. Without front matter, the first `#` heading
   is the title.
2. **Charts and pictures:** save each one as a PNG or JPEG next to the Markdown file (for charts,
   matplotlib at 200 dpi) and reference it on its own line: `![Revenue by quarter](revenue.png)`.
   The alt text becomes the caption.
3. **Convert:**

   ```bash
   node <skill_dir>/scripts/md-to-docx.mjs /workspace/<name>/<name>.md
   ```

   This writes `/workspace/<name>/<name>.docx`. A second argument sets another output path ending in
   `.docx`.
4. **Check the output.** Every `WARN:` line is content missing from the document (an image not found
   or not embedded). Fix the Markdown or the image and convert again. `ERROR:` means nothing was
   written.
5. **Deliver.** Tell the user the `.docx` path and the section outline.

## What converts

Headings (`#` to `####`), paragraphs, **bold**, *italic*, `inline code`, bullet and numbered lists
(nested too), tables, code blocks, local PNG/JPEG images, and `---` rules. The document gets a title
page, a table of contents listing headings `#` to `###` (without page numbers), Calibri text, and
Microsoft YaHei for Chinese, Japanese and Korean text.

Avoid these; they come out as plain text or a placeholder:

- Blockquotes (`>`) and raw HTML.
- Mermaid diagrams: draw the chart with matplotlib and embed the PNG instead.
- Images from URLs: save the file locally first.
- Links are shown as styled text, not clickable. Write the URL out when the reader needs it.

## Rules

- Use real content only; never leave placeholder text such as "TBD" or "Lorem ipsum".
- Write only inside the workspace. Never edit files under `<skill_dir>`.
