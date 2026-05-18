import path from "node:path";
import process from "node:process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import type { CheckpointKind } from "./types.js";
import { ensureExecutionGuardScript, executionGuardScriptPath } from "./policy.js";

export interface CopilotHookConfig {
  autoCheckpoint: boolean;
  summary?: string;
  kind?: CheckpointKind;
  command?: string;
  testStatus?: "unknown" | "passed" | "failed";
}

export interface HookConfig {
  copilotVs?: CopilotHookConfig;
  copilotCli?: CopilotHookConfig;
  codex?: CopilotHookConfig;
}

export interface VSCodeHookInput {
  hookEventName?: string;
  hook_event_name?: string;
  tool_name?: string;
  toolName?: string;
  tool_name_raw?: string;
  prompt?: unknown;
  userPrompt?: unknown;
  user_prompt?: unknown;
  toolArgs?: unknown;
  tool_input?: {
    files?: unknown;
    filePath?: unknown;
    oldFilePath?: unknown;
    newFilePath?: unknown;
    prompt?: unknown;
    userPrompt?: unknown;
    user_prompt?: unknown;
  };
}

export interface CodexHookInput {
  hook_event_name?: string;
  tool_name?: string;
  prompt?: unknown;
  userPrompt?: unknown;
  user_prompt?: unknown;
  tool_input?: {
    command?: unknown;
    filePath?: unknown;
    file_path?: unknown;
    path?: unknown;
    oldFilePath?: unknown;
    newFilePath?: unknown;
    old_file_path?: unknown;
    new_file_path?: unknown;
    files?: unknown;
    edits?: unknown;
    writes?: unknown;
    changes?: unknown;
    prompt?: unknown;
    userPrompt?: unknown;
    user_prompt?: unknown;
    instructions?: unknown;
    messages?: unknown;
    input?: unknown;
  };
}

export interface HookExecutionLogEntry {
  timestamp: string;
  hookName:
    | "copilot-after-edit"
    | "copilot-vs-after-edit"
    | "copilot-cli-after-edit"
    | "codex-after-edit"
    | "codex-prompt-submit"
    | "copilot-prompt-submit"
    | "copilot-vs-prompt-submit"
    | "copilot-cli-prompt-submit"
    | "copilot-pre-tool-use"
    | "copilot-vs-pre-tool-use"
    | "copilot-cli-pre-tool-use"
    | "copilot-permission-request"
    | "copilot-vs-permission-request"
    | "copilot-cli-permission-request"
    | "codex-pre-tool-use"
    | "codex-permission-request"
    | "codex-hook-parse";
  status:
    | "invalid_payload"
    | "ignored"
    | "disabled"
    | "no_changes"
    | "recorded"
    | "captured"
    | "allowed"
    | "asked"
    | "denied";
  mode: "cli" | "copilot-vs-hook" | "copilot-cli-hook" | "codex-hook";
  branch?: string;
  checkpointId?: string;
  files?: string[];
  message?: string;
}

const HOOKS_FILE_NAME = "hooks.yaml";
const HOOK_EXECUTION_LOG_FILE_NAME = "hook-executions.jsonl";
const HOOK_WRAPPER_ERROR_LOG_FILE_NAME = "hook-wrapper-errors.log";
const COPILOT_VS_PENDING_PROMPT_FILE_NAME = "copilot-vs-pending-prompt.json";
const COPILOT_CLI_PENDING_PROMPT_FILE_NAME = "copilot-cli-pending-prompt.json";
const CODEX_PENDING_PROMPT_FILE_NAME = "codex-pending-prompt.json";
const VSCODE_HOOKS_DIR = path.join(".github", "hooks");
const VSCODE_COPILOT_VS_HOOK_FILE_NAME = "anvil-copilot-vs.json";
const VSCODE_COPILOT_CLI_HOOK_FILE_NAME = "anvil-copilot-cli.json";
const CODEX_HOOKS_DIR = path.join(".codex");
const CODEX_HOOKS_FILE_NAME = "hooks.json";
const CODEX_WRAPPER_FILE_NAME = "anvil-codex-after-edit.mjs";
const CODEX_PROMPT_WRAPPER_FILE_NAME = "anvil-codex-prompt-submit.mjs";
const COPILOT_VS_PROMPT_WRAPPER_FILE_NAME = "anvil-copilot-vs-prompt-submit.mjs";
const COPILOT_CLI_PROMPT_WRAPPER_FILE_NAME = "anvil-copilot-cli-prompt-submit.mjs";
const COPILOT_CLI_AFTER_EDIT_WRAPPER_FILE_NAME = "anvil-copilot-cli-after-edit.mjs";
const ANVIL_INTERNAL_COPILOT_VS_HOOK_PATH = `${VSCODE_HOOKS_DIR.replace(/\\/g, "/")}/${VSCODE_COPILOT_VS_HOOK_FILE_NAME}`;
const ANVIL_INTERNAL_COPILOT_CLI_HOOK_PATH = `${VSCODE_HOOKS_DIR.replace(/\\/g, "/")}/${VSCODE_COPILOT_CLI_HOOK_FILE_NAME}`;
const ANVIL_INTERNAL_CODEX_HOOK_PATH = `${CODEX_HOOKS_DIR.replace(/\\/g, "/")}/${CODEX_HOOKS_FILE_NAME}`;
const ANVIL_INTERNAL_CODEX_WRAPPER_PATH = `${CODEX_HOOKS_DIR.replace(/\\/g, "/")}/${CODEX_WRAPPER_FILE_NAME}`;
const FILE_EDIT_TOOL_NAMES = new Set([
  "create",
  "edit",
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

const READ_ONLY_TOOL_NAMES = new Set([
  "glob",
  "grep",
  "search",
  "read",
  "readFile",
  "view",
  "list",
  "ls",
  "getcwd",
  "pwd"
]);

function currentCliEntrypoint(): string {
  return process.argv[1] ? path.resolve(process.argv[1]) : "";
}

function currentNodeExecutable(): string {
  return process.execPath;
}

function shellCommandForCurrentCli(args: string[]): string {
  const nodeExecutable = currentNodeExecutable().replace(/"/g, '\\"');
  const cliEntrypoint = currentCliEntrypoint().replace(/"/g, '\\"');
  const escapedArgs = args.map((value) => value.replace(/"/g, '\\"'));
  return `"${nodeExecutable}" "${cliEntrypoint}" ${escapedArgs.map((value) => `"${value}"`).join(" ")}`;
}

function powershellQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function powershellCommand(executable: string, args: string[]): string {
  return `& ${[executable, ...args].map(powershellQuote).join(" ")}`;
}

function promptWrapperContent(
  repositoryRoot: string,
  cliEntrypoint: string,
  nodeExecutable: string,
  hookName:
    | "codex-prompt-submit"
    | "copilot-prompt-submit"
    | "copilot-vs-prompt-submit"
    | "copilot-cli-prompt-submit",
  modeFlag: "--codex-hook" | "--copilot-cli-hook" | "--copilot-vs-hook" | "--copilot-hook" | "--vscode-hook"
): string {
  const errorLogPath = path.join(repositoryRoot, ".anvil", HOOK_WRAPPER_ERROR_LOG_FILE_NAME);
  return `import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function logWrapperError(error) {
  const target = ${JSON.stringify(errorLogPath)};
  await mkdir(path.dirname(target), { recursive: true });
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  const record = {
    timestamp: new Date().toISOString(),
    wrapper: ${JSON.stringify(hookName)},
    cwd: process.cwd(),
    message
  };
  await appendFile(target, \`\${JSON.stringify(record)}\\n\`, "utf8");
}

try {
  const rawInput = await readStdin();
  const result = spawnSync(${JSON.stringify(nodeExecutable)}, [${JSON.stringify(cliEntrypoint)}, "hook", ${JSON.stringify(hookName)}, ${JSON.stringify(modeFlag)}], {
    cwd: process.cwd(),
    input: rawInput,
    encoding: "utf8",
    shell: false
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if ((result.status ?? 0) !== 0) {
    await logWrapperError(new Error(result.stderr?.trim() || result.stdout?.trim() || ${JSON.stringify(`${hookName} exited with code`)} + " " + String(result.status ?? "unknown")));
  }

  process.exit(result.status ?? 0);
} catch (error) {
  await logWrapperError(error);
  process.exit(1);
}
`;
}

export function hookConfigPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", HOOKS_FILE_NAME);
}

export function hookExecutionLogPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", HOOK_EXECUTION_LOG_FILE_NAME);
}

export function hookWrapperErrorLogPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", HOOK_WRAPPER_ERROR_LOG_FILE_NAME);
}

export function copilotPendingPromptPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", COPILOT_VS_PENDING_PROMPT_FILE_NAME);
}

export function copilotVsPendingPromptPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", COPILOT_VS_PENDING_PROMPT_FILE_NAME);
}

export function copilotCliPendingPromptPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", COPILOT_CLI_PENDING_PROMPT_FILE_NAME);
}

export function codexPendingPromptPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", CODEX_PENDING_PROMPT_FILE_NAME);
}

export function codexPromptWrapperPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", CODEX_PROMPT_WRAPPER_FILE_NAME);
}

export function copilotPromptWrapperPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", COPILOT_CLI_PROMPT_WRAPPER_FILE_NAME);
}

export function copilotVsPromptWrapperPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", COPILOT_VS_PROMPT_WRAPPER_FILE_NAME);
}

export function copilotCliPromptWrapperPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", COPILOT_CLI_PROMPT_WRAPPER_FILE_NAME);
}

export function copilotCliAfterEditWrapperPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", COPILOT_CLI_AFTER_EDIT_WRAPPER_FILE_NAME);
}

export interface PendingCodexPrompt {
  prompt: string;
  rationale: string | null;
  capturedAt: string;
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
  let section: "copilotVs" | "copilotCli" | "codex" | null = null;

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
      section =
        key === "copilotVs" || key === "copilotCli" || key === "codex"
          ? key
          : key === "copilot"
            ? "copilotVs"
            : null;
      if (section === "copilotVs" || section === "copilotCli" || section === "codex") {
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

    if (section === "copilotVs" || section === "copilotCli" || section === "codex") {
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
copilotVs:
  autoCheckpoint: false
  summary: "Copilot VS file changes"
  kind: after_edit_batch
  command: copilot-vs
  testStatus: unknown
copilotCli:
  autoCheckpoint: false
  summary: "Copilot CLI file changes"
  kind: after_edit_batch
  command: copilot-cli
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

export async function writePendingCodexPrompt(
  repositoryRoot: string,
  prompt: string,
  rationale?: string | null
): Promise<void> {
  const filePath = codexPendingPromptPath(repositoryRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload: PendingCodexPrompt = {
    prompt,
    rationale: rationale ?? null,
    capturedAt: new Date().toISOString()
  };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function writePendingCopilotPrompt(
  repositoryRoot: string,
  prompt: string,
  rationale?: string | null
): Promise<void> {
  const filePath = copilotVsPendingPromptPath(repositoryRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload: PendingCodexPrompt = {
    prompt,
    rationale: rationale ?? null,
    capturedAt: new Date().toISOString()
  };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function writePendingCopilotCliPrompt(
  repositoryRoot: string,
  prompt: string,
  rationale?: string | null
): Promise<void> {
  const filePath = copilotCliPendingPromptPath(repositoryRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload: PendingCodexPrompt = {
    prompt,
    rationale: rationale ?? null,
    capturedAt: new Date().toISOString()
  };
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export async function readPendingCodexPrompt(repositoryRoot: string): Promise<PendingCodexPrompt | null> {
  const filePath = codexPendingPromptPath(repositoryRoot);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PendingCodexPrompt>;
    if (!parsed.prompt || typeof parsed.prompt !== "string") {
      return null;
    }

    return {
      prompt: parsed.prompt,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : null,
      capturedAt: typeof parsed.capturedAt === "string" ? parsed.capturedAt : new Date(0).toISOString()
    };
  } catch {
    return null;
  }
}

export async function readPendingCopilotPrompt(repositoryRoot: string): Promise<PendingCodexPrompt | null> {
  const filePath = copilotVsPendingPromptPath(repositoryRoot);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PendingCodexPrompt>;
    if (!parsed.prompt || typeof parsed.prompt !== "string") {
      return null;
    }

    return {
      prompt: parsed.prompt,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : null,
      capturedAt: typeof parsed.capturedAt === "string" ? parsed.capturedAt : new Date(0).toISOString()
    };
  } catch {
    return null;
  }
}

export async function readPendingCopilotCliPrompt(repositoryRoot: string): Promise<PendingCodexPrompt | null> {
  const filePath = copilotCliPendingPromptPath(repositoryRoot);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PendingCodexPrompt>;
    if (!parsed.prompt || typeof parsed.prompt !== "string") {
      return null;
    }

    return {
      prompt: parsed.prompt,
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : null,
      capturedAt: typeof parsed.capturedAt === "string" ? parsed.capturedAt : new Date(0).toISOString()
    };
  } catch {
    return null;
  }
}

export async function clearPendingCodexPrompt(repositoryRoot: string): Promise<void> {
  const filePath = codexPendingPromptPath(repositoryRoot);
  if (!existsSync(filePath)) {
    return;
  }

  await writeFile(filePath, "", "utf8");
}

export async function clearPendingCopilotPrompt(repositoryRoot: string): Promise<void> {
  const filePath = copilotVsPendingPromptPath(repositoryRoot);
  if (!existsSync(filePath)) {
    return;
  }

  await writeFile(filePath, "", "utf8");
}

export async function clearPendingCopilotCliPrompt(repositoryRoot: string): Promise<void> {
  const filePath = copilotCliPendingPromptPath(repositoryRoot);
  if (!existsSync(filePath)) {
    return;
  }

  await writeFile(filePath, "", "utf8");
}

export function vscodeCopilotHookConfigPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, VSCODE_HOOKS_DIR, VSCODE_COPILOT_VS_HOOK_FILE_NAME);
}

export function copilotCliHookConfigPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, VSCODE_HOOKS_DIR, VSCODE_COPILOT_CLI_HOOK_FILE_NAME);
}

export function isCopilotFileEditEvent(input: VSCodeHookInput | null): boolean {
  if (!input) {
    return true;
  }

  const eventName = input.hookEventName ?? input.hook_event_name;
  if (eventName && eventName !== "PostToolUse" && eventName !== "postToolUse") {
    return false;
  }

  const toolName = input.tool_name ?? input.toolName;
  if (toolName && FILE_EDIT_TOOL_NAMES.has(toolName)) {
    return true;
  }
  if (toolName && READ_ONLY_TOOL_NAMES.has(toolName)) {
    return false;
  }

  const toolInput = input.tool_input ?? (input.toolArgs && typeof input.toolArgs === "object" ? (input.toolArgs as VSCodeHookInput["tool_input"]) : undefined);
  if (!toolInput) {
    return extractHookFilePaths(input).length > 0;
  }

  return extractHookFilePaths(input).length > 0;
}

export function isCopilotPromptSubmitEvent(input: VSCodeHookInput | null): boolean {
  if (!input) {
    return false;
  }

  const eventName = input.hookEventName ?? input.hook_event_name;
  if (eventName) {
    return eventName === "UserPromptSubmit" || eventName === "userPromptSubmitted";
  }

  return Boolean(extractVSCodeHookPrompt(input));
}

function normalizeHookFilePath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/\\/g, "/");
  if (
    !trimmed ||
    trimmed.startsWith(".anvil/") ||
    trimmed === ANVIL_INTERNAL_COPILOT_VS_HOOK_PATH ||
    trimmed === ANVIL_INTERNAL_COPILOT_CLI_HOOK_PATH ||
    trimmed === ANVIL_INTERNAL_CODEX_HOOK_PATH
  ) {
    return null;
  }

  return trimmed;
}

export function extractHookFilePaths(input: VSCodeHookInput | null): string[] {
  const paths = new Set<string>();
  const candidateRecords: Record<string, unknown>[] = [];
  const toolInput =
    input?.tool_input ??
    (input?.toolArgs && typeof input.toolArgs === "object"
      ? (input.toolArgs as VSCodeHookInput["tool_input"])
      : undefined);
  if (toolInput && typeof toolInput === "object") {
    candidateRecords.push(toolInput as Record<string, unknown>);
  }
  if (input?.toolArgs && typeof input.toolArgs === "object") {
    candidateRecords.push(input.toolArgs as Record<string, unknown>);
  }
  if (input && typeof input === "object") {
    candidateRecords.push(input as Record<string, unknown>);
  }

  for (const record of candidateRecords) {
    const directCandidates = [
      record.filePath,
      record.file_path,
      record.oldFilePath,
      record.newFilePath,
      record.old_file_path,
      record.new_file_path,
      record.path,
      record.uri,
      record.target,
      record.targetFile
    ];

    for (const candidate of directCandidates) {
      addNormalizedHookPath(paths, candidate);
    }

    extractNestedHookPaths(record.files, paths);
    extractNestedHookPaths(record.edits, paths);
    extractNestedHookPaths(record.writes, paths);
    extractNestedHookPaths(record.changes, paths);
    extractNestedHookPaths(record, paths);
  }

  if (paths.size > 0) {
    return [...paths];
  }

  for (const record of candidateRecords) {
    const command = record.command;
    if (typeof command === "string") {
      const extracted = extractCodexHookFilePathsFromText(command);
      if (extracted.length > 0) {
        return extracted;
      }
    }
  }

  return [];
}

function addNormalizedHookPath(paths: Set<string>, value: unknown): void {
  const filePath = normalizeHookFilePath(value);
  if (filePath) {
    paths.add(filePath);
  }
}

function extractNestedHookPaths(value: unknown, paths: Set<string>): void {
  if (typeof value === "string") {
    addNormalizedHookPath(paths, value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractNestedHookPaths(item, paths);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  const candidateKeys = [
    "path",
    "file",
    "filePath",
    "file_path",
    "uri",
    "source",
    "sourcePath",
    "source_file",
    "sourceFile",
    "destination",
    "destinationPath",
    "destination_file",
    "destinationFile",
    "target",
    "targetFile",
    "target_file",
    "oldPath",
    "newPath",
    "oldFilePath",
    "newFilePath",
    "old_file_path",
    "new_file_path"
  ];

  for (const key of candidateKeys) {
    addNormalizedHookPath(paths, record[key]);
  }
}

function normalizePromptValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractPromptFromMessageArray(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const parts: string[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role.toLowerCase() : "";
    if (role && role !== "user" && role !== "system" && role !== "developer") {
      continue;
    }

    const content = normalizePromptValue(record.content) ?? normalizePromptValue(record.text) ?? normalizePromptValue(record.message);
    if (content) {
      parts.push(role ? `${role}: ${content}` : content);
    }
  }

  if (parts.length === 0) {
    return null;
  }

  return parts.join("\n\n");
}

function extractPromptFromRecord(record: Record<string, unknown>, depth = 0): string | null {
  if (depth > 3) {
    return null;
  }

  const directKeys = [
    "prompt",
    "userPrompt",
    "user_prompt",
    "instructions",
    "instruction",
    "task",
    "request",
    "message",
    "content",
    "text",
    "query"
  ];

  for (const key of directKeys) {
    const direct = normalizePromptValue(record[key]);
    if (direct) {
      return direct;
    }
  }

  const arrayKeys = ["messages", "conversation", "input"];
  for (const key of arrayKeys) {
    const extracted = extractPromptFromMessageArray(record[key]);
    if (extracted) {
      return extracted;
    }
  }

  const nestedKeys = ["tool_input", "toolArgs", "payload", "request", "input", "data"];
  for (const key of nestedKeys) {
    const nested = record[key];
    if (nested && typeof nested === "object") {
      const extracted = extractPromptFromRecord(nested as Record<string, unknown>, depth + 1);
      if (extracted) {
        return extracted;
      }
    }
  }

  return null;
}

export function extractCodexHookFilePaths(input: CodexHookInput | null): string[] {
  const toolInput = input?.tool_input;
  if (!toolInput) {
    return [];
  }

  const paths = new Set<string>();
  const directCandidates = [
    toolInput.filePath,
    toolInput.file_path,
    toolInput.path,
    toolInput.oldFilePath,
    toolInput.newFilePath,
    toolInput.old_file_path,
    toolInput.new_file_path
  ];

  for (const candidate of directCandidates) {
    addNormalizedHookPath(paths, candidate);
  }

  extractNestedHookPaths(toolInput.files, paths);
  extractNestedHookPaths(toolInput.edits, paths);
  extractNestedHookPaths(toolInput.writes, paths);
  extractNestedHookPaths(toolInput.changes, paths);

  if (paths.size > 0) {
    return [...paths];
  }

  const command = toolInput.command;
  return typeof command === "string" ? extractCodexHookFilePathsFromText(command) : [];
}

export function extractCodexHookPrompt(input: CodexHookInput | null): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  return extractPromptFromRecord(input as Record<string, unknown>);
}

export function extractVSCodeHookPrompt(input: VSCodeHookInput | null): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  return extractPromptFromRecord(input as Record<string, unknown>);
}

export function extractCodexHookFilePathsFromText(command: string): string[] {
  const normalizedCommand = command
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/`r`n/g, "\n")
    .replace(/`n/g, "\n");

  if (!normalizedCommand.trim()) {
    return [];
  }

  const paths = new Set<string>();
  const patterns = [
    /^\*\*\* Update File:\s+(.+)$/gm,
    /^\*\*\* Add File:\s+(.+)$/gm,
    /^\*\*\* Delete File:\s+(.+)$/gm,
    /^\+\+\+\s+b\/(.+)$/gm,
    /^---\s+a\/(.+)$/gm
  ];

  for (const pattern of patterns) {
    for (const match of normalizedCommand.matchAll(pattern)) {
      const filePath = normalizeHookFilePath(match[1]);
      if (filePath) {
        paths.add(filePath);
      }
    }
  }

  return [...paths];
}

export function extractCodexHookRationale(input: CodexHookInput | null): string | null {
  if (!input?.tool_input || typeof input.tool_input !== "object") {
    return null;
  }

  const record = input.tool_input as Record<string, unknown>;
  return (
    normalizePromptValue(record.reasoning) ??
    normalizePromptValue(record.rationale) ??
    normalizePromptValue(record.thought) ??
    null
  );
}

export function extractVSCodeHookRationale(input: VSCodeHookInput | null): string | null {
  if (!input?.tool_input || typeof input.tool_input !== "object") {
    return null;
  }

  const record = input.tool_input as Record<string, unknown>;
  return (
    normalizePromptValue(record.reasoning) ??
    normalizePromptValue(record.rationale) ??
    normalizePromptValue(record.thought) ??
    null
  );
}

export async function installCopilotVsHook(repositoryRoot: string): Promise<string> {
  const hookPath = vscodeCopilotHookConfigPath(repositoryRoot);
  const guardScript = await ensureExecutionGuardScript(repositoryRoot);
  const promptWrapperPath = copilotVsPromptWrapperPath(repositoryRoot);
  const nodeExecutable = currentNodeExecutable();
  const guardScriptCommandPath = path.resolve(guardScript).replace(/\\/g, "/");
  const cliEntrypoint = currentCliEntrypoint();
  const promptWrapperCommandPath = path.resolve(promptWrapperPath).replace(/\\/g, "/");
  await mkdir(path.dirname(hookPath), { recursive: true });
  await writeFile(
    promptWrapperPath,
    `${promptWrapperContent(
      repositoryRoot,
      cliEntrypoint,
      nodeExecutable,
      "copilot-vs-prompt-submit",
      "--copilot-vs-hook"
    )}\n`,
    "utf8"
  );
  const content = JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            type: "command",
            command: `"${nodeExecutable}" "${guardScriptCommandPath}" --host copilot-vs`,
            timeout: 10
          }
        ],
        UserPromptSubmit: [
          {
            type: "command",
            command: `"${nodeExecutable}" "${promptWrapperCommandPath}"`,
            timeout: 15
          }
        ],
        PostToolUse: [
          {
            type: "command",
            command: shellCommandForCurrentCli(["hook", "copilot-after-edit", "--copilot-vs-hook"]),
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

export async function installCopilotCliHook(repositoryRoot: string): Promise<string> {
  const hookPath = copilotCliHookConfigPath(repositoryRoot);
  const guardScript = await ensureExecutionGuardScript(repositoryRoot);
  const promptWrapperPath = copilotCliPromptWrapperPath(repositoryRoot);
  const afterEditWrapperPath = copilotCliAfterEditWrapperPath(repositoryRoot);
  const nodeExecutable = currentNodeExecutable();
  const guardScriptCommandPath = path.resolve(guardScript).replace(/\\/g, "/");
  const cliEntrypoint = currentCliEntrypoint();
  const promptWrapperCommandPath = path.resolve(promptWrapperPath).replace(/\\/g, "/");
  const afterEditWrapperCommandPath = path.resolve(afterEditWrapperPath).replace(/\\/g, "/");
  await mkdir(path.dirname(hookPath), { recursive: true });
  await writeFile(
    promptWrapperPath,
    `${promptWrapperContent(
      repositoryRoot,
      cliEntrypoint,
      nodeExecutable,
      "copilot-cli-prompt-submit",
      "--copilot-cli-hook"
    )}\n`,
    "utf8"
  );
  const afterEditDebugPath = path.join(repositoryRoot, ".anvil", "copilot-cli-posttool-debug.json");
  const afterEditWrapperContent = `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
  });
}

function normalizePathValue(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/\\\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith(".anvil/") ||
    normalized === ".github/hooks/${VSCODE_COPILOT_CLI_HOOK_FILE_NAME}" ||
    normalized === ".github/hooks/${VSCODE_COPILOT_VS_HOOK_FILE_NAME}" ||
    normalized === ".codex/hooks.json"
  ) {
    return null;
  }

  return normalized;
}

function addPath(paths, value) {
  const normalized = normalizePathValue(value);
  if (normalized) {
    paths.add(normalized);
  }
}

function collectNestedPaths(value, paths) {
  if (typeof value === "string") {
    addPath(paths, value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedPaths(item, paths);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const record = value;
  const candidateKeys = [
    "path",
    "file",
    "filePath",
    "file_path",
    "target",
    "targetFile",
    "target_file",
    "source",
    "sourcePath",
    "sourceFile",
    "destination",
    "destinationPath",
    "destinationFile",
    "oldPath",
    "newPath",
    "oldFilePath",
    "newFilePath",
    "old_file_path",
    "new_file_path",
    "uri"
  ];

  for (const key of candidateKeys) {
    addPath(paths, record[key]);
  }

  for (const nestedKey of ["files", "edits", "writes", "changes", "results", "args", "toolArgs", "tool_input"]) {
    collectNestedPaths(record[nestedKey], paths);
  }
}

function runAnvil(args, input = "") {
  const result = spawnSync(${JSON.stringify(nodeExecutable)}, [${JSON.stringify(cliEntrypoint)}, ...args], {
    cwd: process.cwd(),
    input,
    encoding: "utf8",
    shell: false
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  process.exit(result.status ?? 0);
}

async function writeDebugRecord(rawInput, payload, editedPaths) {
  const target = ${JSON.stringify(afterEditDebugPath)};
  await mkdir(path.dirname(target), { recursive: true });
  const record = {
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
    rawInput,
    payload,
    extractedPaths: editedPaths
  };
  await writeFile(target, JSON.stringify(record, null, 2), "utf8");
}

const rawInput = await readStdin();
let payload = null;

if (rawInput) {
  try {
    payload = JSON.parse(rawInput);
  } catch {
    runAnvil(["hook", "copilot-after-edit", "--copilot-cli-hook"], rawInput);
  }
}

const paths = new Set();
collectNestedPaths(payload, paths);
const editedPaths = [...paths];
await writeDebugRecord(rawInput, payload, editedPaths);

if (editedPaths.length > 0) {
  const toolName =
    typeof payload?.toolName === "string"
      ? payload.toolName
      : typeof payload?.tool_name === "string"
        ? payload.tool_name
        : "editFiles";
  const prompt =
    typeof payload?.prompt === "string" && payload.prompt.trim()
      ? payload.prompt.trim()
      : typeof payload?.userPrompt === "string" && payload.userPrompt.trim()
        ? payload.userPrompt.trim()
        : typeof payload?.user_prompt === "string" && payload.user_prompt.trim()
          ? payload.user_prompt.trim()
          : null;

  const normalizedPayload = {
    hookEventName: "PostToolUse",
    toolName,
    ...(prompt ? { prompt } : {}),
    toolArgs: {
      files: editedPaths.map((filePath) => ({ path: filePath }))
    }
  };

  runAnvil(["hook", "copilot-after-edit", "--copilot-cli-hook"], JSON.stringify(normalizedPayload));
}

runAnvil(["hook", "copilot-after-edit", "--copilot-cli-hook"], rawInput);
`;
  await writeFile(afterEditWrapperPath, `${afterEditWrapperContent}\n`, "utf8");
  const content = JSON.stringify(
    {
      version: 1,
      hooks: {
          preToolUse: [
            {
              type: "command",
              bash: `"${nodeExecutable}" "${guardScriptCommandPath}" --host copilot-cli`,
              powershell: powershellCommand(nodeExecutable, [guardScriptCommandPath, "--host", "copilot-cli"]),
              cwd: repositoryRoot,
              timeoutSec: 10
            }
          ],
          permissionRequest: [
            {
              type: "command",
              bash: `"${nodeExecutable}" "${guardScriptCommandPath}" --host copilot-cli --permission-request`,
              powershell: powershellCommand(nodeExecutable, [
                guardScriptCommandPath,
                "--host",
                "copilot-cli",
                "--permission-request"
              ]),
              cwd: repositoryRoot,
              timeoutSec: 10
            }
          ],
          userPromptSubmitted: [
            {
              type: "command",
              bash: `"${nodeExecutable}" "${promptWrapperCommandPath}"`,
              powershell: powershellCommand(nodeExecutable, [promptWrapperCommandPath]),
              cwd: repositoryRoot,
              timeoutSec: 15
            }
          ],
          postToolUse: [
            {
              type: "command",
              bash: `"${nodeExecutable}" "${afterEditWrapperCommandPath}"`,
              powershell: powershellCommand(nodeExecutable, [afterEditWrapperCommandPath]),
              cwd: repositoryRoot,
              timeoutSec: 30
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

export function codexHookWrapperPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, CODEX_HOOKS_DIR, CODEX_WRAPPER_FILE_NAME);
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

export function isCodexPromptSubmitEvent(input: CodexHookInput | null): boolean {
  if (!input) {
    return false;
  }

  return input.hook_event_name === "UserPromptSubmit";
}

export async function installCodexHook(repositoryRoot: string): Promise<string> {
  const hookPath = codexHookConfigPath(repositoryRoot);
  const wrapperPath = codexHookWrapperPath(repositoryRoot);
  const promptWrapperPath = codexPromptWrapperPath(repositoryRoot);
  const guardScript = await ensureExecutionGuardScript(repositoryRoot);
  const cliEntrypoint = currentCliEntrypoint();
  const nodeExecutable = currentNodeExecutable();
  const guardScriptCommandPath = path.resolve(guardScript).replace(/\\/g, "/");
  const wrapperCommandPath = path.resolve(wrapperPath).replace(/\\/g, "/");
  const promptWrapperCommandPath = path.resolve(promptWrapperPath).replace(/\\/g, "/");
  await mkdir(path.dirname(hookPath), { recursive: true });
  const wrapperContent = `import { spawnSync } from "node:child_process";

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
  });
}

function normalizePathValue(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/\\\\/g, "/");
  if (!normalized || normalized.startsWith(".anvil/") || normalized === ".codex/hooks.json" || normalized === ".codex/${CODEX_WRAPPER_FILE_NAME}") {
    return null;
  }

  return normalized;
}

function addPath(paths, value) {
  const normalized = normalizePathValue(value);
  if (normalized) {
    paths.add(normalized);
  }
}

function collectNestedPaths(value, paths) {
  if (typeof value === "string") {
    addPath(paths, value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectNestedPaths(item, paths);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  const record = value;
  const candidateKeys = [
    "path",
    "file",
    "filePath",
    "file_path",
    "target",
    "targetFile",
    "target_file",
    "oldPath",
    "newPath",
    "oldFilePath",
    "newFilePath",
    "old_file_path",
    "new_file_path"
  ];

  for (const key of candidateKeys) {
    addPath(paths, record[key]);
  }
}

function extractPatchPaths(commandText) {
  if (typeof commandText !== "string" || !commandText.trim()) {
    return [];
  }

  const normalized = commandText
    .replace(/\\\\r\\\\n/g, "\\n")
    .replace(/\\\\n/g, "\\n")
    .replace(/\`r\`n/g, "\\n")
    .replace(/\`n/g, "\\n");

  const paths = new Set();
  const patterns = [
    /^\\*\\*\\* Update File:\\s+(.+)$/gm,
    /^\\*\\*\\* Add File:\\s+(.+)$/gm,
    /^\\*\\*\\* Delete File:\\s+(.+)$/gm,
    /^\\+\\+\\+\\s+b\\/(.+)$/gm,
    /^---\\s+a\\/(.+)$/gm
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      addPath(paths, match[1]);
    }
  }

  return [...paths];
}

function extractCodexPaths(payload) {
  const toolInput = payload?.tool_input;
  if (!toolInput || typeof toolInput !== "object") {
    return [];
  }

  const paths = new Set();
  const directCandidates = [
    toolInput.filePath,
    toolInput.file_path,
    toolInput.path,
    toolInput.oldFilePath,
    toolInput.newFilePath,
    toolInput.old_file_path,
    toolInput.new_file_path
  ];

  for (const candidate of directCandidates) {
    addPath(paths, candidate);
  }

  collectNestedPaths(toolInput.files, paths);
  collectNestedPaths(toolInput.edits, paths);
  collectNestedPaths(toolInput.writes, paths);
  collectNestedPaths(toolInput.changes, paths);

  if (paths.size > 0) {
    return [...paths];
  }

  return extractPatchPaths(toolInput.command);
}

function runAnvil(args, input = "") {
  const result = spawnSync(${JSON.stringify(nodeExecutable)}, [${JSON.stringify(cliEntrypoint)}, ...args], {
    cwd: process.cwd(),
    input,
    encoding: "utf8",
    shell: false
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  process.exit(result.status ?? 0);
}

const rawInput = await readStdin();
let payload = null;

if (rawInput) {
  try {
    payload = JSON.parse(rawInput);
  } catch {
    runAnvil(["hook", "codex-after-edit", "--codex-hook"], rawInput);
  }
}

function extractPrompt(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const direct = [payload.prompt, payload.userPrompt, payload.user_prompt];
  for (const candidate of direct) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  const toolInput = payload.tool_input;
  if (toolInput && typeof toolInput === "object") {
    const nested = [toolInput.prompt, toolInput.userPrompt, toolInput.user_prompt, toolInput.instructions];
    for (const candidate of nested) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }

  return null;
}

const editedPaths = extractCodexPaths(payload);
const prompt = extractPrompt(payload);

if (editedPaths.length > 0) {
  const normalizedPayload = {
    hook_event_name: payload?.hook_event_name ?? "PostToolUse",
    tool_name: payload?.tool_name ?? "apply_patch",
    ...(prompt ? { prompt } : {}),
    tool_input: {
      command: editedPaths.map((filePath) => \`*** Update File: \${filePath}\`).join("\\n")
    }
  };

  runAnvil(["hook", "codex-after-edit", "--codex-hook"], JSON.stringify(normalizedPayload));
}

runAnvil(["hook", "codex-after-edit", "--codex-hook"], rawInput);
`;
  await writeFile(wrapperPath, `${wrapperContent}\n`, "utf8");
  await writeFile(
    promptWrapperPath,
    `${promptWrapperContent(
      repositoryRoot,
      cliEntrypoint,
      nodeExecutable,
      "codex-prompt-submit",
      "--codex-hook"
    )}\n`,
    "utf8"
  );
  const content = JSON.stringify(
    {
      hooks: {
        PreToolUse: [
          {
            type: "command",
            command: `"${nodeExecutable}" "${guardScriptCommandPath}" --host codex`,
            timeout: 10,
            statusMessage: "Checking Anvil execution policy"
          }
        ],
        PermissionRequest: [
          {
            type: "command",
            command: `"${nodeExecutable}" "${guardScriptCommandPath}" --host codex`,
            timeout: 10,
            statusMessage: "Checking Anvil approval policy"
          }
        ],
        PostToolUse: [
          {
            matcher: "^apply_patch$|^Edit$|^Write$",
            type: "command",
            command: `"${nodeExecutable}" "${wrapperCommandPath}"`,
            timeout: 30,
            statusMessage: "Checkpointing Codex edit in Anvil"
          }
        ],
        UserPromptSubmit: [
          {
            type: "command",
            command: `"${nodeExecutable}" "${promptWrapperCommandPath}"`,
            timeout: 15,
            statusMessage: "Capturing Codex prompt for Anvil"
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
