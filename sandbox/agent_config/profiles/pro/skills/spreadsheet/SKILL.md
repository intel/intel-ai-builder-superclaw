---
name: spreadsheet
description: "Use this skill whenever the user wants to read, analyze, or extract data from spreadsheet files (.xlsx, .csv). This includes questions about table data, columns, rows, specific sheets, or any tabular data analysis. If the user selects or mentions an Excel (.xlsx) or CSV file, use this skill."
---

## Reading spreadsheet files (Excel / CSV)

The workspace has a Python script at `/opt/readers/extract_text.py` for extracting data from spreadsheet files.

### Step 1: Always check file info first

```bash
/opt/system-venv/bin/python /opt/readers/extract_text.py <file_path> --info
```

**Excel output:**
```json
{"ok": true, "file": "...", "size_bytes": 51200, "sheets": ["Sheet1", "Revenue"], "total_sheets": 2, "total_rows": 500, "total_cols": 8, "columns": ["Date", "Product", "Sales", "Revenue", "Region", "Category", "Quantity", "Price"], "type": ".xlsx"}
```

**CSV output:**
```json
{"ok": true, "file": "...", "size_bytes": 12000, "total_rows": 200, "total_cols": 5, "columns": ["Name", "Age", "City", "Score", "Grade"], "type": ".csv"}
```

### Step 2: Read only the data you need

**For small files (≤50 rows):** read entire file:
```bash
/opt/system-venv/bin/python /opt/readers/extract_text.py <file_path>
```

**Read specific rows (1-based):**
```bash
# First 20 rows
/opt/system-venv/bin/python /opt/readers/extract_text.py <file_path> --rows 1-20

# Rows 30-50
/opt/system-venv/bin/python /opt/readers/extract_text.py <file_path> --rows 30-50
```

**Read specific columns (1-based):**
```bash
# Columns 3-5 only
/opt/system-venv/bin/python /opt/readers/extract_text.py <file_path> --cols 3-5
```

**Combine row + column ranges:**
```bash
# Rows 30-50 of columns 3-5
/opt/system-venv/bin/python /opt/readers/extract_text.py <file_path> --rows 30-50 --cols 3-5
```

**Read a specific Excel sheet:**
```bash
/opt/system-venv/bin/python /opt/readers/extract_text.py <file_path> --sheet "Revenue"

# Combine with row/col ranges
/opt/system-venv/bin/python /opt/readers/extract_text.py <file_path> --sheet "Revenue" --rows 1-20
```

### Output format

```json
{"ok": true, "text": "Row 1: Date = 2024-01-01 | Sales = 150\nRow 2: ...", "format": "table", "row_range": "1-20", "col_range": "3-5"}
```

Data is formatted as: `Row N: Column1 = Value1 | Column2 = Value2 | ...`

### Strategy for common questions

- "What's in this file?" → `--info` to see structure, then `--rows 1-10` to preview
- "Show me the Revenue sheet" → `--sheet Revenue`
- "What are rows 30-50?" → `--rows 30-50`
- "Show column 3-5 of rows 30-50" → `--rows 30-50 --cols 3-5`
- "Summarize the data" → `--info` first, then read in batches if large

### File locations

- Uploaded files (inbox): `/workspace/inbox/<filename>`
- Project files: `/workspace/<filename>`

### Important

- Use `/opt/system-venv/bin/python` for the document reader
- Do NOT use the built-in `read` tool for Excel files — it will return binary gibberish
- Always run `--info` first to see row/column counts and column names before reading data
- For large files (>100 rows), always use `--rows` to read in manageable chunks
- If extraction fails, report the error to the user rather than guessing content
