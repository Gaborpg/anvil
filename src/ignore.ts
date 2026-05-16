import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const EXACT_IGNORED_PATHS = new Set([
  ".anvilignore",
  ".github/hooks/anvil-copilot.json",
  ".codex/hooks.json",
  ".codex/anvil-codex-after-edit.mjs",
  ".anvil/policy.yaml",
  ".anvil/extensions.yaml",
  ".anvil/anvil-execution-guard.mjs",
  ".anvil/anvil-codex-prompt-submit.mjs",
  ".anvil/anvil-copilot-prompt-submit.mjs",
  ".anvil/hook-wrapper-errors.log"
]);

const IGNORED_BASENAMES = new Set([
  "anvil-server.err.log",
  "anvil-server.out.log",
  "anvil-restore-smoke.txt"
]);

const ANVIL_IGNORE_FILE = ".anvilignore";

export interface AnvilIgnorePattern {
  raw: string;
  pattern: string;
  negated: boolean;
}

export interface AnvilIgnoreRules {
  repositoryRoot: string;
  patterns: AnvilIgnorePattern[];
}

export interface EnsureAnvilIgnoreResult {
  filePath: string;
  created: boolean;
  source: "existing" | "gitignore" | "starter";
}

function escapeRegex(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  let regex = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index];
    const next = pattern[index + 1];

    if (current === "*") {
      if (next === "*") {
        regex += ".*";
        index += 1;
      } else {
        regex += "[^/]*";
      }
      continue;
    }

    if (current === "?") {
      regex += "[^/]";
      continue;
    }

    if (current === "[") {
      const closingIndex = pattern.indexOf("]", index + 1);
      if (closingIndex !== -1) {
        const classBody = pattern.slice(index + 1, closingIndex);
        if (classBody.length > 0) {
          const negated = classBody.startsWith("!");
          const normalizedBody = (negated ? "^" : "") + classBody.slice(negated ? 1 : 0);
          regex += `[${normalizedBody}]`;
          index = closingIndex;
          continue;
        }
      }
    }

    regex += escapeRegex(current);
  }

  regex += "$";
  return new RegExp(regex);
}

function parsePattern(line: string): AnvilIgnorePattern | null {
  if (!line || line.startsWith("#")) {
    return null;
  }

  if (line.startsWith("\\!")) {
    return {
      raw: line,
      pattern: line.slice(1),
      negated: false
    };
  }

  if (line.startsWith("!")) {
    const pattern = line.slice(1).trim();
    if (!pattern) {
      return null;
    }

    return {
      raw: line,
      pattern,
      negated: true
    };
  }

  return {
    raw: line,
    pattern: line,
    negated: false
  };
}

export function normalizePath(filePath: string): string {
  return filePath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizePattern(pattern: string): string {
  return normalizePath(pattern).replace(/^\/+/, "");
}

function matchesIgnorePattern(filePath: string, rule: AnvilIgnorePattern): boolean {
  const normalizedPath = normalizePath(filePath);
  const normalizedPattern = normalizePattern(rule.pattern);

  if (!normalizedPattern) {
    return false;
  }

  const directoryPattern = normalizedPattern.endsWith("/");
  const patternBody = directoryPattern ? normalizedPattern.slice(0, -1) : normalizedPattern;

  if (!patternBody) {
    return false;
  }

  if (directoryPattern) {
    return (
      normalizedPath === patternBody ||
      normalizedPath.startsWith(`${patternBody}/`)
    );
  }

  if (patternBody.includes("/")) {
    return globToRegex(patternBody).test(normalizedPath);
  }

  const basename = path.posix.basename(normalizedPath);
  return globToRegex(patternBody).test(basename);
}

export async function loadAnvilIgnoreRules(repositoryRoot: string): Promise<AnvilIgnoreRules> {
  const ignorePath = path.join(repositoryRoot, ANVIL_IGNORE_FILE);
  if (!existsSync(ignorePath)) {
    return {
      repositoryRoot,
      patterns: []
    };
  }

  const content = await readFile(ignorePath, "utf8");
  return {
    repositoryRoot,
    patterns: content
      .split(/\r?\n/)
      .map((line) => parsePattern(line.trim()))
      .filter((rule): rule is AnvilIgnorePattern => Boolean(rule))
  };
}

export async function ensureAnvilIgnoreTemplate(repositoryRoot: string): Promise<EnsureAnvilIgnoreResult> {
  const anvilIgnorePath = path.join(repositoryRoot, ANVIL_IGNORE_FILE);
  if (existsSync(anvilIgnorePath)) {
    return {
      filePath: anvilIgnorePath,
      created: false,
      source: "existing"
    };
  }

  const gitIgnorePath = path.join(repositoryRoot, ".gitignore");
  await mkdir(path.dirname(anvilIgnorePath), { recursive: true });

  if (existsSync(gitIgnorePath)) {
    const gitIgnoreContent = await readFile(gitIgnorePath, "utf8");
    await writeFile(anvilIgnorePath, gitIgnoreContent, "utf8");
    return {
      filePath: anvilIgnorePath,
      created: true,
      source: "gitignore"
    };
  }

  const starterContent = `# Anvil-specific ignore rules
# Add files here if you want Anvil to skip them even when Git sees them.
`;
  await writeFile(anvilIgnorePath, starterContent, "utf8");
  return {
    filePath: anvilIgnorePath,
    created: true,
    source: "starter"
  };
}

function isAlwaysIgnoredAnvilPath(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  if (!normalized || normalized.startsWith(".anvil/")) {
    return true;
  }

  if (EXACT_IGNORED_PATHS.has(normalized)) {
    return true;
  }

  const basename = normalized.split("/").at(-1) ?? normalized;
  return IGNORED_BASENAMES.has(basename);
}

export function isIgnoredAnvilPath(filePath: string, rules?: AnvilIgnoreRules): boolean {
  const normalized = normalizePath(filePath);
  if (isAlwaysIgnoredAnvilPath(normalized)) {
    return true;
  }

  let ignored = false;
  for (const rule of rules?.patterns ?? []) {
    if (!matchesIgnorePattern(normalized, rule)) {
      continue;
    }

    ignored = !rule.negated;
  }

  return ignored;
}

export function filterIgnoredAnvilPaths(paths: string[], rules?: AnvilIgnoreRules): string[] {
  return paths
    .map((filePath) => normalizePath(filePath))
    .filter((filePath) => filePath.length > 0 && !isIgnoredAnvilPath(filePath, rules));
}

export function collectIgnoredAnvilPaths(paths: string[], rules?: AnvilIgnoreRules): string[] {
  return [...new Set(
    paths
      .map((filePath) => normalizePath(filePath))
      .filter((filePath) => filePath.length > 0 && isIgnoredAnvilPath(filePath, rules))
  )];
}
