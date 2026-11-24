import assert from "node:assert/strict";
import test from "node:test";
import {
  createClassHelperIndex,
  inspectCss,
  inspectSource,
  inspectTailwindConfig,
  inspectThemeTokens,
  requiredThemeColorTokens,
} from "./design-token-rules.mjs";

function checkFixtures(fixtures, inspect) {
  for (const fixture of fixtures) {
    const violations = inspect(fixture.source, fixture.filePath ?? "components/fixture.tsx");
    if (fixture.accepted) {
      assert.deepEqual(violations, [], fixture.name);
      continue;
    }

    assert.ok(violations.length > 0, `${fixture.name}: expected a violation`);
    for (const expected of fixture.expected) {
      assert.ok(
        violations.some((violation) => violation.includes(expected)),
        `${fixture.name}: expected a violation containing ${expected}`,
      );
    }
  }
}

test("source rules accept semantic classes and prose, reject unsafe utilities", () => {
  checkFixtures([
    {
      name: "token-like prose outside class attributes",
      accepted: true,
      source: `const copy = "The total is rounded and shown as text-sm in the report";`,
    },
    {
      name: "semantic class utilities and tokenized inline styles",
      accepted: true,
      source: `<div class="bg-dls-surface text-body rounded-card" style={{ fontSize: "var(--text-body)", borderRadius: "var(--radius-card)" }} />`,
    },
    {
      name: "arbitrary typography and radius",
      expected: ["text-[13px]", "rounded-[18px]"],
      source: `<div class="text-[13px] rounded-[18px]" />`,
    },
    {
      name: "legacy Tailwind palette",
      expected: ["unsupported Tailwind color scale bg-red-500"],
      source: `<div class="bg-red-500" />`,
    },
    {
      name: "direct Radix palette utility",
      expected: ["direct Radix palette utility text-red-9"],
      source: `<div class="text-red-9" />`,
    },
    {
      name: "Radix palette variable in arbitrary class utility",
      expected: ["direct Radix palette variable var(--red-9)"],
      source: `<div class="text-[var(--red-9)]" />`,
    },
    {
      name: "Radix palette variable in rendered inline style",
      expected: ["direct Radix palette variable var(--red-9)"],
      source: `<div style={{ color: "var(--red-9)" }} />`,
    },
    {
      name: "literal color in arbitrary utility",
      expected: ["hard-coded color #fff"],
      source: `<div class="bg-[#fff]" />`,
    },
    {
      name: "un-tokenized inline style properties",
      expected: ["inline style fontSize", "inline style borderRadius"],
      source: `<div style={{ fontSize: "13px", borderRadius: "18px" }} />`,
    },
  ], (source, filePath) => inspectSource(source, filePath));
});

test("source rules inspect static class composition and rendered HTML", () => {
  const source = `
    const base = "text-[13px]";
    const variants = { active: "rounded-[18px]" };
    const selectedVariant = () => "active";
    const Button = () => <button class={\`${"${base}"} ${"${variants[selectedVariant()]}"}\`.trim()} />;
    const Toggle = () => <button class={["bg-red-500"].join(" ")} />;
    const editor = document.createElement("span");
    editor.className = "text-[15px]";
    const markdownClass = "text-[17px]";
    const markdown = \`<span class="rounded-[20px] ${"${markdownClass}"}">text-sm is prose</span>\`;
  `;
  const violations = inspectSource(source, "components/static-rendering.tsx");

  for (const expected of [
    "text-[13px]",
    "rounded-[18px]",
    "bg-red-500",
    "text-[15px]",
    "rounded-[20px]",
    "text-[17px]",
  ]) {
    assert.ok(violations.some((violation) => violation.includes(expected)), expected);
  }
  assert.ok(!violations.some((violation) => violation.includes("text-sm")));
});

test("source rules resolve helper imports from dotted basenames", () => {
  const sourceFiles = [
    {
      filePath: "components/scheduled.cards.tsx",
      source: `
        import { statusAccentClass, statusTone } from "./scheduled.cron";
        export const Card = (status: string) => (
          <span class={\`text-body ${"${statusTone(status)}"} ${"${statusAccentClass(status)}"}\`} />
        );
      `,
    },
    {
      filePath: "components/scheduled.cron.ts",
      source: `
        export const statusTone = (status: string) => status === "running" ? "text-dls-success-text" : "text-red-9";
        export const statusAccentClass = (status: string) => status === "running" ? "bg-dls-success-bg" : "bg-dls-warning-bg";
      `,
    },
  ];

  const helperIndex = createClassHelperIndex(sourceFiles);
  const violations = inspectSource(sourceFiles[0].source, sourceFiles[0].filePath, helperIndex);
  assert.ok(violations.some((violation) => violation.includes("direct Radix palette utility text-red-9")));
  assert.ok(!violations.some((violation) => violation.includes("text-dls-success-text")));
  assert.ok(!violations.some((violation) => violation.includes("bg-dls-warning-bg")));
});

test("source rules resolve imported static constants from the UI alias", () => {
  const sourceFiles = [
    {
      filePath: "app/components/model-combobox.tsx",
      source: `
        import { FIELD_BOX_CLASS } from "~/shared/ui/listbox";
        export const ModelBox = () => <input class={FIELD_BOX_CLASS} />;
      `,
    },
    {
      filePath: "shared/ui/listbox.ts",
      source: `
        export const FIELD_BOX_CLASS = "w-full bg-dls-panel-input-bg p-3 rounded-inset border border-dls-panel-input-border text-red-9 text-body-lg";
      `,
    },
  ];

  const helperIndex = createClassHelperIndex(sourceFiles);
  const violations = inspectSource(sourceFiles[0].source, sourceFiles[0].filePath, helperIndex);
  assert.ok(violations.some((violation) => violation.includes("direct Radix palette utility text-red-9")));
});

test("class references resolve to declarations in their own component", () => {
  const source = [
    'const First = () => {',
    '  const classes = "text-red-9";',
    '  return <span class={classes} />;',
    '};',
    'const Second = () => {',
    '  const classes = "text-body";',
    '  return <span class={classes} />;',
    '};',
  ].join("\n");

  const violations = inspectSource(source, "components/scope.tsx");
  assert.ok(violations.some((violation) => violation.includes("direct Radix palette utility text-red-9")));
  assert.ok(!violations.some((violation) => violation.startsWith("components/scope.tsx:7:")));
});

test("CSS rules accept token values and reject literal colors and raw dimensions", () => {
  checkFixtures([
    {
      name: "semantic CSS values",
      accepted: true,
      filePath: "components/tokens.css",
      source: `.panel { color: var(--dls-text-primary); font-size: var(--text-body); border-radius: var(--radius-card); }`,
    },
    {
      name: "literal color and raw dimensions",
      filePath: "components/tokens.css",
      expected: ["literal CSS color #fff", "font-size: 13px", "border-radius: 18px"],
      source: `.panel { color: #fff; font-size: 13px; border-radius: 18px; }`,
    },
  ], inspectCss);
});

test("theme rules require semantic token families and light/dark values", () => {
  const declarations = [
    ...requiredThemeColorTokens.map((token) => `${token}: var(${token});`),
    "--text-body: 1rem;",
    "--radius-card: 0.5rem;",
  ].join("\n");

  checkFixtures([
    {
      name: "complete light and dark token blocks",
      accepted: true,
      source: `:root { ${declarations} } [data-theme="dark"] { ${declarations} }`,
    },
    {
      name: "missing theme and token declarations",
      expected: ["missing semantic typography tokens", "missing semantic radius tokens", "missing theme token block"],
      source: "",
    },
  ], (source) => inspectThemeTokens(source));
});

test("Tailwind config rules allow semantic roles and reject palette exposure", () => {
  checkFixtures([
    {
      name: "semantic color map",
      accepted: true,
      source: `export default { theme: { colors: { dls: { surface: "var(--dls-surface)", accent: "var(--dls-accent)", "secondary-accent-text": "var(--dls-secondary-accent-text)" } } } };`,
    },
    {
      name: "direct palette key",
      expected: ["non-semantic utility key red"],
      source: `export default { theme: { colors: { red: "var(--red-9)" } } };`,
    },
    {
      name: "invalid DLS mapping and config safelist",
      expected: ["DLS color utilities must map to --dls-* tokens", "Tailwind v4 ignores config safelist"],
      source: `export default { safelist: ["text-red-9"], theme: { colors: { dls: { danger: "var(--red-9)" } } } };`,
    },
  ], (source) => inspectTailwindConfig(source));
});