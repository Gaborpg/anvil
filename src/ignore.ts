import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const EXACT_IGNORED_PATHS = new Set([
  ".anvilignore",
  ".github/hooks/anvil-copilot.json",
  ".codex/hooks.json"
]);

const IGNORED_BASENAMES = new Set([
  "anvil-server.err.log",
  "anvil-server.out.log",
  "anvil-restore-smoke.txt"
]);

const ANVIL_IGNORE_FILE = ".anvilignore";

export interface AnvilIgnoreRules {
  repositoryRoot: string;
  patterns: string[];
}

function escapeRegex(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  const regexText = pattern
    .split("*")
    .map((part) => escapeRegex(part))
    .join(".*");

  return new RegExp(`^${regexText}$`);
}

export function normalizePath(filePath: string): string {
  return filePath.trim().replace(/\\/g, "/");
}

function matchesIgnorePattern(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizePath(filePath);
  const normalizedPattern = normalizePath(pattern);

  if (!normalizedPattern) {
    return false;
  }

  if (normalizedPattern.endsWith("/")) {
    return normalizedPath.startsWith(normalizedPattern);
  }

  if (normalizedPattern.includes("/")) {
    return globToRegex(normalizedPattern).test(normalizedPath);
  }

  const basename = path.posix.basename(normalizedPath);
  return globToRegex(normalizedPattern).test(basename);
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
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
  };
}

export function isIgnoredAnvilPath(filePath: string, rules?: AnvilIgnoreRules): boolean {
  const normalized = normalizePath(filePath);
  if (!normalized || normalized.startsWith(".anvil/")) {
    return true;
  }

  if (EXACT_IGNORED_PATHS.has(normalized)) {
    return true;
  }

  const basename = normalized.split("/").at(-1) ?? normalized;
  if (IGNORED_BASENAMES.has(basename)) {
    return true;
  }

  return (rules?.patterns ?? []).some((pattern) => matchesIgnorePattern(normalized, pattern));
}

export function filterIgnoredAnvilPaths(paths: string[], rules?: AnvilIgnoreRules): string[] {
  return paths
    .map((filePath) => normalizePath(filePath))
    .filter((filePath) => filePath.length > 0 && !isIgnoredAnvilPath(filePath, rules));
}
