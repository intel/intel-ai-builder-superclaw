import assert from "node:assert/strict";
import { test } from "bun:test";

import { isComplex, markdownToBlocks } from "../../dist/slack-blocks.js";

test("plain text returns a markdown block", () => {
  assert.equal(isComplex("Hello, how can I help you today?"), false);
  const blocks = markdownToBlocks("Hello, how can I help you today?");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "markdown");
  assert.equal(blocks[0].text, "Hello, how can I help you today?");
});

test("fenced code block with language is preserved", () => {
  const blocks = markdownToBlocks("```python\ndef hello():\n    return 42\n```");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "markdown");
  assert.equal(blocks[0].text, "```python\ndef hello():\n    return 42\n```");
});

test("markdown table is preserved as markdown block", () => {
  const md = "| Col1 | Col2 |\n|------|------|\n| A    | B    |";
  const blocks = markdownToBlocks(md);
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "markdown");
  assert.equal(blocks[0].text, md);
});

test("h1 header maps to header block", () => {
  const blocks = markdownToBlocks("# Big Title");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "header");
  assert.equal(blocks[0].text.text, "Big Title");
});

test("h2 header maps to header block", () => {
  const blocks = markdownToBlocks("## Mid Title");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "header");
  assert.equal(blocks[0].text.text, "Mid Title");
});

test("h3 header maps to header block", () => {
  const blocks = markdownToBlocks("### Small Title");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "header");
  assert.equal(blocks[0].text.text, "Small Title");
});

test("divider maps to divider block", () => {
  const blocks = markdownToBlocks("---");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "divider");
});

test("mixed markdown keeps expected block sequence", () => {
  const md =
    "## Analysis\n\nIntro paragraph\n\n```python\ndef hello():\n    return 42\n```\n\n---\n\n| Col1 | Col2 |\n|------|------|\n| A    | B    |";
  const blocks = markdownToBlocks(md);
  assert.ok(Array.isArray(blocks));
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["header", "markdown", "divider", "markdown"],
  );
});

test("long header text is truncated with ellipsis", () => {
  const longText = "a".repeat(200);
  const blocks = markdownToBlocks(`# ${longText}`);
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "header");
  assert.equal(blocks[0].text.text.length, 150);
  assert.equal(blocks[0].text.text.endsWith("…"), true);
});

test("empty and whitespace input return null", () => {
  assert.equal(markdownToBlocks(""), null);
  assert.equal(markdownToBlocks("   \n\n\t  "), null);
});

test("unclosed code fence does not crash", () => {
  const blocks = markdownToBlocks("## Title\n\n```python\ndef broken():\n    pass");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks.length > 0, true);
  assert.deepEqual(
    blocks.map((block) => block.type),
    ["header", "markdown"],
  );
});

test("block count larger than limit is truncated with notice", () => {
  const manyHeaders = Array.from({ length: 46 }, (_, index) => `# Header ${index + 1}`).join("\n");
  const blocks = markdownToBlocks(manyHeaders);
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks.length, 45);
  assert.equal(blocks.at(-1).type, "markdown");
  assert.equal(blocks.at(-1).text, "(truncated — full response in thread)");
});

test("very large markdown body is split under 12000 chars", () => {
  const huge = `## Head\n\n${"para\n\n".repeat(4000)}`;
  const blocks = markdownToBlocks(huge);
  assert.ok(Array.isArray(blocks));
  const markdownBlocks = blocks.filter((block) => block.type === "markdown");
  assert.equal(markdownBlocks.length > 1, true);
  for (const block of markdownBlocks) {
    assert.equal(block.text.length <= 12000, true);
  }
});

test("header with bold formatting is stripped", () => {
  const blocks = markdownToBlocks("# **Bold Header**");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "header");
  assert.equal(blocks[0].text.text, "Bold Header");
});

test("header with inline code is stripped", () => {
  const blocks = markdownToBlocks("# Using `useState` hook");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "header");
  assert.equal(blocks[0].text.text, "Using useState hook");
});

test("header with mixed formatting is stripped", () => {
  const blocks = markdownToBlocks("# **Bold** and *italic* and `code`");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "header");
  assert.equal(blocks[0].text.text, "Bold and italic and code");
});

test("header with strikethrough is stripped", () => {
  const blocks = markdownToBlocks("# ~~old~~ new");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "header");
  assert.equal(blocks[0].text.text, "old new");
});

test("header with underscores is stripped", () => {
  const blocks = markdownToBlocks("# __important__ _note_");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "header");
  assert.equal(blocks[0].text.text, "important note");
});

test("plain bold text returns a markdown block", () => {
  const blocks = markdownToBlocks("**Hello world**");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "markdown");
  assert.equal(blocks[0].text, "**Hello world**");
});

test("unordered list returns a markdown block", () => {
  const blocks = markdownToBlocks("- item one\n- item two");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "markdown");
  assert.equal(blocks[0].text, "- item one\n- item two");
});

test("ordered list returns a markdown block", () => {
  const blocks = markdownToBlocks("1. First\n2. Second");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "markdown");
  assert.equal(blocks[0].text, "1. First\n2. Second");
});

test("markdown link returns a markdown block", () => {
  const blocks = markdownToBlocks("See [docs](https://example.com)");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "markdown");
  assert.equal(blocks[0].text, "See [docs](https://example.com)");
});

test("inline code returns a markdown block", () => {
  const blocks = markdownToBlocks("Use `npm install`");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "markdown");
  assert.equal(blocks[0].text, "Use `npm install`");
});

test("single asterisk italic returns a markdown block verbatim", () => {
  const blocks = markdownToBlocks("*important note*");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "markdown");
  assert.equal(blocks[0].text, "*important note*");
});

test("Slack mention token passes through verbatim", () => {
  const blocks = markdownToBlocks("Hi <@U123456>, see this");
  assert.ok(Array.isArray(blocks));
  assert.equal(blocks[0].type, "markdown");
  assert.equal(blocks[0].text, "Hi <@U123456>, see this");
});

test("mixed simple+complex: bold before header produces markdown then header then markdown", () => {
  const blocks = markdownToBlocks("**bold intro**\n\n# Header\n\ntext");
  assert.ok(Array.isArray(blocks));
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["markdown", "header", "markdown"],
  );
  assert.equal(blocks[0].text, "**bold intro**");
  assert.equal(blocks[1].text.text, "Header");
  assert.equal(blocks[2].text, "text");
});

test("long plain text splits into multiple markdown blocks each under 12000 chars", () => {
  const blocks = markdownToBlocks("word ".repeat(3000));
  assert.ok(Array.isArray(blocks));
  assert.ok(blocks.length > 1, "should be split into multiple blocks");
  for (const block of blocks) {
    assert.equal(block.type, "markdown");
    assert.ok(block.text.length <= 12000, `block too long: ${block.text.length}`);
  }
});
