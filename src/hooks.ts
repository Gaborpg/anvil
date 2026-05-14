import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { CheckpointKind } from "./types.js";

export interface CopilotHookConfig {
  autoCheckpoint: boolean;
  summary?: string;
  kind?: CheckpointKind;
  command?: string;
  testStatus?: "unknown" | "passed" | "failed";
}

export interface HookConfig {
  copilot?: CopilotHookConfig;
}

export interface VSCodeHookInput {
  hookEventName?: string;
  tool_name?: string;
  tool_input?: {
    files?: unknown;
    filePath?: unknown;
    oldFilePath?: unknown;
    newFilePath?: unknown;
  };
}

const HOOKS_FILE_NAME = "hooks.yaml";
const VSCODE_HOOKS_DIR = path.join(".github", "hooks");
const VSCODE_COPILOT_HOOK_FILE_NAME = "anvil-copilot.json";
const FILE_EDIT_TOOL_NAMES = new Set([
  "editFiles",
  "createFile",
  "moveFile",
  "deleteFile",
  "replaceStringInFile",
  "create_file",
  "move_file",
  "delete_file",
  "replace_string_in_file"
]);

export function hookConfigPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", HOOKS_FILE_NAME);
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function parseScalar(value: string): string | boolean {
  const normalized = stripQuotes(value.trim());
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return normalized;
}

function parseHooksYaml(content: string): HookConfig {
  const result: HookConfig = {};
  let section: "copilot" | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (!line.startsWith(" ")) {
      const sectionMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
      if (!sectionMatch) {
        continue;
      }

      const key = sectionMatch[1];
      section = key === "copilot" ? "copilot" : null;
      if (section === "copilot") {
        result.copilot ??= { autoCheckpoint: false };
      }
      continue;
    }

    if (!section) {
      continue;
    }

    const pairMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.+)?$/);
    if (!pairMatch) {
      continue;
    }

    const [, key, rawValue = ""] = pairMatch;
    const value = parseScalar(rawValue);

    if (section === "copilot") {
      const config = (result.copilot ??= { autoCheckpoint: false });
      switch (key) {
        case "autoCheckpoint":
        case "auto_checkpoint":
          config.autoCheckpoint = Boolean(value);
          break;
        case "summary":
          config.summary = String(value);
          break;
        case "kind":
          config.kind = String(value) as CheckpointKind;
          break;
        case "command":
          config.command = String(value);
          break;
        case "testStatus":
        case "test_status":
          config.testStatus = String(value) as "unknown" | "passed" | "failed";
          break;
      }
    }
  }

  return result;
}

export async function loadHookConfig(repositoryRoot: string): Promise<HookConfig> {
  const filePath = hookConfigPath(repositoryRoot);
  if (!existsSync(filePath)) {
    return {};
  }

  const content = await readFile(filePath, "utf8");
  return parseHooksYaml(content);
}

export function vscodeCopilotHookConfigPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, VSCODE_HOOKS_DIR, VSCODE_COPILOT_HOOK_FILE_NAME);
}

export function isCopilotFileEditEvent(input: VSCodeHookInput | null): boolean {
  if (!input) {
    return true;
  }

  if (input.hookEventName && input.hookEventName !== "PostToolUse") {
    return false;
  }

  if (input.tool_name && FILE_EDIT_TOOL_NAMES.has(input.tool_name)) {
    return true;
  }

  const toolInput = input.tool_input;
  if (!toolInput) {
    return false;
  }

  return Array.isArray(toolInput.files) || Boolean(toolInput.filePath || toolInput.oldFilePath || toolInput.newFilePath);
}

export async function installVSCodeCopilotHook(repositoryRoot: string): Promise<string> {
  const hookPath = vscodeCopilotHookConfigPath(repositoryRoot);
  await mkdir(path.dirname(hookPath), { recursive: true });
  const content = JSON.stringify(
    {
      hooks: {
        PostToolUse: [
          {
            type: "command",
            command: "anvil hook copilot-after-edit --vscode-hook",
            timeout: 30
          }
        ]
      }
    },
    null,
    2
  );
  await writeFile(hookPath, `${content}\n`, "utf8");
  return hookPath;
}
