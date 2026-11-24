/**
 * md-to-docx.mjs - Markdown to Word converter
 * Pure JavaScript, no external tools required.
 * Usage: node md-to-docx.mjs <input.md> [output.docx]
 *
 * From github/awesome-copilot@2746e462c143 skills/md-to-docx (MIT, see ../LICENSE).
 * Modified by the SuperClaw project (2026-10-23, 2026-10-24, 2026-10-25); see ../README.md.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join, parse, resolve } from "path";
import { marked } from "../vendor/marked.mjs";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun,
  TableRow, TableCell, Table, WidthType, BorderStyle,
  AlignmentType, ShadingType, PageBreak
} from "../vendor/docx.mjs";

const warnings = [];

// --- Image type and dimensions from the file header ---
function imageInfo(buffer) {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { type: "png", width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    // JPEG: walk the segments to the start-of-frame marker that holds the size
    let offset = 2;
    while (offset + 9 < buffer.length && buffer[offset] === 0xff) {
      const marker = buffer[offset + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: "jpg", width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + buffer.readUInt16BE(offset + 2);
    }
  }
  return null;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

// --- CLI argument parsing ---
const inputPath = process.argv[2];
if (!inputPath) fail("Usage: node md-to-docx.mjs <input.md> [output.docx]");
if (!existsSync(inputPath)) fail(`input not found: ${inputPath}`);
const inputDir = dirname(resolve(inputPath));
const outputPath = resolve(process.argv[3] || join(inputDir, `${parse(inputPath).name}.docx`));
if (!/\.docx$/i.test(outputPath)) fail(`output must end in .docx: ${outputPath}`);
if (outputPath.toLowerCase() === resolve(inputPath).toLowerCase()) fail("output would overwrite the input");

const mdSource = readFileSync(inputPath, "utf-8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

// --- Extract YAML front-matter metadata (only at the very start of the file) ---
const fmMatch = mdSource.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
const fm = fmMatch ? fmMatch[1] : "";
const field = (name) =>
  fm.match(new RegExp("^" + name + ":\\s*(.+)$", "m"))?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
const date = field("date");
const version = field("version");
const audience = field("audience");

// Strip front-matter from markdown content
const md = fmMatch ? mdSource.slice(fmMatch[0].length) : mdSource;

// --- Parse Markdown tokens ---
const tokens = marked.lexer(md);

// Title / subtitle from the front-matter title, else the first H1, else the file name.
// The H1 that supplied the title moves to the title page and is not repeated in the body.
const DASH = /\s*[—–]\s*/;
const firstH1 = tokens.find(t => t.type === "heading" && t.depth === 1);
const title = field("title") || (firstH1 ? decodeEntities(firstH1.text) : "") || parse(inputPath).name;
const dash = title.match(DASH);
const mainTitle = dash ? title.slice(0, dash.index) : title;
const subtitle = dash ? title.slice(dash.index + dash[0].length) : "";
const titleHeading =
  firstH1 && decodeEntities(firstH1.text).split(DASH)[0].trim() === mainTitle.trim() ? firstH1 : null;

// --- Style constants ---
const FONT = { ascii: "Calibri", hAnsi: "Calibri", eastAsia: "Microsoft YaHei" };
const HEADER_COLOR = "1F3864";
const ACCENT_COLOR = "2E75B6";
const TABLE_HEADER_BG = "D6E4F0";
const TABLE_ALT_BG = "F2F7FB";
const CODE_BG = "F5F5F5";
const CODE_FONT = "Consolas";
const BORDER_COLOR = "B4C6E7";

const tableBorder = { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR };
const tableBorders = {
  top: tableBorder, bottom: tableBorder,
  left: tableBorder, right: tableBorder,
  insideHorizontal: tableBorder, insideVertical: tableBorder,
};

// --- Utility: decode HTML entities ---
function decodeEntities(str) {
  return str
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// --- Inline tokens to TextRun[] ---
function inlineToRuns(inlineTokens, parentBold = false, parentItalic = false) {
  const runs = [];
  if (!inlineTokens) return runs;
  for (const t of inlineTokens) {
    switch (t.type) {
      case "text":
        runs.push(new TextRun({
          text: decodeEntities(t.text || t.raw || ""),
          bold: parentBold, italics: parentItalic, font: FONT, size: 22,
        }));
        break;
      case "strong":
        runs.push(...inlineToRuns(t.tokens, true, parentItalic));
        break;
      case "em":
        runs.push(...inlineToRuns(t.tokens, parentBold, true));
        break;
      case "codespan":
        runs.push(new TextRun({
          text: t.text, font: CODE_FONT, size: 20, bold: parentBold,
          shading: { type: ShadingType.SOLID, color: CODE_BG, fill: CODE_BG },
        }));
        break;
      case "link":
        runs.push(new TextRun({
          text: t.text || t.href, bold: parentBold, italics: parentItalic,
          font: FONT, size: 22, color: ACCENT_COLOR, underline: {},
        }));
        break;
      case "image":
        // Images handled at paragraph level; skip inline
        break;
      case "checkbox":
        // buildList draws the box in place of the bullet
        break;
      case "br":
        runs.push(new TextRun({ break: 1, font: FONT }));
        break;
      default:
        if (t.raw) {
          runs.push(new TextRun({
            text: decodeEntities(t.raw), bold: parentBold, italics: parentItalic,
            font: FONT, size: 22,
          }));
        }
        break;
    }
  }
  return runs;
}

// --- Paragraph inline runs ---
function paragraphRuns(token) {
  if (token.tokens) return inlineToRuns(token.tokens);
  return [new TextRun({ text: token.text || token.raw || "", font: FONT, size: 22 })];
}

// --- Table builder ---
function buildTable(token) {
  const rows = [];
  if (token.header) {
    rows.push(new TableRow({
      tableHeader: true,
      children: token.header.map(cell => new TableCell({
        shading: { type: ShadingType.SOLID, color: TABLE_HEADER_BG, fill: TABLE_HEADER_BG },
        children: [new Paragraph({
          children: inlineToRuns(cell.tokens, true),
          spacing: { before: 40, after: 40 },
        })],
      })),
    }));
  }
  if (token.rows) {
    token.rows.forEach((row, idx) => {
      rows.push(new TableRow({
        children: row.map(cell => new TableCell({
          shading: idx % 2 === 1
            ? { type: ShadingType.SOLID, color: TABLE_ALT_BG, fill: TABLE_ALT_BG }
            : undefined,
          children: [new Paragraph({
            children: inlineToRuns(cell.tokens),
            spacing: { before: 30, after: 30 },
          })],
        })),
      }));
    });
  }
  return new Table({
    rows, width: { size: 100, type: WidthType.PERCENTAGE }, borders: tableBorders,
  });
}

// --- Code block builder ---
function buildCodeBlock(token, left = 360) {
  const lines = (token.text || "").split("\n");
  return lines.map(line => new Paragraph({
    children: [new TextRun({ text: line || " ", font: CODE_FONT, size: 18 })],
    spacing: { before: 20, after: 20 },
    shading: { type: ShadingType.SOLID, color: CODE_BG, fill: CODE_BG },
    indent: { left },
  }));
}

// --- List builder ---
// Items of a tight list hold "text" blocks and those of a loose list "paragraph" blocks; the first
// one goes on the bullet line and every later block follows it, indented, in order.
function buildList(token, level = 0) {
  const items = [];
  const start = token.ordered && token.start !== "" && token.start != null ? Number(token.start) : 1;
  token.items.forEach((item, index) => {
    const blocks = item.tokens || [];
    const first = blocks.find(t => t.type === "text" || t.type === "paragraph");
    const bullet = item.task ? (item.checked ? "\u2612" : "\u2610")
      : token.ordered ? `${start + index}.` : "\u2022";
    const indent = 720 + level * 360;
    items.push(new Paragraph({
      children: [
        new TextRun({ text: `${bullet}  `, font: FONT, size: 22 }),
        ...(first ? paragraphRuns(first) : [new TextRun({
          text: decodeEntities(item.text || ""), font: FONT, size: 22,
        })]),
      ],
      spacing: { before: 40, after: 40 },
      indent: { left: indent },
    }));
    for (const block of blocks) {
      if (block === first || block.type === "space" || block.type === "checkbox") continue;
      if (block.type === "list") {
        items.push(...buildList(block, level + 1));
      } else if (block.type === "code") {
        items.push(...buildCodeBlock(block, indent + 360));
      } else if (block.type === "table") {
        items.push(buildTable(block));
      } else if (block.type === "text" || block.type === "paragraph") {
        items.push(new Paragraph({
          children: paragraphRuns(block), spacing: { before: 40, after: 40 }, indent: { left: indent + 360 },
        }));
      } else if (block.raw?.trim()) {
        items.push(new Paragraph({
          children: [new TextRun({ text: decodeEntities(block.raw.trim()), font: FONT, size: 22 })],
          spacing: { before: 40, after: 40 }, indent: { left: indent + 360 },
        }));
      }
    }
  });
  return items;
}

// --- Image paragraph builder ---
function placeholder(text) {
  return new Paragraph({
    children: [new TextRun({ text, font: FONT, size: 20, italics: true, color: "888888" })],
    spacing: { before: 80, after: 80 },
  });
}

function buildImage(imgToken) {
  const href = imgToken.href || "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) {
    warnings.push(`image not embedded, only local files are supported: ${href}`);
    return [placeholder(`[Image not embedded: ${href}]`)];
  }
  const imgPath = resolve(inputDir, href);
  if (!existsSync(imgPath)) {
    warnings.push(`image not found: ${imgPath}`);
    return [placeholder(`[Image not found: ${href}]`)];
  }
  const imgBuf = readFileSync(imgPath);
  const info = imageInfo(imgBuf);
  if (!info) {
    warnings.push(`image not embedded, only PNG and JPEG are supported: ${imgPath}`);
    return [placeholder(`[Image not embedded: ${href}]`)];
  }
  const maxW = 580; // ~6 inches at the docx library's 96 dpi conversion
  const maxH = 816; // ~8.5 inches, leaving room for spacing/caption within a 9-inch body
  const scale = Math.min(1, maxW / info.width, maxH / info.height);
  const w = Math.round(info.width * scale);
  const h = Math.round(info.height * scale);
  const result = [new Paragraph({
    children: [new ImageRun({ data: imgBuf, transformation: { width: w, height: h }, type: info.type })],
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 40 },
  })];
  // Add caption if alt text exists
  if (imgToken.text) {
    result.push(new Paragraph({
      children: [new TextRun({ text: imgToken.text, font: FONT, size: 18, italics: true, color: "666666" })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 120 },
    }));
  }
  return result;
}

// --- Build document children ---
const children = [];

// Title page (from front-matter metadata)
children.push(
  new Paragraph({ spacing: { before: 2400 } }),
  new Paragraph({
    children: [new TextRun({ text: mainTitle, font: FONT, size: 56, bold: true, color: HEADER_COLOR })],
    alignment: AlignmentType.CENTER,
  }),
);
if (subtitle) {
  children.push(new Paragraph({
    children: [new TextRun({ text: subtitle, font: FONT, size: 36, color: ACCENT_COLOR })],
    alignment: AlignmentType.CENTER, spacing: { after: 400 },
  }));
}
const metadata = [date && `Date: ${date}`, version && `Version: ${version}`].filter(Boolean).join("  |  ");
if (metadata) {
  children.push(new Paragraph({
    children: [new TextRun({ text: metadata, font: FONT, size: 22, color: "666666" })],
    alignment: AlignmentType.CENTER,
  }));
}
if (audience) {
  children.push(new Paragraph({
    children: [new TextRun({ text: `Audience: ${audience}`, font: FONT, size: 22, color: "666666" })],
    alignment: AlignmentType.CENTER, spacing: { after: 600 },
  }));
}
children.push(new Paragraph({ children: [new PageBreak()] }));

// Table of Contents (static, built from headings found in the markdown)
children.push(
  new Paragraph({
    children: [new TextRun({ text: "Table of Contents", font: FONT, size: 32, bold: true, color: HEADER_COLOR })],
    spacing: { before: 200, after: 400 },
  }),
);

// Pre-scan tokens for headings to build the TOC
for (const tok of tokens) {
  if (tok.type !== "heading" || tok.depth > 3) continue;
  // Skip the title heading and the TOC heading itself
  if (tok === titleHeading) continue;
  if (tok.text === "Table of Contents") continue;

  const indent = (tok.depth - 1) * 360;
  const tocSize = tok.depth === 1 ? 24 : tok.depth === 2 ? 22 : 20;
  const tocBold = tok.depth <= 2;
  const tocColor = tok.depth <= 2 ? HEADER_COLOR : ACCENT_COLOR;

  children.push(new Paragraph({
    children: [new TextRun({
      text: decodeEntities(tok.text),
      font: FONT, size: tocSize, bold: tocBold, color: tocColor,
    })],
    spacing: { before: tok.depth === 2 ? 80 : 40, after: 40 },
    indent: { left: indent },
  }));
}

children.push(new Paragraph({ children: [new PageBreak()] }));

// --- Token walker ---
let skipToc = false;

for (const token of tokens) {
  switch (token.type) {
    case "heading": {
      // The title heading is already on the title page
      if (token === titleHeading) continue;
      // Skip markdown TOC section
      if (token.text === "Table of Contents") { skipToc = true; continue; }
      if (skipToc && token.depth > 2) continue;
      skipToc = false;

      const headingMap = {
        1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2,
        3: HeadingLevel.HEADING_3, 4: HeadingLevel.HEADING_4,
      };
      children.push(new Paragraph({
        heading: headingMap[token.depth] || HeadingLevel.HEADING_4,
        children: [new TextRun({
          text: decodeEntities(token.text),
          font: FONT, bold: true,
          color: token.depth <= 2 ? HEADER_COLOR : ACCENT_COLOR,
          size: token.depth === 1 ? 36 : token.depth === 2 ? 32 : token.depth === 3 ? 26 : 24,
        })],
        spacing: { before: token.depth === 2 ? 360 : 240, after: 120 },
      }));
      break;
    }
    case "paragraph": {
      if (skipToc) continue;
      // Images are block-level in Word: any text goes first, then each image on its own.
      const inline = token.tokens || [];
      const images = inline.filter(t => t.type === "image");
      const rest = inline.filter(t => t.type !== "image");
      if (!images.length || rest.some(t => t.type !== "br" && (t.raw || "").trim())) {
        children.push(new Paragraph({
          children: images.length ? inlineToRuns(rest) : paragraphRuns(token), spacing: { before: 80, after: 80 },
        }));
      }
      for (const image of images) children.push(...buildImage(image));
      break;
    }
    case "table":
      if (skipToc) continue;
      children.push(buildTable(token));
      children.push(new Paragraph({ spacing: { after: 120 } }));
      break;
    case "code":
      if (skipToc) continue;
      if (token.lang === "mermaid") {
        children.push(new Paragraph({
          children: [new TextRun({
            text: "[Diagram: See source .md file for interactive Mermaid diagram]",
            font: FONT, size: 20, italics: true, color: "888888",
          })],
          spacing: { before: 80, after: 80 },
          shading: { type: ShadingType.SOLID, color: CODE_BG, fill: CODE_BG },
          indent: { left: 360 },
        }));
      } else {
        children.push(...buildCodeBlock(token));
      }
      children.push(new Paragraph({ spacing: { after: 80 } }));
      break;
    case "list":
      if (skipToc) continue;
      children.push(...buildList(token));
      break;
    case "hr":
      skipToc = false;
      children.push(new Paragraph({
        spacing: { before: 200, after: 200 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR } },
      }));
      break;
    case "space":
      break;
    default:
      if (token.raw && !skipToc) {
        children.push(new Paragraph({
          children: [new TextRun({ text: decodeEntities(token.raw.trim()), font: FONT, size: 22 })],
          spacing: { before: 80, after: 80 },
        }));
      }
      break;
  }
}

// --- Create and write document ---
const doc = new Document({
  styles: {
    default: {
      document: { run: { font: FONT, size: 22 } },
      heading1: {
        run: { font: FONT, size: 36, bold: true, color: HEADER_COLOR },
        paragraph: { spacing: { before: 360, after: 160 } },
      },
      heading2: {
        run: { font: FONT, size: 32, bold: true, color: HEADER_COLOR },
        paragraph: { spacing: { before: 320, after: 120 } },
      },
      heading3: {
        run: { font: FONT, size: 26, bold: true, color: ACCENT_COLOR },
        paragraph: { spacing: { before: 240, after: 100 } },
      },
    },
  },
  sections: [{
    properties: {
      page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
    },
    children,
  }],
  features: { updateFields: false },
});

const buffer = await Packer.toBuffer(doc);
writeFileSync(outputPath, buffer);
for (const warning of warnings) console.error(`WARN: ${warning}`);
console.log(`Generated: ${outputPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
