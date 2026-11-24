import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(scriptDirectory, "..");
const sourceRoot = path.join(uiRoot, "src");
const localeRoot = path.join(sourceRoot, "i18n", "locales");
const englishLocalePath = path.join(localeRoot, "en.ts");
// --check          exit 1 when unused keys exist (regression gate)
// --check-parity   also exit 1 when locale key parity drifts (opt-in)
const checkMode = process.argv.includes("--check") || process.argv.includes("--check-parity");
const checkParity = process.argv.includes("--check-parity");
// Compare non-English active locales against the canonical English catalog.
const comparisonLocales = ["zh"];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function walkTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entryPath !== localeRoot) {
        files.push(...(await walkTypeScriptFiles(entryPath)));
      }
      continue;
    }

    if (/\.tsx?$/i.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files;
}

function extractLocaleKeys(source) {
  const keys = new Set();
  const propertyPattern = /^\s*["']([^"']+)["']\s*:/gm;

  for (const match of source.matchAll(propertyPattern)) {
    keys.add(match[1]);
  }

  return [...keys].sort();
}

function stripComments(source) {
  let output = "";
  let index = 0;
  let quote = null;

  while (index < source.length) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (quote) {
      output += character;
      if (character === "\\") {
        output += nextCharacter ?? "";
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      index += 1;
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      output += character;
      index += 1;
      continue;
    }

    if (character === "/" && nextCharacter === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }

    if (character === "/" && nextCharacter === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index += 2;
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((key) => !rightSet.has(key));
}

function extractDynamicKeyPatterns(source) {
  const patterns = [];
  const translationTemplatePattern = /\b(?:t|tr|translate)\s*\(\s*`((?:\\.|[^`])*)`/g;

  for (const match of source.matchAll(translationTemplatePattern)) {
    const template = match[1];
    if (!template.includes("${")) continue;

    const interpolationPattern = /\$\{[^}]*\}/g;
    let pattern = "^";
    let cursor = 0;

    for (const interpolation of template.matchAll(interpolationPattern)) {
      pattern += escapeRegExp(template.slice(cursor, interpolation.index));
      pattern += ".*";
      cursor = interpolation.index + interpolation[0].length;
    }

    pattern += `${escapeRegExp(template.slice(cursor))}$`;
    patterns.push(new RegExp(pattern));
  }

  return patterns;
}

async function main() {
  const [englishLocale, sourceFiles, localeSources] = await Promise.all([
    readFile(englishLocalePath, "utf8"),
    walkTypeScriptFiles(sourceRoot),
    Promise.all(
      comparisonLocales.map(async (locale) => [
        locale,
        await readFile(path.join(localeRoot, `${locale}.ts`), "utf8"),
      ]),
    ),
  ]);
  const source = stripComments(
    (await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")))).join("\n"),
  );
  const keys = extractLocaleKeys(stripComments(englishLocale));
  const dynamicKeyPatterns = extractDynamicKeyPatterns(source);
  const unusedKeys = keys.filter((key) => {
    const literal = new RegExp("([\"'`])" + escapeRegExp(key) + "\\1");
    const matchesDynamicTemplate = dynamicKeyPatterns.some((pattern) => pattern.test(key));
    return !literal.test(source) && !matchesDynamicTemplate;
  });
  const parityIssues = [];

  for (const [locale, localeSource] of localeSources) {
    const localeKeys = extractLocaleKeys(stripComments(localeSource));
    const missing = difference(keys, localeKeys);
    const extra = difference(localeKeys, keys);
    if (missing.length || extra.length) {
      parityIssues.push({ locale, missing, extra });
    }
  }

  for (const key of unusedKeys) {
    console.log(key);
  }

  console.log(`\n${unusedKeys.length} unused of ${keys.length} English locale keys.`);

  if (checkParity) {
    for (const issue of parityIssues) {
      console.error(`Locale ${issue.locale} differs from en.`);
      if (issue.missing.length) console.error(`  missing: ${issue.missing.join(", ")}`);
      if (issue.extra.length) console.error(`  extra: ${issue.extra.join(", ")}`);
    }
  }

  if (checkMode && unusedKeys.length > 0) {
    process.exitCode = 1;
  }

  if (checkParity && parityIssues.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});