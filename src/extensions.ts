import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { CheckpointMetadata, GeneratedInsightRecord } from "./types.js";

export interface RegisteredExtension {
  id: string;
  enabled: boolean;
  command: string;
  description?: string;
}

export interface ExtensionsConfig {
  extensions: RegisteredExtension[];
}

export interface ExtensionCheckpointPayload {
  version: 1;
  repositoryRoot: string;
  checkpoint: CheckpointMetadata;
}

export interface ExtensionInsightOutput {
  type: string;
  title: string;
  body: string;
  files?: string[];
}

export interface ExtensionRunnerOutput {
  insights?: ExtensionInsightOutput[];
}

export interface EnsureExtensionsTemplateResult {
  filePath: string;
  created: boolean;
}

const EXTENSIONS_FILE_NAME = "extensions.yaml";
const GENERATED_INSIGHTS_FILE_NAME = "generated-insights.jsonl";
const PENDING_EXTENSION_EVENTS_FILE_NAME = "pending-extension-events.jsonl";

export function extensionsConfigPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", EXTENSIONS_FILE_NAME);
}

export function generatedInsightsPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", GENERATED_INSIGHTS_FILE_NAME);
}

export function pendingExtensionEventsPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", PENDING_EXTENSION_EVENTS_FILE_NAME);
}

export async function ensureExtensionsTemplate(
  repositoryRoot: string
): Promise<EnsureExtensionsTemplateResult> {
  const filePath = extensionsConfigPath(repositoryRoot);
  if (existsSync(filePath)) {
    return { filePath, created: false };
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  const content = `# Repo-local Anvil extension apps
# Extensions run after checkpoints are already recorded.
extensions:
  reviewHints:
    enabled: false
    command: node .anvil/apps/review-hints.mjs
    description: "Generate structured checkpoint review hints"
`;
  await writeFile(filePath, content, "utf8");
  return { filePath, created: true };
}

function parseBoolean(value: string): boolean | null {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

export async function loadExtensionsConfig(repositoryRoot: string): Promise<ExtensionsConfig> {
  const filePath = extensionsConfigPath(repositoryRoot);
  if (!existsSync(filePath)) {
    return { extensions: [] };
  }

  const content = await readFile(filePath, "utf8");
  const extensions: RegisteredExtension[] = [];
  let inExtensions = false;
  let current: RegisteredExtension | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (!line.startsWith(" ")) {
      inExtensions = trimmed === "extensions:";
      current = null;
      continue;
    }

    if (!inExtensions) {
      continue;
    }

    if (line.startsWith("  ") && !line.startsWith("    ")) {
      const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
      if (!match) {
        current = null;
        continue;
      }

      current = {
        id: match[1],
        enabled: false,
        command: ""
      };
      extensions.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.+)?$/);
    if (!pair) {
      continue;
    }

    const [, key, rawValue = ""] = pair;
    const value = rawValue.trim().replace(/^['"]|['"]$/g, "");
    switch (key) {
      case "enabled": {
        const parsed = parseBoolean(value);
        current.enabled = parsed ?? current.enabled;
        break;
      }
      case "command":
        current.command = value;
        break;
      case "description":
        current.description = value;
        break;
    }
  }

  return {
    extensions: extensions.filter((extension) => extension.command.trim().length > 0)
  };
}

export async function appendPendingExtensionEvent(
  repositoryRoot: string,
  checkpointId: string
): Promise<void> {
  const filePath = pendingExtensionEventsPath(repositoryRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify({
    checkpointId,
    queuedAt: new Date().toISOString()
  });
  const prefix = existsSync(filePath) ? "\n" : "";
  await writeFile(
    filePath,
    existsSync(filePath) ? `${(await readFile(filePath, "utf8")).trimEnd()}${prefix}${line}\n` : `${line}\n`,
    "utf8"
  );
}

export async function consumePendingExtensionEvents(repositoryRoot: string): Promise<string[]> {
  const filePath = pendingExtensionEventsPath(repositoryRoot);
  if (!existsSync(filePath)) {
    return [];
  }

  const content = await readFile(filePath, "utf8");
  await writeFile(filePath, "", "utf8");

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as { checkpointId?: string };
        return parsed.checkpointId ?? null;
      } catch {
        return null;
      }
    })
    .filter((value): value is string => Boolean(value));
}

export async function appendGeneratedInsights(
  repositoryRoot: string,
  insights: GeneratedInsightRecord[]
): Promise<void> {
  if (insights.length === 0) {
    return;
  }

  const filePath = generatedInsightsPath(repositoryRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = existsSync(filePath) ? await readFile(filePath, "utf8") : "";
  const lines = insights.map((item) => JSON.stringify(item)).join("\n");
  const prefix = existing.trim().length > 0 ? "\n" : "";
  await writeFile(filePath, `${existing.trimEnd()}${prefix}${lines}\n`, "utf8");
}

export async function readGeneratedInsights(
  repositoryRoot: string,
  checkpointId?: string
): Promise<GeneratedInsightRecord[]> {
  const filePath = generatedInsightsPath(repositoryRoot);
  if (!existsSync(filePath)) {
    return [];
  }

  const content = await readFile(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GeneratedInsightRecord)
    .filter((item) => !checkpointId || item.checkpointId === checkpointId);
}
