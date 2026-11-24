import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectTokenUtilityCandidates, inspectCompiledTokenUtilities } from "./design-token-compiler.mjs";
import { createClassHelperIndex, inspectSource } from "./design-token-rules.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const uiDirectory = path.resolve(scriptDirectory, "..");
const [tokenCss, tailwindConfig] = await Promise.all([
  readFile(path.join(uiDirectory, "src/app/index.css"), "utf8"),
  readFile(path.join(uiDirectory, "tailwind.config.ts"), "utf8"),
]);

const inspect = (source) => inspectCompiledTokenUtilities(
  [{ source, filePath: "components/test-fixture.tsx" }],
  tokenCss,
  tailwindConfig,
  uiDirectory,
);

test("ignores token-like prose outside class attributes", () => {
  const source = `
    const copy = "The total is rounded and shown as text-sm in the report";
    export const Fixture = () => <p>{copy}</p>;
  `;

  assert.deepEqual(inspectSource(source, "components/test.tsx"), []);
  assert.deepEqual(collectTokenUtilityCandidates(source, "components/test.tsx"), []);
});

test("only follows approved class composition sources", () => {
  const source = `
    const composed = clsx({ "rounded-[18px]": active });
    <div class={format("rounded-[18px] text-[13px]")} />;
    <div class={clsx("text-[13px]")} />;
    <div class={composed} />;
    <div classList={{ "rounded-[18px]": active, "text-[13px]": compact }} />;
  `;

  const candidates = collectTokenUtilityCandidates(source, "components/test-fixture.tsx")
    .map(({ candidate }) => candidate);
  assert.deepEqual(candidates, ["text-[13px]", "rounded-[18px]"]);
  assert.deepEqual(
    inspectSource(source, "components/test-fixture.tsx").map((violation) => violation.match(/utility (.+?);/)?.[1]),
    ["text-[13px]", "rounded-[18px]", "rounded-[18px]", "text-[13px]"],
  );
});

test("validates semantic utilities from static rendering patterns", async () => {
  const source = `
    const variants = { active: "text-dls-does-not-exist" };
    const selectedVariant = () => "active";
    const Button = () => <button class={\`${"${variants[selectedVariant()]}"}\`.trim()} />;
    const Toggle = () => <button class={["rounded-no-such-token"].join(" ")} />;
    const editor = document.createElement("span");
    editor.className = "bg-dls-no-such-token";
    const markdownClass = "bg-dls-no-such-interpolated-utility";
    const markdown = \`<span class="text-dls-no-generated-utility ${"${markdownClass}"}">copy</span>\`;
  `;
  const candidates = collectTokenUtilityCandidates(source, "components/static-rendering.tsx")
    .map(({ candidate }) => candidate);

  assert.deepEqual(candidates, [
    "text-dls-does-not-exist",
    "rounded-no-such-token",
    "bg-dls-no-such-token",
    "text-dls-no-generated-utility",
    "bg-dls-no-such-interpolated-utility",
  ]);

  const violations = await inspect(source);
  assert.equal(violations.length, candidates.length);
  for (const candidate of candidates) {
    assert.ok(violations.some((violation) => violation.includes(candidate)), candidate);
  }
});

test("inspects imported class-returning helpers in source and compiled checks", async () => {
  const sourceFiles = [
    {
      filePath: "components/status-card.tsx",
      source: `
        import { statusTone as toneClass } from "./status-style";
        const Status = (status: string) => <span class={\`text-body ${"${toneClass(status)}"}\`} />;
      `,
    },
    {
      filePath: "components/status-style.ts",
      source: `
        export const statusTone = (status: string) => {
          if (status === "success") return "text-dls-missing-status-token";
          return "text-red-9";
        };
      `,
    },
  ];
  const helperIndex = createClassHelperIndex(sourceFiles);
  const consumer = sourceFiles[0];
  const sourceViolations = inspectSource(consumer.source, consumer.filePath, helperIndex);
  assert.ok(sourceViolations.some((violation) => violation.includes("direct Radix palette utility text-red-9")));

  const candidates = collectTokenUtilityCandidates(consumer.source, consumer.filePath, helperIndex)
    .map(({ candidate }) => candidate);
  assert.ok(candidates.includes("text-dls-missing-status-token"));

  const violations = await inspectCompiledTokenUtilities(
    sourceFiles,
    tokenCss,
    tailwindConfig,
    uiDirectory,
    helperIndex,
  );
  assert.ok(violations.some((violation) => violation.includes("text-dls-missing-status-token")));
});

test("resolves helper imports from dotted basenames in compiled checks", async () => {
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
  const consumer = sourceFiles[0];
  const sourceViolations = inspectSource(consumer.source, consumer.filePath, helperIndex);
  assert.ok(sourceViolations.some((violation) => violation.includes("direct Radix palette utility text-red-9")));

  const candidates = collectTokenUtilityCandidates(consumer.source, consumer.filePath, helperIndex)
    .map(({ candidate }) => candidate);
  assert.ok(candidates.includes("text-dls-success-text"));
  assert.ok(candidates.includes("bg-dls-warning-bg"));

  const violations = await inspectCompiledTokenUtilities(
    sourceFiles,
    tokenCss,
    tailwindConfig,
    uiDirectory,
    helperIndex,
  );
  assert.ok(!violations.some((violation) => violation.includes("text-dls-success-text")));
  assert.ok(!violations.some((violation) => violation.includes("bg-dls-warning-bg")));
  assert.ok(violations.some((violation) => violation.includes("text-red-9")));
});

test("resolves imported static constants from the UI alias in compiled checks", async () => {
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
  const consumer = sourceFiles[0];
  const sourceViolations = inspectSource(consumer.source, consumer.filePath, helperIndex);
  assert.ok(sourceViolations.some((violation) => violation.includes("direct Radix palette utility text-red-9")));

  const candidates = collectTokenUtilityCandidates(consumer.source, consumer.filePath, helperIndex)
    .map(({ candidate }) => candidate);
  assert.ok(candidates.includes("text-red-9"));

  const violations = await inspectCompiledTokenUtilities(
    sourceFiles,
    tokenCss,
    tailwindConfig,
    uiDirectory,
    helperIndex,
  );
  assert.ok(violations.some((violation) => violation.includes("text-red-9")));
});

test("inspects private helpers, memo class values, and class-named props", async () => {
  const sourceFiles = [
    {
      filePath: "components/style-consumer.tsx",
      source: `
        import { importedTone } from "./style-helpers";
        const Consumer = () => {
          const localTone = (active: boolean) => active ? "text-red-9" : "text-dls-private-helper-missing";
          const memoTone = createMemo(() => active() ? "bg-dls-memo-helper-missing" : "text-body");
          return <><span class={\`${"${localTone(true)}"} ${"${memoTone()}"} ${"${importedTone()}"}\`} />
            <Tooltip toneClass="text-red-9" maxWidthClass="rounded-no-prop-token" />
          </>;
        };
      `,
    },
    {
      filePath: "components/style-helpers.ts",
      source: `
        export const importedTone = () => "text-dls-imported-helper-missing";
      `,
    },
  ];
  const helperIndex = createClassHelperIndex(sourceFiles);
  const consumer = sourceFiles[0];
  const sourceViolations = inspectSource(consumer.source, consumer.filePath, helperIndex);
  assert.ok(sourceViolations.some((violation) => violation.includes("direct Radix palette utility text-red-9")));

  const candidates = collectTokenUtilityCandidates(consumer.source, consumer.filePath, helperIndex)
    .map(({ candidate }) => candidate);
  for (const candidate of [
    "text-dls-private-helper-missing",
    "bg-dls-memo-helper-missing",
    "text-dls-imported-helper-missing",
    "rounded-no-prop-token",
  ]) {
    assert.ok(candidates.includes(candidate), candidate);
  }

  const violations = await inspectCompiledTokenUtilities(
    sourceFiles,
    tokenCss,
    tailwindConfig,
    uiDirectory,
    helperIndex,
  );
  for (const candidate of candidates.filter((value) => value.includes("missing") || value.includes("no-prop"))) {
    assert.ok(violations.some((violation) => violation.includes(candidate)), candidate);
  }
});

test("accepts valid semantic utilities and ignores non-class text", async () => {
  const violations = await inspect(`
    const label = "text-dls-does-not-exist";
    const radiusClass = "rounded-panel";
    export const Fixture = () => (
      <div aria-label={label} class={\`${"${radiusClass}"} text-micro text-dls-danger-text group-hover:bg-dls-panel-hover-bg/60 md:text-left dls-modal-backdrop dls-modal-surface\`} />
    );
  `);

  assert.deepEqual(violations, []);
});

test("reports semantic color, radius, and typography utilities that Tailwind omits", async () => {
  const violations = await inspect(`
    export const Fixture = () => (
      <div class="bg-dls-does-not-exist rounded-not-a-token text-not-a-token" />
    );
  `);

  assert.equal(violations.length, 3);
  assert.match(violations.join("\n"), /bg-dls-does-not-exist/);
  assert.match(violations.join("\n"), /rounded-not-a-token/);
  assert.match(violations.join("\n"), /text-not-a-token/);
});