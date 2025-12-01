import type { Plugin } from "vite";

// --- Types ---

interface Token {
  value: string;
  usageCount: number;
  setElsewhere: boolean;
  mangledName?: string;
  isAlias?: boolean; // value is exactly one var(--x[, fallback]?)
  emitDeclaration?: boolean; // only canonical variable per resolved value emits
}

interface PluginOptions {
  /** Prefix for mangled names (default: "--_") */
  manglePrefix?: string;
  /** Enable verbose logging (default: false) */
  verbose?: boolean;
}

interface LayerSpan {
  start: number;
  end: number;
  content: string;
}

// --- Constants ---

const VAR_REF_REGEX = /var\(\s*(--[\w-]+)(?:\s*,\s*([^)]+))?\s*\)/g;
const VAR_DEF_REGEX = /(--[\w-]+)\s*:\s*([^;{}]+);?/g;
const LAYER_TOKENS_REGEX = /@layer\s+tokens\s*\{/g;

// A "pure alias" is a value that is exactly one var(...) reference (with optional fallback and whitespace)
const VAR_ONLY_REGEX = /^\s*var\(\s*--[\w-]+\s*(?:,\s*[^)]+)?\)\s*$/;

// --- Utility Functions ---

function findMatchingBrace(code: string, start: number): number {
  let depth = 1;
  for (let i = start; i < code.length; i++) {
    if (code[i] == "{") depth++;
    else if (code[i] == "}") depth--;
    if (depth == 0) return i;
  }
  return code.length;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findTokensLayers(code: string): LayerSpan[] {
  const layers: LayerSpan[] = [];
  for (const match of code.matchAll(LAYER_TOKENS_REGEX)) {
    const startIdx = match.index!;
    const contentStart = startIdx + match[0].length;
    const contentEnd = findMatchingBrace(code, contentStart);
    layers.push({
      start: startIdx,
      end: contentEnd + 1,
      content: code.slice(contentStart, contentEnd),
    });
  }
  return layers;
}

// --- Variable Registry Operations (Global) ---

function extractTokensVariables(
  code: string,
  registry: Map<string, Token>,
): void {
  for (const layer of findTokensLayers(code)) {
    for (const match of layer.content.matchAll(VAR_DEF_REGEX)) {
      const [, varName, varValueRaw] = match;
      const varValue = varValueRaw.trim();
      const isAlias = VAR_ONLY_REGEX.test(varValue);
      if (!registry.has(varName)) {
        registry.set(varName, {
          value: varValue,
          usageCount: 0,
          setElsewhere: false,
          isAlias,
          emitDeclaration: false,
        });
      } else {
        const v = registry.get(varName)!;
        // Keep first seen value; mark alias if known
        if (v.isAlias == undefined) v.isAlias = isAlias;
      }
    }
  }
}

function markVariablesSetElsewhere(
  code: string,
  registry: Map<string, Token>,
): void {
  // Blank out tokens layers to check definitions elsewhere
  let codeWithoutTokens = code;
  for (const layer of findTokensLayers(code)) {
    codeWithoutTokens =
      codeWithoutTokens.slice(0, layer.start) +
      " ".repeat(layer.end - layer.start) +
      codeWithoutTokens.slice(layer.end);
  }

  for (const [varName, variable] of registry) {
    const setRegex = new RegExp(`${escapeRegex(varName)}\\s*:`, "g");
    if (setRegex.test(codeWithoutTokens)) {
      variable.setElsewhere = true;
    }
  }
}

function countVariableUsage(
  code: string,
  registry: Map<string, Token>,
  visited: Set<string> = new Set(),
): void {
  for (const match of code.matchAll(VAR_REF_REGEX)) {
    const varName = match[1];
    const variable = registry.get(varName);

    if (variable) {
      variable.usageCount++;

      // Recursively count nested variable references
      if (!visited.has(varName)) {
        visited.add(varName);
        countVariableUsage(variable.value, registry, visited);
      }
    }
  }
}

function resetUsageCounts(registry: Map<string, Token>): void {
  for (const variable of registry.values()) {
    variable.usageCount = 0;
    variable.mangledName = undefined;
    variable.emitDeclaration = false;
  }
}

// --- Value Resolution ---

function resolveVariableValue(
  varName: string,
  registry: Map<string, Token>,
  depth = 0,
): string {
  if (depth > 10) return `var(${varName})`;

  const variable = registry.get(varName);
  if (!variable) return `var(${varName})`;

  return variable.value.replace(VAR_REF_REGEX, (_, nestedVarName) =>
    resolveVariableValue(nestedVarName, registry, depth + 1),
  );
}

// --- Mangling Logic (Global, build-unique IDs) ---

function generateMangledNames(
  registry: Map<string, Token>,
  manglePrefix: string,
): number {
  // Group variables by resolved value
  const valueToVars = new Map<string, string[]>();

  for (const [varName, variable] of registry) {
    if (variable.usageCount == 0) continue;

    const resolvedValue = resolveVariableValue(varName, registry);
    const vars = valueToVars.get(resolvedValue);
    if (vars) {
      vars.push(varName);
    } else {
      valueToVars.set(resolvedValue, [varName]);
    }
  }

  let counter = 0;

  for (const [resolvedValue, varNames] of valueToVars) {
    const canonicalVarName =
      varNames.find((v) => !registry.get(v)!.isAlias) ?? varNames[0];

    // Total usage across the group
    let totalUsage = 0;
    for (const vName of varNames) {
      totalUsage += registry.get(vName)!.usageCount;
    }

    const mangledName = `${manglePrefix}${counter.toString(36)}`;
    const valueLen = resolvedValue.length;

    // Byte cost model
    const declarationCost = mangledName.length + 2 + valueLen + 1; // "--_x: " + value + ";"
    const referenceCost = 5 + mangledName.length + 1; // "var(--_x)"
    const mangleCost = declarationCost + totalUsage * referenceCost;
    const inlineCost = totalUsage * valueLen;

    const shouldMangle = mangleCost < inlineCost;

    if (shouldMangle) {
      counter++;
      for (const vName of varNames) {
        const v = registry.get(vName)!;
        v.mangledName = mangledName;
        v.emitDeclaration = vName == canonicalVarName;
      }
    } else {
      // No mangling → leave for inlining
      for (const vName of varNames) {
        const v = registry.get(vName)!;
        v.mangledName = undefined;
        v.emitDeclaration = false;
      }
    }
  }

  return counter;
}

// --- Code Transformation (per asset, using global registry) ---

function transformCode(code: string, registry: Map<string, Token>): string {
  let result = code;
  const layers = findTokensLayers(code);

  // Per-file deduplication: define each resolved value at most once in this file
  const emittedValues = new Set<string>();

  // Process layers in reverse to preserve indices
  for (const layer of layers.reverse()) {
    const declarations: string[] = [];

    for (const match of layer.content.matchAll(VAR_DEF_REGEX)) {
      const [, varName, varValue] = match;
      const variable = registry.get(varName);

      if (!variable) continue;

      // Drop unused variables entirely
      if (variable.usageCount == 0) continue;

      // Keep external (non-tokens-layer) definitions unchanged
      if (variable.setElsewhere) {
        declarations.push(`${varName}: ${varValue}`);
        continue;
      }

      if (variable.mangledName) {
        const resolvedValue = resolveVariableValue(varName, registry);

        // Emit canonical declaration with flattened value; dedupe per file
        if (variable.emitDeclaration && !variable.isAlias) {
          if (!emittedValues.has(resolvedValue)) {
            declarations.push(`${variable.mangledName}: ${resolvedValue}`);
            emittedValues.add(resolvedValue);
          }
        }
        // Non-canonical or alias variables: do not emit any declaration
      }
      // Variables without mangling will be inlined later, so don't emit
    }

    const newContent =
      declarations.length > 0
        ? `@layer tokens{:root{${declarations.join(";")}}}`
        : "";

    result =
      result.slice(0, layer.start) + newContent + result.slice(layer.end);
  }

  // Replace var() references globally
  result = result.replace(VAR_REF_REGEX, (original, varName, fallback) => {
    const variable = registry.get(varName);
    if (!variable) return original;

    if (variable.mangledName) {
      return `var(${variable.mangledName}${fallback ? `, ${fallback}` : ""})`;
    }

    if (!variable.setElsewhere) {
      return resolveVariableValue(varName, registry);
    }

    return original;
  });

  return result;
}

// --- Analysis Summary ---

function getStats(registry: Map<string, Token>, mangledCount: number): string {
  let drop = 0,
    inline = 0,
    mangle = 0,
    keep = 0;

  for (const variable of registry.values()) {
    if (variable.usageCount == 0) drop++;
    else if (variable.setElsewhere) keep++;
    else if (variable.mangledName) mangle++;
    else inline++;
  }

  return (
    `Analysis: ${drop} drop, ${inline} inline, ` +
    `${mangle} mangle (${mangledCount} unique values), ${keep} keep`
  );
}

// --- Plugin ---

export function tokenShaker(options: PluginOptions = {}): Plugin {
  const { manglePrefix = "--_", verbose = false } = options;
  const registry = new Map<string, Token>();

  const log = verbose
    ? (...args: unknown[]) => console.log("[token-shaker]", ...args)
    : () => {};

  return {
    name: "vite-plugin-token-shaker",
    enforce: "pre",

    generateBundle(_outputOptions, bundle) {
      registry.clear(); // Start fresh with bundle data

      const cssAssets = Object.entries(bundle).filter(
        ([name, asset]) => asset.type == "asset" && name.endsWith(".css"),
      ) as Array<[string, { type: "asset"; source: string }]>;

      if (cssAssets.length == 0) return;

      // Extract from ONLY the bundled CSS
      for (const [, asset] of cssAssets) {
        extractTokensVariables(asset.source, registry);
      }

      if (registry.size == 0) return;

      // Analyze ONCE from bundle
      const bundledFiles = cssAssets.map(
        ([name, asset]) => [name, asset.source] as [string, string],
      );

      log(
        `Analyzing ${registry.size} variables across ${cssAssets.length} CSS files`,
      );

      // Single analysis pass
      resetUsageCounts(registry);
      for (const [, code] of bundledFiles) {
        markVariablesSetElsewhere(code, registry);
        countVariableUsage(code, registry);
      }
      const mangledCount = generateMangledNames(registry, manglePrefix);
      log(getStats(registry, mangledCount));

      // Transform
      for (const [fileName, asset] of cssAssets) {
        const transformed = transformCode(asset.source, registry);
        if (transformed !== asset.source) {
          log(`✓ Transformed ${fileName}`);
          (asset as { source: string }).source = transformed;
        }
      }
    },
  };
}
