import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectCss,
  inspectSource,
  inspectTailwindConfig,
  inspectThemeTokens,
  isExcludedSourcePath,
  createClassHelperIndex,
} from "./design-token-rules.mjs";
import { inspectCompiledTokenUtilities } from "./design-token-compiler.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.resolve(scriptDirectory, "../src");
const uiDirectory = path.resolve(scriptDirectory, "..");
const violations = [];
const sourceFiles = [];
const literalColorValuePattern = /#[\da-f]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)/i;

async function checkTokenOwnership() {
  const tokenCssPath = path.join(sourceDirectory, "app/index.css");
  const primitiveCssPath = path.join(sourceDirectory, "styles/colors.css");
  const tailwindConfigPath = path.join(uiDirectory, "tailwind.config.ts");
  const [tokenCss, primitiveCss, tailwindConfig] = await Promise.all([
    readFile(tokenCssPath, "utf8"),
    readFile(primitiveCssPath, "utf8"),
    readFile(tailwindConfigPath, "utf8"),
  ]);

  for (const violation of inspectThemeTokens(tokenCss)) {
    violations.push(`app/index.css: ${violation}`);
  }

  if (/^\s*--(?:dls-|text-|radius-)[\w-]+\s*:/m.test(primitiveCss)) {
    violations.push("styles/colors.css: semantic tokens belong in app/index.css");
  }

  for (const violation of inspectTailwindConfig(tailwindConfig)) {
    violations.push(`../tailwind.config.ts: ${violation}`);
  }
  if (literalColorValuePattern.test(tailwindConfig)) {
    violations.push("../tailwind.config.ts: literal colors belong in CSS token definitions");
  }
  return { tokenCss, tailwindConfig };
}

async function visit(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const relativePath = path.relative(sourceDirectory, entryPath).split(path.sep).join("/");
    if (isExcludedSourcePath(relativePath)) continue;

    if (entry.isDirectory()) {
      await visit(entryPath);
      continue;
    }
    if (!entry.isFile() || ![".css", ".ts", ".tsx"].includes(path.extname(entry.name))) continue;

    const source = await readFile(entryPath, "utf8");
    if (entry.name.endsWith(".css")) {
      violations.push(...inspectCss(source, relativePath));
    } else {
      sourceFiles.push({ source, filePath: relativePath });
    }
  }
}

const { tokenCss, tailwindConfig } = await checkTokenOwnership();
await visit(sourceDirectory);
const classHelperIndex = createClassHelperIndex(sourceFiles);
for (const { source, filePath } of sourceFiles) {
  violations.push(...inspectSource(source, filePath, classHelperIndex));
}
violations.push(...await inspectCompiledTokenUtilities(sourceFiles, tokenCss, tailwindConfig, uiDirectory, classHelperIndex));

if (violations.length > 0) {
  console.error("Design token check failed: use semantic typography, radius, and color tokens; direct palette utilities are not allowed in application source.");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Design token check passed: no unapproved typography, radius, direct palette utilities, or literal color values identified.");
}