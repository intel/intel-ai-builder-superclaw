import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const indexCssPath = path.resolve(here, "../src/app/index.css");

// The same minify pass Tailwind runs on the stylesheet during `vite build`.
const { optimize } = require(require.resolve("@tailwindcss/node", {
  paths: [require.resolve("@tailwindcss/vite")],
}));

function compile(css) {
  return optimize(css, { file: "index.css", minify: true }).code;
}

function rules(css) {
  return css
    .split("}")
    .map((rule) => rule.trim())
    .filter(Boolean)
    .map((rule) => {
      const brace = rule.indexOf("{");
      return { selector: rule.slice(0, brace), body: rule.slice(brace + 1) };
    });
}

// The shell's own rule is `:where(... .rounded-shell)`, so its compiled
// selector contains `.rounded-shell)` and not `.rounded-shell{`. Matching
// only the latter inspects nothing and a blur on the panel would pass.
function elementShells(css) {
  return rules(css).filter(
    (rule) =>
      (rule.selector.includes(".rounded-shell") || rule.selector.includes(".sticky")) &&
      !rule.selector.includes(":before"),
  );
}

test("Tailwind's minify pass drops an unprefixed backdrop-filter when the prefix follows it", () => {
  const compiled = compile(
    '[data-theme="dark"] .rounded-shell { backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }',
  );
  assert.match(compiled, /-webkit-backdrop-filter:blur\(10px\)/);
  assert.doesNotMatch(compiled, /(?<!-)backdrop-filter:/);
});

test("a backdrop-filter on the :where shell rule is visible to the guard", () => {
  const compiled = compile(
    ':where([data-theme="dark"] :is(main, aside).rounded-shell) { position: relative; backdrop-filter: blur(10px); }',
  );
  const shells = elementShells(compiled);
  assert.ok(shells.length > 0, compiled);
  assert.ok(
    shells.some((rule) => /(?<!-)backdrop-filter:blur\(10px\)/.test(rule.body)),
    compiled,
  );
});

test("dark shell frost keeps an unprefixed backdrop-filter on the pseudo-element only", () => {
  const source = fs.readFileSync(indexCssPath, "utf8");
  const start = source.indexOf("/* Frost on a pseudo-element");
  const end = source.indexOf("/* Global clickable");
  assert.ok(start >= 0 && end > start, "frost rules moved; update this test");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
  // The prefix is what makes Lightning CSS drop the unprefixed property.
  assert.doesNotMatch(code, /-webkit-backdrop-filter/);

  const frost = source.slice(start, end);
  assert.match(frost, /:is\(main, aside\)\.rounded-shell::before/);
  assert.doesNotMatch(frost, /\[data-theme="dark"\] \.rounded-shell::before/);

  const compiled = compile(frost);

  const underDialog = (rule) => rule.selector.includes("[data-settings-dialog-layer]");
  const frostRules = rules(compiled).filter(
    (rule) =>
      rule.selector.includes(".rounded-shell:before") ||
      rule.selector.includes(".sticky:not([data-composer-shell]):before"),
  );
  const shellFrost = frostRules.filter((rule) => !underDialog(rule) && rule.selector.includes(".rounded-shell:before"));
  const stickyFrost = frostRules.filter((rule) => !underDialog(rule) && rule.selector.includes(".sticky:not("));
  assert.ok(shellFrost.length > 0, compiled);
  assert.ok(stickyFrost.length > 0, compiled);
  for (const rule of [...shellFrost, ...stickyFrost]) {
    assert.match(rule.body, /(?<!-)backdrop-filter:blur\(10px\)/);
  }

  // Under the open Settings dialog the frost is switched off, unprefixed.
  const dialogOff = frostRules.filter(underDialog);
  assert.ok(dialogOff.length > 0, compiled);
  for (const rule of dialogOff) {
    assert.match(rule.body, /(?<!-)backdrop-filter:none/);
  }

  // The panel and the sticky header themselves must not become the
  // containing block for position:fixed descendants. Require a match:
  // the :where() shell rule is the one that would take the filter.
  const shells = elementShells(compiled);
  assert.ok(shells.length > 0, compiled);
  for (const rule of shells) {
    assert.doesNotMatch(rule.body, /backdrop-filter/, rule.selector);
  }

  const composer = rules(compiled).filter(
    (rule) =>
      rule.selector.includes("[data-composer-shell]") && !rule.selector.includes(":before"),
  );
  assert.ok(composer.length > 0, compiled);
  for (const rule of composer) {
    assert.match(rule.body, /(?<!-)backdrop-filter:none/);
  }
});
