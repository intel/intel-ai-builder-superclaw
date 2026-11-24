import { readZipEntries, writeZipEntries } from "./zip-lite.js";

/** Worksheet parts inside an OOXML spreadsheet package. */
const WORKSHEET_PART_RE = /^xl\/worksheets\/sheet[^/]*\.xml$/i;

/**
 * Remove each worksheet's persisted view state from an .xlsx package.
 *
 * `SinglePageSheets` (the Calc filter option that renders a sheet as one
 * content-sized page instead of slicing it into A4 pages) anchors that page at
 * the worksheet's *stored view origin* rather than at A1. Excel writes the last
 * scroll position on every save, so a workbook the author left scrolled exports
 * only the region from that point onwards — silently losing everything above and
 * to the left, while still producing a plausible-looking page.
 *
 * Measured on a real report whose content spans B1:R44, saved with
 * `<sheetView topLeftCell="I25"/>`: the export was 25,609 bytes and had lost the
 * header band plus the entire left column of content, versus 32,225 bytes once
 * the view was reset. Dropping `<sheetViews>` produced byte-identical output to
 * rewriting `topLeftCell` to A1, so the whole element is removed — it also
 * carries `<pane>` (frozen panes) and `<selection>` (cursor), which re-anchor
 * the view the same way.
 *
 * This only rewrites view metadata; cell data, styles and merges are untouched.
 * Returns null when there is nothing to change, so callers can convert the
 * original file and avoid a pointless repack.
 */
export function stripSpreadsheetViewState(xlsx: Buffer): Buffer | null {
  const entries = readZipEntries(xlsx);
  let changed = false;

  for (const entry of entries) {
    if (!WORKSHEET_PART_RE.test(entry.name)) continue;
    const xml = entry.data.toString("utf8");
    // OOXML permits both an expanded <sheetViews>...</sheetViews> element and
    // an empty self-closing <sheetViews/> element.
    const stripped = xml.replace(
      /<sheetViews\b[^>]*\/>|<sheetViews\b[\s\S]*?<\/sheetViews>/g,
      "",
    );
    if (stripped !== xml) {
      entry.data = Buffer.from(stripped, "utf8");
      changed = true;
    }
  }

  if (!changed) return null;
  return writeZipEntries(entries);
}

/** True when the file extension is an OOXML spreadsheet this can rewrite. */
export function isRewritableSpreadsheet(lowerExtension: string): boolean {
  return lowerExtension === ".xlsx" || lowerExtension === ".xlsm";
}
