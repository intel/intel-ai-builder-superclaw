import path from "node:path";
import postcss from "postcss";
import ts from "typescript";

const literalColorPattern = /#[\da-f]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)/gi;
const arbitraryColorUtilityPattern = /\b[\w-]+-\[[^\]]*(?:#[\da-f]{3,8}\b|(?:rgba?|hsla?)\([^)]*\))[^\]]*\]/gi;
const inlineStylePattern = /\bstyle\s*=\s*(?:\{\{([\s\S]*?)\}\}|(["'])(.*?)\2)/gi;
const unsupportedTailwindColorScalePattern = /\b(?:bg|text|border|ring|fill|stroke|placeholder|divide|from|via|to|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400|500|600|700|800|900|950)(?:\/\d+)?(?![\w-])/g;
const radixPaletteUtilityPattern = /\b(?:bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|fill|stroke|placeholder|divide(?:-[xy])?|from|via|to|accent|outline|decoration|shadow|caret)-(?:bronze|gold|brown|orange|tomato|red|ruby|crimson|pink|plum|purple|violet|iris|indigo|blue|cyan|teal|jade|green|emerald|grass|gray|mauve|slate|sage|olive|sand|sky|mint|lime|yellow|amber)-a?(?:[1-9]|1[0-2])(?:\/\d+)?(?![\w-])/g;
const radixPaletteVariablePattern = /var\(\s*--(?:bronze|gold|brown|orange|tomato|red|ruby|crimson|pink|plum|purple|violet|iris|indigo|blue|cyan|teal|jade|green|emerald|grass|gray|mauve|slate|sage|olive|sand|sky|mint|lime|yellow|amber)-a?(?:[1-9]|1[0-2])\s*\)/i;
const allowedTailwindColorKeys = new Set(["dls", "white", "black"]);
export const requiredThemeColorTokens = [
  "--dls-surface",
  "--dls-surface-solid",
  "--dls-overlay",
  "--dls-app-bg",
  "--dls-border",
  "--dls-accent",
  "--dls-text-primary",
  "--dls-text-secondary",
  "--dls-hover",
  "--dls-active",
  "--dls-link",
  "--dls-link-hover",
  "--dls-secondary-accent-text",
];
const excludedTestFilePattern = /\.(?:test|vitest)\.tsx?$/;
const generatedSourcePathPattern = /(?:^|\/)(?:generated|__generated__|dist)(?:\/|$)|(?:^|\/)[^/]+\.generated\.tsx?$/;
const numericCssLength = String.raw`(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|ch|ex|cap|ic|lh|rlh|vw|vh|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh|vi|vb|svi|svb|lvi|lvb|dvi|dvb|cqw|cqh|cqi|cqb|cqmin|cqmax|pt|pc|in|cm|mm|q|%)`;
const numericTypographyAndRadiusPattern = new RegExp(
  String.raw`\b(?:text-\[(?:length:)?${numericCssLength}(?:\/[^\]]+)?\]|rounded(?:-(?:tl|tr|br|bl|ss|se|ee|es|t|r|b|l|s|e))?-\[(?:0(?:\.0+)?|${numericCssLength})\])`,
  "g",
);
const cssWideKeywordPattern = /^(?:inherit|initial|unset|revert|revert-layer)$/;
const cornerRadiusPropertyPattern = /^(?:-webkit-)?border-(?:(?:top|bottom)-(?:left|right)|(?:start|end)-(?:start|end))-radius$/;

export function isExcludedSourcePath(filePath) {
  const normalizedPath = filePath.replace(/\\/g, "/");
  return excludedTestFilePattern.test(normalizedPath) || generatedSourcePathPattern.test(normalizedPath);
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split(/\r?\n/).length;
}

function sourceScriptKind(filePath) {
  return filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function isExported(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function collectStaticStrings(node, values) {
  if (!node) return;
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    values.push(node.text);
  } else if (ts.isTemplateExpression(node)) {
    values.push(node.head.text);
    for (const span of node.templateSpans) {
      collectStaticStrings(span.expression, values);
      collectStaticStrings(span.literal, values);
    }
  } else if (ts.isConditionalExpression(node)) {
    collectStaticStrings(node.whenTrue, values);
    collectStaticStrings(node.whenFalse, values);
  } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    collectStaticStrings(node.expression, values);
  } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    collectStaticStrings(node.left, values);
    collectStaticStrings(node.right, values);
  } else if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) collectStaticStrings(element, values);
  } else if (ts.isCallExpression(node)) {
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "join" &&
        node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === " ") {
      collectStaticStrings(node.expression.expression, values);
    } else if (ts.isIdentifier(node.expression) && (node.expression.text === "clsx" || node.expression.text === "cn")) {
      for (const argument of node.arguments) collectStaticStrings(argument, values);
    }
  } else if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) collectStaticStrings(property.initializer, values);
      else if (ts.isSpreadAssignment(property)) collectStaticStrings(property.expression, values);
    }
  }
}

function collectFunctionReturnStrings(fn) {
  const values = [];
  const body = fn.body;
  if (!body) return values;
  if (!ts.isBlock(body)) {
    collectStaticStrings(body, values);
    return values;
  }

  function visit(node) {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      collectStaticStrings(node.expression, values);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(body);
  return values;
}

export function createClassHelperIndex(sourceFiles) {
  const files = new Map(sourceFiles.map(({ source, filePath }) => [
    filePath.replace(/\\/g, "/"),
    { source, filePath: filePath.replace(/\\/g, "/") },
  ]));
  const modules = new Map();

  for (const { source, filePath } of files.values()) {
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      sourceScriptKind(filePath),
    );
    const helpers = new Map();
    const exportedHelpers = new Set();

    function recordHelper(name, values, exported) {
      if (!values.length) return;
      helpers.set(name, [...new Set([...(helpers.get(name) ?? []), ...values])]);
      if (exported) exportedHelpers.add(name);
    }

    function visit(node) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const isModuleExport = node.parent === sourceFile && isExported(node);
        recordHelper(node.name.text, collectFunctionReturnStrings(node), isModuleExport);
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const initializer = node.initializer;
        const helperFunction = ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)
          ? initializer
          : ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) &&
              initializer.expression.text === "createMemo" && initializer.arguments[0] &&
              (ts.isArrowFunction(initializer.arguments[0]) || ts.isFunctionExpression(initializer.arguments[0]))
            ? initializer.arguments[0]
            : undefined;
        if (helperFunction) {
          const statement = node.parent.parent;
          const isModuleExport = statement.parent === sourceFile && ts.isVariableStatement(statement) && isExported(statement);
          recordHelper(node.name.text, collectFunctionReturnStrings(helperFunction), isModuleExport);
        }

        const staticValues = [];
        collectStaticStrings(initializer, staticValues);
        if (staticValues.length) {
          const statement = node.parent.parent;
          const isModuleExport = statement.parent === sourceFile && ts.isVariableStatement(statement) && isExported(statement);
          recordHelper(node.name.text, staticValues, isModuleExport);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    modules.set(filePath, { helpers, exportedHelpers });
  }

  return { files, modules };
}

function resolveRelativeModule(importerPath, moduleSpecifier, files) {
  const sourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts"];

  const candidatesFor = (modulePath) => {
    const normalized = path.posix.normalize(modulePath);
    return Array.from(new Set([
      normalized,
      ...sourceExtensions.map((extension) => `${normalized}${extension}`),
      ...sourceExtensions.map((extension) => `${normalized}/index${extension}`),
    ]));
  };

  const preferredBases = [];
  if (moduleSpecifier.startsWith("~/")) {
    preferredBases.push(moduleSpecifier.slice(2), `src/${moduleSpecifier.slice(2)}`);
  } else if (moduleSpecifier.startsWith(".")) {
    preferredBases.push(path.posix.join(path.posix.dirname(importerPath), moduleSpecifier));
  } else {
    return undefined;
  }

  for (const base of preferredBases) {
    for (const candidate of candidatesFor(base)) {
      if (files.has(candidate)) return candidate;
    }
  }
  return undefined;
}

function importedClassHelpers(sourceFile, relativePath, index) {
  const localModule = index.modules.get(relativePath);
  const helpers = new Map(localModule?.helpers ?? []);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.importClause.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;

    const targetPath = resolveRelativeModule(relativePath, statement.moduleSpecifier.text, index.files);
    if (!targetPath) continue;
    const targetModule = index.modules.get(targetPath);
    if (!targetModule) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (!targetModule.exportedHelpers.has(importedName)) continue;
      const values = targetModule.helpers.get(importedName);
      if (values) helpers.set(element.name.text, values);
    }
  }
  return helpers;
}

export function collectClassStringSegments(source, filePath, classHelperIndex) {
  const relativePath = filePath.replace(/\\/g, "/");
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, sourceScriptKind(relativePath));
  const helperIndex = classHelperIndex ?? createClassHelperIndex([{ source, filePath: relativePath }]);
  const classHelpers = importedClassHelpers(sourceFile, relativePath, helperIndex);
  const segments = [];
  const visitedExpressions = new Set();
  const visitedObjects = new Set();
  const visitedValueObjects = new Set();

  function resolveDeclaration(identifier) {
    for (let scope = identifier.parent; scope; scope = scope.parent) {
      if (ts.isFunctionLike(scope) && scope.parameters.some(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text,
      )) return undefined;
      if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
      const statements = scope.statements ?? [];
      for (let index = statements.length - 1; index >= 0; index -= 1) {
        const statement = statements[index];
        if (!ts.isVariableStatement(statement) || statement.getStart(sourceFile) >= identifier.getStart(sourceFile)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === identifier.text) {
            return declaration.initializer;
          }
        }
      }
    }
    return undefined;
  }

  function addSegment(value, node, relativeOffset = 0) {
    segments.push({ value, offset: node.getStart(sourceFile) + relativeOffset });
  }

  function staticPropertyName(name) {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
      return name.text;
    }
    if (ts.isComputedPropertyName(name) &&
        (ts.isStringLiteral(name.expression) || ts.isNoSubstitutionTemplateLiteral(name.expression))) {
      return name.expression.text;
    }
    return undefined;
  }

  function collectObjectKeys(node) {
    if (!node || visitedObjects.has(node)) return;
    visitedObjects.add(node);

    if (ts.isIdentifier(node)) {
      collectObjectKeys(resolveDeclaration(node));
      return;
    }
    if (!ts.isObjectLiteralExpression(node)) return;

    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        const name = staticPropertyName(property.name);
        if (name !== undefined) addSegment(name, property.name);
      } else if (ts.isSpreadAssignment(property)) {
        collectObjectKeys(property.expression);
      }
    }
  }

  function collectObjectValues(node) {
    if (!node || visitedValueObjects.has(node)) return;
    visitedValueObjects.add(node);

    if (ts.isIdentifier(node)) {
      collectObjectValues(resolveDeclaration(node));
      return;
    }
    if (!ts.isObjectLiteralExpression(node)) return;

    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        collectExpression(property.initializer);
      } else if (ts.isSpreadAssignment(property)) {
        collectObjectValues(property.expression);
      }
    }
  }

  function collectHtmlClassLiteral(literal, state) {
    const value = literal.text;
    let cursor = 0;
    while (cursor < value.length) {
      if (state.quote) {
        const closingQuote = value.indexOf(state.quote, cursor);
        const end = closingQuote === -1 ? value.length : closingQuote;
        if (end > cursor) addSegment(value.slice(cursor, end), literal, cursor + 1);
        if (closingQuote === -1) return;
        state.quote = undefined;
        cursor = closingQuote + 1;
        continue;
      }

      const classAttributePattern = /<[a-z][\w:-]*\b[^>]*?\sclass\s*=\s*(["'])/gi;
      classAttributePattern.lastIndex = cursor;
      const match = classAttributePattern.exec(value);
      if (!match) return;
      state.quote = match[1];
      cursor = classAttributePattern.lastIndex;
    }
  }

  function collectHtmlClassTemplate(node) {
    const state = { quote: undefined };
    collectHtmlClassLiteral(node.head, state);
    for (const span of node.templateSpans) {
      if (state.quote) collectExpression(span.expression);
      collectHtmlClassLiteral(span.literal, state);
    }
  }

  function collectExpression(node) {
    if (!node || visitedExpressions.has(node)) return;
    visitedExpressions.add(node);

    if (ts.isIdentifier(node)) {
      const localDeclaration = resolveDeclaration(node);
      if (localDeclaration) {
        collectExpression(localDeclaration);
        return;
      }
      if (classHelpers.has(node.text)) {
        for (const value of classHelpers.get(node.text)) addSegment(value, node);
        return;
      }
    } else if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      addSegment(node.text, node);
    } else if (ts.isTemplateExpression(node)) {
      addSegment(node.head.text, node.head);
      for (const span of node.templateSpans) {
        collectExpression(span.expression);
        addSegment(span.literal.text, span.literal);
      }
    } else if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) &&
          (node.expression.text === "cn" || node.expression.text === "clsx")) {
        for (const argument of node.arguments) collectExpression(argument);
      } else if (ts.isIdentifier(node.expression) && classHelpers.has(node.expression.text)) {
        for (const value of classHelpers.get(node.expression.text)) addSegment(value, node);
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (method === "trim" && node.arguments.length === 0) {
          collectExpression(node.expression.expression);
        } else if (method === "join" && node.arguments.length === 1 &&
            ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === " ") {
          collectExpression(node.expression.expression);
        }
      }
    } else if (ts.isObjectLiteralExpression(node)) {
      collectObjectKeys(node);
    } else if (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) {
      collectObjectValues(node.expression);
    } else if (ts.isConditionalExpression(node)) {
      collectExpression(node.whenTrue);
      collectExpression(node.whenFalse);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      collectExpression(node.left);
      collectExpression(node.right);
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) collectExpression(element);
    } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      collectExpression(node.expression);
    }
  }

  function visit(node) {
    if (ts.isJsxAttribute(node)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : "";
      if (name === "classList") {
        if (node.initializer && ts.isJsxExpression(node.initializer)) {
          collectObjectKeys(node.initializer.expression);
        }
      } else if (name === "class" || name === "className" || /class$/i.test(name)) {
        if (node.initializer && ts.isJsxExpression(node.initializer)) {
          collectExpression(node.initializer.expression);
        } else if (node.initializer && ts.isStringLiteral(node.initializer)) {
          addSegment(node.initializer.text, node.initializer);
        }
      }
    } else if (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.name.text === "className") {
      collectExpression(node.right);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      collectHtmlClassLiteral(node, { quote: undefined });
    } else if (ts.isTemplateExpression(node)) {
      collectHtmlClassTemplate(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return segments;
}

function inspectLiteralColors(source, relativePath, violations, stringSegments) {
  function inspect(value, offset) {
    for (const colorMatch of value.matchAll(literalColorPattern)) {
      const color = colorMatch[0];
      if (/var\(/i.test(color)) continue;
      violations.push(`${relativePath}:${lineNumber(source, offset + colorMatch.index)}: hard-coded color ${color}`);
    }
  }

  for (const { value, offset } of stringSegments) {
    for (const match of value.matchAll(arbitraryColorUtilityPattern)) {
      inspect(match[0], offset + match.index);
    }
  }
  for (const match of source.matchAll(inlineStylePattern)) {
    const value = match[1] ?? match[3] ?? "";
    inspect(value, match.index + match[0].indexOf(value));
  }
}

function inspectNumericTypographyAndRadius(source, relativePath, violations, classSegments) {
  const scriptKind = relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const inspectedStyleObjects = new Set();

  function isRenderedStyleObject(object) {
    const parent = object.parent;
    if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) {
      return parent.parent.name.getText(sourceFile) === "style";
    }
    if (ts.isVariableDeclaration(parent)) {
      return parent.type?.getText(sourceFile) === "JSX.CSSProperties";
    }
    const arrow = ts.isArrowFunction(parent) ? parent
      : ts.isReturnStatement(parent) && ts.isBlock(parent.parent) && ts.isArrowFunction(parent.parent.parent)
        ? parent.parent.parent
        : undefined;
    return arrow?.type?.getText(sourceFile) === "JSX.CSSProperties";
  }

  function inspectText(value, offset) {
    for (const match of value.matchAll(numericTypographyAndRadiusPattern)) {
      violations.push(`${relativePath}:${lineNumber(source, offset + match.index)}: arbitrary numeric typography/radius utility ${match[0]}; use a semantic text/radius token`);
    }
  }

  for (const { value, offset } of classSegments) {
    inspectText(value, offset);
  }

  function inspectStyleObject(object) {
    if (inspectedStyleObjects.has(object)) return;
    inspectedStyleObjects.add(object);
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const name = propertyName(property.name);
      if (!name) continue;

      const cssProperty = name.includes("-")
        ? name.toLowerCase()
        : name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).toLowerCase();
      const isFontSize = cssProperty === "font-size";
      const isRadius = cssProperty === "border-radius" || cssProperty === "-webkit-border-radius" ||
        cornerRadiusPropertyPattern.test(cssProperty);
      const initializer = property.initializer;
      const value = ts.isStringLiteralLike(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)
        ? initializer.text
        : ts.isNumericLiteral(initializer)
          ? initializer.text
          : undefined;
      const radixVariable = value === undefined ? undefined : findRadixPaletteVariable(value);
      if (radixVariable) {
        violations.push(`${relativePath}:${lineNumber(source, initializer.getStart(sourceFile))}: direct Radix palette variable ${radixVariable}; use a DLS color token`);
      }

      if (!isFontSize && !isRadius) continue;
      const allowed = value !== undefined && (
        cssWideKeywordPattern.test(value) || value === "0" ||
        (isFontSize
          ? isSemanticVariableValue(value, "--text-", true)
          : isSemanticRadiusValue(value))
      );
      if (!allowed) {
        const tokenFamily = isFontSize ? "--text-*" : "--radius-*";
        violations.push(`${relativePath}:${lineNumber(source, property.name.getStart(sourceFile))}: inline style ${name} must use var(${tokenFamily}) or 0`);
      }
    }
  }

  function inspectReferencedStyle(attribute) {
    if (attribute.name.getText(sourceFile) !== "style" ||
        !attribute.initializer ||
        !ts.isJsxExpression(attribute.initializer) ||
        !attribute.initializer.expression ||
        !ts.isIdentifier(attribute.initializer.expression)) return;

    const name = attribute.initializer.expression.text;
    for (let scope = attribute.parent; scope; scope = scope.parent) {
      if ((ts.isArrowFunction(scope) || ts.isFunctionDeclaration(scope) ||
           ts.isFunctionExpression(scope) || ts.isMethodDeclaration(scope)) &&
          scope.parameters.some((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name)) return;
      if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement) || statement.getStart(sourceFile) >= attribute.getStart(sourceFile) ||
            !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name &&
              declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer)) {
            inspectStyleObject(declaration.initializer);
            return;
          }
        }
      }
    }
  }

  function visit(node) {
    if (ts.isObjectLiteralExpression(node) && isRenderedStyleObject(node)) {
      inspectStyleObject(node);
    } else if (ts.isJsxAttribute(node)) {
      if (node.name.getText(sourceFile) === "style" && node.initializer &&
          ts.isStringLiteral(node.initializer)) {
        const radixVariable = findRadixPaletteVariable(node.initializer.text);
        if (radixVariable) {
          violations.push(`${relativePath}:${lineNumber(source, node.initializer.getStart(sourceFile))}: direct Radix palette variable ${radixVariable}; use a DLS color token`);
        }
      } else {
        inspectReferencedStyle(node);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

export function inspectSource(source, filePath, classHelperIndex) {
  const violations = [];
  const relativePath = filePath.replace(/\\/g, "/");
  if (isExcludedSourcePath(relativePath)) return violations;
  const classSegments = collectClassStringSegments(source, relativePath, classHelperIndex);

  inspectNumericTypographyAndRadius(source, relativePath, violations, classSegments);

  if (/\.tsx?$/.test(relativePath)) {
    const typographyAndRadiusPattern = /\b(?:rounded(?:-(?:tl|tr|br|bl|ss|se|ee|es|t|r|b|l|s|e))?-(?:none|sm|md|lg|xl|2xl|3xl)|rounded(?:-(?:tl|tr|br|bl|ss|se|ee|es|t|r|b|l|s|e))?|text-(?:xs|sm|base|lg|xl|2xl|3xl))(?![\w-])/g;
    for (const { value, offset } of classSegments) {
      for (const match of value.matchAll(typographyAndRadiusPattern)) {
        violations.push(`${relativePath}:${lineNumber(source, offset + match.index)}: ${match[0]}`);
      }
    }
  }

  for (const { value, offset } of classSegments) {
    const radixVariable = findRadixPaletteVariable(value);
    if (radixVariable) {
      const variableOffset = value.toLowerCase().indexOf(radixVariable.toLowerCase());
      violations.push(`${relativePath}:${lineNumber(source, offset + variableOffset)}: direct Radix palette variable ${radixVariable}; use a DLS color token`);
    }

    for (const match of value.matchAll(unsupportedTailwindColorScalePattern)) {
      violations.push(`${relativePath}:${lineNumber(source, offset + match.index)}: unsupported Tailwind color scale ${match[0]}`);
    }

    for (const match of value.matchAll(radixPaletteUtilityPattern)) {
      violations.push(`${relativePath}:${lineNumber(source, offset + match.index)}: direct Radix palette utility ${match[0]}; use a semantic DLS color role`);
    }
  }

  inspectLiteralColors(source, relativePath, violations, classSegments);
  return violations;
}

function propertyName(property) {
  if (ts.isIdentifier(property) || ts.isStringLiteral(property)) return property.text;
  return undefined;
}

function findObjectProperty(object, name) {
  return object.properties.find(
    (property) => ts.isPropertyAssignment(property) && propertyName(property.name) === name,
  );
}

function parseTailwindConfig(source) {
  const sourceFile = ts.createSourceFile(
    "tailwind.config.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const defaultExport = sourceFile.statements.find(
    (statement) => ts.isExportAssignment(statement) && !statement.isExportEquals,
  );
  const config = defaultExport && ts.isObjectLiteralExpression(defaultExport.expression)
    ? defaultExport.expression
    : undefined;
  const themeProperty = config && findObjectProperty(config, "theme");
  const theme = themeProperty && ts.isObjectLiteralExpression(themeProperty.initializer)
    ? themeProperty.initializer
    : undefined;
  const colorsProperty = theme && findObjectProperty(theme, "colors");
  const colors = colorsProperty && ts.isObjectLiteralExpression(colorsProperty.initializer)
    ? colorsProperty.initializer
    : undefined;
  return { sourceFile, config, colors };
}

export function extractTailwindColorTheme(source) {
  const { colors } = parseTailwindConfig(source);
  if (!colors) return "";

  const declarations = [];
  for (const entry of colors.properties) {
    if (!ts.isPropertyAssignment(entry)) continue;
    const name = propertyName(entry.name);
    if (!name || !allowedTailwindColorKeys.has(name)) continue;

    if (name === "dls" && ts.isObjectLiteralExpression(entry.initializer)) {
      for (const role of entry.initializer.properties) {
        if (!ts.isPropertyAssignment(role)) continue;
        const roleName = propertyName(role.name);
        if (roleName && ts.isStringLiteral(role.initializer)) {
          declarations.push(`--color-dls-${roleName}: ${role.initializer.text};`);
        }
      }
    } else if (ts.isStringLiteral(entry.initializer)) {
      declarations.push(`--color-${name}: ${entry.initializer.text};`);
    }
  }

  return declarations.join("\n");
}

export function inspectTailwindConfig(source) {
  const violations = [];
  const { sourceFile, config, colors } = parseTailwindConfig(source);

  if (!colors) {
    return ["theme.colors must be a static object containing only DLS semantic color roles"];
  }

  for (const entry of colors.properties) {
    const line = lineNumber(source, entry.getStart(sourceFile));
    if (ts.isSpreadAssignment(entry)) {
      violations.push(`${line}: theme.colors must not spread an unreviewed palette`);
      continue;
    }

    const name = ts.isPropertyAssignment(entry) ? propertyName(entry.name) : undefined;
    if (!name || !allowedTailwindColorKeys.has(name)) {
      violations.push(`${line}: theme.colors exposes non-semantic utility key ${name ?? "<computed>"}`);
      continue;
    }

    const initializer = ts.isPropertyAssignment(entry) ? entry.initializer : undefined;
    if (name === "dls") {
      if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
        violations.push(`${line}: theme.colors.dls must map semantic DLS roles`);
        continue;
      }
      for (const role of initializer.properties) {
        const roleLine = lineNumber(source, role.getStart(sourceFile));
        const roleValue = ts.isPropertyAssignment(role) ? role.initializer : undefined;
        if (!roleValue || !ts.isStringLiteral(roleValue) || !/^var\(--dls-[\w-]+\)$/.test(roleValue.text)) {
          violations.push(`${roleLine}: DLS color utilities must map to --dls-* tokens`);
        }
      }
    } else if (!initializer || !ts.isStringLiteral(initializer) || initializer.text !== `var(--dls-${name})`) {
      violations.push(`${line}: ${name} utility must map to var(--dls-${name})`);
    }
  }

  const safelistProperty = config && findObjectProperty(config, "safelist");
  if (safelistProperty) {
    violations.push(`${lineNumber(source, safelistProperty.getStart(sourceFile))}: Tailwind v4 ignores config safelist; use @source inline() in CSS`);
  }

  return violations;
}

function isSemanticVariableValue(value, tokenPrefix, allowCustomFallback = false) {
  const tokenValue = `var\\(\\s*${tokenPrefix}[\\w-]+\\s*\\)`;
  if (new RegExp(`^${tokenValue}$`).test(value)) return true;
  if (!allowCustomFallback) return false;

  return new RegExp(
    `^var\\(\\s*--[\\w-]+\\s*,\\s*${tokenValue}\\s*\\)$`,
  ).test(value);
}

function isSemanticRadiusValue(value) {
  const radiusLength = String.raw`(?:0|var\(\s*--radius-[\w-]+\s*\))`;
  const radiusGroup = `${radiusLength}(?:\\s+${radiusLength}){0,3}`;
  return new RegExp(`^${radiusGroup}(?:\\s*\\/\\s*${radiusGroup})?$`).test(value);
}

function findLiteralColor(value) {
  const pattern = new RegExp(literalColorPattern.source, "gi");
  for (const match of value.matchAll(pattern)) {
    if (!/var\(/i.test(match[0])) return match[0];
  }
  return undefined;
}

function findRadixPaletteVariable(value) {
  return value.match(radixPaletteVariablePattern)?.[0];
}

export function inspectCss(source, filePath) {
  const violations = [];
  const relativePath = filePath.split(path.sep).join("/");
  if (isExcludedSourcePath(relativePath)) return violations;

  let stylesheet;
  try {
    stylesheet = postcss.parse(source, { from: relativePath });
  } catch (error) {
    const line = error.line ?? 1;
    violations.push(`${relativePath}:${line}: invalid CSS: ${error.reason ?? error.message}`);
    return violations;
  }

  stylesheet.walkDecls((declaration) => {
    const property = declaration.prop.toLowerCase();
    const isDlsToken = relativePath === "app/index.css" && property.startsWith("--dls-");
    const isRadixPrimitiveSheet = relativePath === "styles/colors.css";
    if (!isDlsToken && !isRadixPrimitiveSheet) {
      const radixVariable = findRadixPaletteVariable(declaration.value);
      if (radixVariable) {
        violations.push(
          `${relativePath}:${declaration.source?.start?.line ?? 1}: direct Radix CSS color variable ${radixVariable}; use a DLS color token`,
        );
      }

      const literalColor = findLiteralColor(declaration.value);
      if (literalColor) {
        violations.push(
          `${relativePath}:${declaration.source?.start?.line ?? 1}: literal CSS color ${literalColor}; use a DLS color token`,
        );
      }
    }

    const isFontSize = property === "font-size";
    const isRadius = property === "border-radius" || property === "-webkit-border-radius" ||
      cornerRadiusPropertyPattern.test(property);
    if (!isFontSize && !isRadius) return;

    const value = declaration.value.trim();
    const allowed = cssWideKeywordPattern.test(value) || value === "0" ||
      (isFontSize
        ? isSemanticVariableValue(value, "--text-", true)
        : isSemanticRadiusValue(value));
    if (!allowed) {
      const tokenFamily = isFontSize ? "--text-*" : "--radius-*";
      violations.push(
        `${relativePath}:${declaration.source?.start?.line ?? 1}: unapproved CSS declaration ${property}: ${value}; use var(${tokenFamily}) or 0`,
      );
    }
  });

  return violations;
}

function extractThemeBlock(source, selector) {
  return source.match(new RegExp(`${selector}\\s*\\{([^{}]*)\\}`))?.[1] ?? "";
}

function hasNonEmptyTokenValue(block, token) {
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`(?:^|;)\\s*${escapedToken}\\s*:\\s*([^;]*\\S[^;]*)`, "m");
  return declaration.test(block);
}

export function inspectThemeTokens(tokenCss) {
  const violations = [];
  const lightTheme = extractThemeBlock(tokenCss, ":root");
  const darkTheme = extractThemeBlock(tokenCss, String.raw`\[data-theme=["']dark["']\]`);

  if (!/--text-[\w-]+\s*:/.test(tokenCss)) {
    violations.push("missing semantic typography tokens");
  }
  if (!/--radius-[\w-]+\s*:/.test(tokenCss)) {
    violations.push("missing semantic radius tokens");
  }
  if (!/--dls-[\w-]+\s*:/.test(tokenCss)) {
    violations.push("missing semantic DLS tokens");
  }

  for (const [themeName, block] of [[":root", lightTheme], ['[data-theme="dark"]', darkTheme]]) {
    if (!block) {
      violations.push(`${themeName}: missing theme token block`);
      continue;
    }
    for (const token of requiredThemeColorTokens) {
      if (!hasNonEmptyTokenValue(block, token)) {
        violations.push(`${themeName}: missing value for ${token}`);
      }
    }
  }

  return violations;
}