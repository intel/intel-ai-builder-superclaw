import { readFile } from "node:fs/promises";
import { compile } from "tailwindcss";
import postcss from "postcss";
import { fileURLToPath } from "node:url";
import { collectClassStringSegments, createClassHelperIndex, extractTailwindColorTheme } from "./design-token-rules.mjs";

const tailwindDefaultThemePath = fileURLToPath(import.meta.resolve("tailwindcss/theme.css"));

function lineNumber(source, offset) {
  return source.slice(0, offset).split(/\r?\n/).length;
}

function utilityPart(candidate) {
  let bracketDepth = 0;
  let variantSeparator = -1;
  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index];
    if (character === "[") bracketDepth += 1;
    else if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (character === ":" && bracketDepth === 0) variantSeparator = index;
  }
  return candidate.slice(variantSeparator + 1);
}

function isTokenUtility(candidate) {
  const utility = utilityPart(candidate);
  const colorUtilityPattern = /^(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|fill|stroke|placeholder|divide(?:-[xy])?|from|via|to|accent|outline|decoration|shadow|caret)-/;
  if (candidate.includes("dls-") && colorUtilityPattern.test(utility)) return true;
  return /^rounded(?:-(?:[a-zA-Z0-9][\w-]*|\[[^\]]+\]))?$/.test(utility) ||
    /^text-(?:[a-zA-Z0-9][\w/-]*|\[[^\]]+\])$/.test(utility);
}

function addCandidates(value, offset, source, filePath, candidates) {
  for (const match of value.matchAll(/\S+/g)) {
    const candidate = match[0];
    if (!isTokenUtility(candidate) || candidates.has(candidate)) continue;
    candidates.set(candidate, {
      filePath,
      line: lineNumber(source, offset + match.index),
    });
  }
}

export function collectTokenUtilityCandidates(source, filePath, classHelperIndex) {
  const candidates = new Map();
  for (const { value, offset } of collectClassStringSegments(source, filePath, classHelperIndex)) {
    addCandidates(value, offset, source, filePath.replace(/\\/g, "/"), candidates);
  }

  return Array.from(candidates, ([candidate, location]) => ({ candidate, ...location }));
}

function escapeClassName(candidate) {
  return Array.from(candidate, (character, index) => {
    const codePoint = character.codePointAt(0);
    const startsWithDigit = index === 0 && codePoint >= 48 && codePoint <= 57;
    const secondCharacterIsDigit = index === 1 && candidate[0] === "-" && codePoint >= 48 && codePoint <= 57;
    if (startsWithDigit || secondCharacterIsDigit || (codePoint >= 1 && codePoint <= 31) || codePoint === 127) {
      return `\\${codePoint.toString(16)} `;
    }
    if (codePoint >= 128 || /[a-zA-Z0-9_-]/.test(character)) return character;
    return `\\${character}`;
  }).join("");
}

function selectorHasClass(selector, candidate) {
  const escapedCandidate = `.${escapeClassName(candidate)}`;
  let offset = selector.indexOf(escapedCandidate);
  while (offset !== -1) {
    const nextCharacter = selector[offset + escapedCandidate.length];
    if (nextCharacter === undefined || /[\s,:>{+~\[\])]/.test(nextCharacter)) return true;
    offset = selector.indexOf(escapedCandidate, offset + escapedCandidate.length);
  }
  return false;
}

export async function inspectCompiledTokenUtilities(sourceFiles, tokenCss, tailwindConfig, base, classHelperIndex) {
  const helperIndex = classHelperIndex ?? createClassHelperIndex(sourceFiles);
  const candidates = sourceFiles.flatMap(({ source, filePath }) =>
    collectTokenUtilityCandidates(source, filePath, helperIndex),
  );
  if (candidates.length === 0) return [];

  const tokenStylesheet = postcss.parse(tokenCss);
  const themeBlocks = tokenStylesheet.nodes
    .filter((node) => node.type === "atrule" && node.name === "theme")
    .map((node) => node.toString());
  if (themeBlocks.length === 0) {
    return ["app/index.css: Tailwind utility validation requires an @theme block"];
  }

  const tailwindDefaultTheme = postcss.parse(await readFile(tailwindDefaultThemePath, "utf8"));
  const defaultThemeBlocks = tailwindDefaultTheme.nodes
    .filter((node) => node.type === "atrule" && node.name === "theme")
    .map((node) => node.toString());
  const colorTheme = extractTailwindColorTheme(tailwindConfig);
  const css = [
    "@tailwind utilities;",
    ...defaultThemeBlocks,
    ...themeBlocks,
    `@theme {\n${colorTheme}\n}`,
  ].join("\n");
  const compiler = await compile(css, { base });
  const generatedCss = compiler.build(candidates.map(({ candidate }) => candidate));
  const generatedStylesheet = postcss.parse(generatedCss);
  const selectors = [];
  generatedStylesheet.walkRules((rule) => selectors.push(rule.selector));

  return candidates
    .filter(({ candidate }) => !selectors.some((selector) => selectorHasClass(selector, candidate)))
    .map(({ candidate, filePath, line }) =>
      `${filePath}:${line}: Tailwind generated no CSS for semantic utility ${candidate}`,
    );
}