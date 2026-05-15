import path from "node:path";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
  codex?: CopilotHookConfig;
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

export interface CodexHookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: {
    command?: unknown;
  };
}

export interface HookExecutionLogEntry {
  timestamp: string;
  hookName: "copilot-after-edit" | "codex-after-edit";
  status: "invalid_payload" | "ignored" | "disabled" | "no_changes" | "recorded";
  mode: "cli" | "vscode-hook" | "codex-hook";
  branch?: string;
  checkpointId?: string;
  files?: string[];
  message?: string;
}

const HOOKS_FILE_NAME = "hooks.yaml";
const HOOK_EXECUTION_LOG_FILE_NAME = "hook-executions.jsonl";
const VSCODE_HOOKS_DIR = path.join(".github", "hooks");
const VSCODE_COPILOT_HOOK_FILE_NAME = "anvil-copilot.json";
const CODEX_HOOKS_DIR = path.join(".codex");
const CODEX_HOOKS_FILE_NAME = "hooks.json";
const ANVIL_INTERNAL_HOOK_PATH = `${VSCODE_HOOKS_DIR.replace(/\\/g, "/")}/${VSCODE_COPILOT_HOOK_FILE_NAME}`;
const ANVIL_INTERNAL_CODEX_HOOK_PATH = `${CODEX_HOOKS_DIR.replace(/\\/g, "/")}/${CODEX_HOOKS_FILE_NAME}`;
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

export function hookExecutionLogPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", HOOK_EXECUTION_LOG_FILE_NAME);
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
  let section: "copilot" | "codex" | null = null;

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
      section = key === "copilot" || key === "codex" ? key : null;
      if (section === "copilot" || section === "codex") {
        result[section] ??= { autoCheckpoint: false };
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

    if (section === "copilot" || section === "codex") {
      const config = (result[section] ??= { autoCheckpoint: false });
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

export async function ensureHookConfigTemplate(repositoryRoot: string): Promise<string> {
  const filePath = hookConfigPath(repositoryRoot);
  if (existsSync(filePath)) {
    return filePath;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  const content = `# Optional Anvil repo-local hook config
copilot:
  autoCheckpoint: false
  summary: "Copilot file changes"
  kind: after_edit_batch
  command: copilot
  testStatus: unknown
codex:
  autoCheckpoint: false
  summary: "Codex file changes"
  kind: after_edit_batch
  command: codex
  testStatus: unknown
`;
  await writeFile(filePath, content, "utf8");
  return filePath;
}

export async function appendHookExecutionLog(
  repositoryRoot: string,
  entry: HookExecutionLogEntry
): Promise<void> {
  const filePath = hookExecutionLogPath(repositoryRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readLastHookExecutionLog(
  repositoryRoot: string
): Promise<HookExecutionLogEntry | null> {
  const filePath = hookExecutionLogPath(repositoryRoot);
  if (!existsSync(filePath)) {
    return null;
  }

  const content = await readFile(filePath, "utf8");
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1);
  if (!lastLine) {
    return null;
  }

  try {
    return JSON.parse(lastLine) as HookExecutionLogEntry;
  } catch {
    return null;
  }
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

function normalizeHookFilePath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/\\/g, "/");
  if (
    !trimmed ||
    trimmed.startsWith(".anvil/") ||
    trimmed === ANVIL_INTERNAL_HOOK_PATH ||
    trimmed === ANVIL_INTERNAL_CODEX_HOOK_PATH
  ) {
    return null;
  }

  return trimmed;
}

export function extractHookFilePaths(input: VSCodeHookInput | null): string[] {
  if (!input?.tool_input) {
    return [];
  }

  const toolInput = input.tool_input;
  const paths = new Set<string>();

  const directPaths = [
    normalizeHookFilePath(toolInput.filePath),
    normalizeHookFilePath(toolInput.oldFilePath),
    normalizeHookFilePath(toolInput.newFilePath)
  ].filter((value): value is string => Boolean(value));

  for (const filePath of directPaths) {
    paths.add(filePath);
  }

  if (Array.isArray(toolInput.files)) {
    for (const item of toolInput.files) {
      const filePath = normalizeHookFilePath(item);
      if (filePath) {
        paths.add(filePath);
      }
    }
  }

  return [...paths];
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

export function codexHookConfigPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, CODEX_HOOKS_DIR, CODEX_HOOKS_FILE_NAME);
}

export function isCodexFileEditEvent(input: CodexHookInput | null): boolean {
  if (!input) {
    return true;
  }

  if (input.hook_event_name && input.hook_event_name !== "PostToolUse") {
    return false;
  }

  const toolName = input.tool_name ?? "";
  return toolName === "apply_patch" || toolName === "Edit" || toolName === "Write";
}

export async function installCodexHook(repositoryRoot: string): Promise<string> {
  const hookPath = codexHookConfigPath(repositoryRoot);
  await mkdir(path.dirname(hookPath), { recursive: true });
  const content = JSON.stringify(
    {
      hooks: {
        PostToolUse: [
          {
            matcher: "^apply_patch$|^Edit$|^Write$",
            hooks: [
              {
                type: "command",
                command: "anvil hook codex-after-edit --codex-hook",
                timeout: 30,
                statusMessage: "Checkpointing Codex edit in Anvil"
              }
            ]
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
