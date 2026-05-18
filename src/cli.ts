#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  appendHookExecutionLog,
  clearPendingCopilotPrompt,
  clearPendingCopilotCliPrompt,
  clearPendingCodexPrompt,
  copilotCliPromptWrapperPath,
  type CodexHookInput,
  copilotCliHookConfigPath,
  codexHookConfigPath,
  codexPromptWrapperPath,
  ensureHookConfigTemplate,
  extractCodexHookFilePaths,
  extractCodexHookFilePathsFromText,
  extractCodexHookPrompt,
  extractCodexHookRationale,
  extractHookFilePaths,
  extractVSCodeHookPrompt,
  extractVSCodeHookRationale,
  hookConfigPath,
  installCodexHook,
  installCopilotCliHook,
  installCopilotVsHook,
  isCodexFileEditEvent,
  isCopilotPromptSubmitEvent,
  isCodexPromptSubmitEvent,
  isCopilotFileEditEvent,
  loadHookConfig,
  readPendingCopilotPrompt,
  readPendingCopilotCliPrompt,
  readPendingCodexPrompt,
  readLastHookExecutionLog,
  hookWrapperErrorLogPath,
  writePendingCopilotPrompt,
  writePendingCopilotCliPrompt,
  writePendingCodexPrompt,
  vscodeCopilotHookConfigPath,
  type VSCodeHookInput
} from "./hooks.js";
import { getRepositoryRoot } from "./git.js";
import {
  appendGeneratedInsights,
  appendPendingHookOrchestrationEvent,
  consumePendingExtensionEvents,
  consumePendingHookOrchestrationEvents,
  ensureOrchestrationTemplate,
  loadOrchestrationConfig,
  matchesAfterCheckpointRule,
  matchesAfterHookRule,
  writeVerificationLog,
  type ExtensionCheckpointPayload,
  type HookOrchestrationEvent,
  type OrchestrationAction,
  type ExtensionRunnerOutput,
  type VerificationProfile
} from "./extensions.js";
import {
  collectIgnoredAnvilPaths,
  ensureAnvilIgnoreTemplate,
  filterIgnoredAnvilPaths,
  loadAnvilIgnoreRules,
  type AnvilIgnoreRules
} from "./ignore.js";
import {
  ensurePolicyTemplate,
  evaluateExecutionGuard,
  executionGuardScriptPath,
  loadExecutionGuardPolicy
} from "./policy.js";
import { CheckpointStore } from "./store.js";
import type { CheckpointKind } from "./types.js";
import { formatTimestamp } from "./utils.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function printHelp(): void {
  console.log(`anvil

Usage:
  anvil init [--hooks codex|copilot-vs|copilot-cli[,..]] [--codex] [--copilot-vs] [--copilot-cli]
  anvil install -g
  anvil install-copilot-hook
  anvil install-copilot-vs-hook
  anvil install-copilot-cli-hook
  anvil install-codex-hook
  anvil guard evaluate [--copilot-vs-hook|--copilot-cli-hook|--copilot-hook|--vscode-hook|--codex-hook]
  anvil repair-baseline
  anvil uninstall
  anvil uninstall -g
  anvil compact --mode keep-last|squash
  anvil prune [--dry-run] [--max-checkpoints-per-branch 50] [--max-hook-logs 500]
  anvil hook copilot-prompt-submit [--prompt "..."] [--rationale "..."] [--copilot-vs-hook|--copilot-cli-hook]
  anvil hook copilot-after-edit [--summary "summary"] [--kind after_edit_batch] [--command "copilot"] [--rationale "..."] [--test-status passed|failed|unknown] [--copilot-vs-hook|--copilot-cli-hook]
  anvil hook codex-after-edit [--summary "summary"] [--kind after_edit_batch] [--command "codex"] [--rationale "..."] [--test-status passed|failed|unknown] [--codex-hook]
  anvil hook status
  anvil hook doctor
  anvil watch [--interval-ms 1500] [--debounce-ms 2000] [--summary "Watcher file changes"] [--kind after_edit_batch] [--origin ai|manual] [--ai-source watcher] [--command "watcher"] [--test-status passed|failed|unknown]
  anvil run <profile> [--checkpoint cp-1]
  anvil run --command "npm run build" [--name custom] [--checkpoint cp-1]
  anvil verify <profile> [--checkpoint cp-1]
  anvil verify --command "npm run build" [--name custom] [--checkpoint cp-1]
  anvil review [--port 4312]
  anvil timeline
  anvil checkpoint --summary "summary" [--kind after_edit_batch] [--command "npm test"] [--prompt "..."] [--rationale "..."] [--origin ai|manual] [--ai-source codex|copilot|manual-ai] [--test-status passed|failed|unknown] [--only path/a,path/b]
  anvil diff [checkpoint] [checkpoint]
  anvil restore <checkpoint>
  anvil explain <checkpoint>
anvil assign-branch <checkpoint> [branch]
anvil export [--preview] [--message "message"]

Internal:
  anvil __record --kind <kind> --summary "summary" [--files a,b] [--command "..."] [--prompt "..."] [--rationale "..."] [--test-status passed|failed|unknown]
`);
}

function optionValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) {
    return null;
  }

  return args[index + 1];
}

function parsePathList(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim().replace(/\\/g, "/"))
    .filter(Boolean);
}

function extractNestedCommandString(value: unknown, depth = 0): string | null {
  if (depth > 3 || value == null) {
    return null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const extracted = extractNestedCommandString(parsed, depth + 1);
        if (extracted) {
          return extracted;
        }
      } catch {
        // Fall through and treat the raw string as a command-like value.
      }
    }

    return trimmed;
  }

  if (Array.isArray(value)) {
    const stringParts = value
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
    if (stringParts.length > 0) {
      return stringParts.join(" ");
    }

    for (const item of value) {
      const extracted = extractNestedCommandString(item, depth + 1);
      if (extracted) {
        return extracted;
      }
    }
    return null;
  }

  if (typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = [
    "command",
    "commandLine",
    "command_line",
    "cmd",
    "script",
    "input",
    "text",
    "args",
    "arguments",
    "commandText",
    "command_text"
  ];

  for (const key of preferredKeys) {
    const extracted = extractNestedCommandString(record[key], depth + 1);
    if (extracted) {
      return extracted;
    }
  }

  for (const nestedValue of Object.values(record)) {
    const extracted = extractNestedCommandString(nestedValue, depth + 1);
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

type InitHookTarget = "copilot-vs" | "copilot-cli" | "codex";

function parseInitHookTargets(args: string[]): InitHookTarget[] {
  const explicitTargets = new Set<InitHookTarget>();
  const hooksValue = optionValue(args, "--hooks");

  if (hooksValue) {
    for (const rawItem of hooksValue.split(",")) {
      const item = rawItem.trim().toLowerCase();
      if (!item) {
        continue;
      }

      if (item === "copilot" || item === "copilot-vs") {
        explicitTargets.add("copilot-vs");
        continue;
      }

      if (item === "copilot-cli") {
        explicitTargets.add("copilot-cli");
        continue;
      }

      if (item === "codex") {
        explicitTargets.add("codex");
        continue;
      }

      throw new Error(`Unknown hook target '${rawItem}'. Use codex, copilot-vs, or copilot-cli.`);
    }
  }

  if (args.includes("--copilot") || args.includes("--copilot-vs")) {
    explicitTargets.add("copilot-vs");
  }
  if (args.includes("--copilot-cli")) {
    explicitTargets.add("copilot-cli");
  }
  if (args.includes("--codex")) {
    explicitTargets.add("codex");
  }

  if (explicitTargets.size === 0) {
    return ["copilot-vs", "copilot-cli", "codex"];
  }

  return [...explicitTargets];
}

function extractVSCodeGuardCommand(input: VSCodeHookInput | null): string | null {
  const candidates: unknown[] = [
    input?.tool_input,
    input?.toolArgs,
    input?.tool_name === "shell" || input?.toolName === "shell" ? input : null,
    input?.tool_name === "powershell" || input?.toolName === "powershell" ? input : null,
    input
  ];

  for (const candidate of candidates) {
    const extracted = extractNestedCommandString(candidate);
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

function extractCodexGuardCommand(input: CodexHookInput | null): string | null {
  if (!input?.tool_input || typeof input.tool_input !== "object") {
    return null;
  }

  const toolInput = input.tool_input as Record<string, unknown>;
  const candidates = [
    toolInput.command,
    toolInput.cmd,
    toolInput.script,
    toolInput.args,
    toolInput.arguments
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

async function readStdInText(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

function emitCopilotHookResponse(_additionalContext?: string): void {
  // Copilot CLI does not require a wrapped success payload for non-decision hooks.
}

function emitCopilotGuardDecision(
  decision: "allow" | "ask" | "deny",
  reason: string,
  additionalContext?: string
): void {
  console.log(
    JSON.stringify({
      permissionDecision: decision,
      permissionDecisionReason: reason,
      ...(additionalContext ? { additionalContext } : {})
    })
  );
}

function emitCopilotPermissionRequestDecision(decision: "allow" | "deny", message?: string): void {
  console.log(
    JSON.stringify(
      decision === "allow"
        ? { behavior: "allow" }
        : {
            behavior: "deny",
            ...(message ? { message } : {})
          }
    )
  );
}

function emitCodexGuardDecision(
  decision: "allow" | "ask" | "deny",
  reason: string,
  additionalContext?: string
): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
        ...(additionalContext ? { additionalContext } : {})
      }
    })
  );
}

function emitCodexPermissionRequestDecision(decision: "allow" | "deny", message?: string): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision:
          decision === "allow"
            ? { behavior: "allow" }
            : {
                behavior: "deny",
                ...(message ? { message } : {})
              }
      }
    })
  );
}

async function runStreamingCommand(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: false
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function runCommandWithInput(command: string, cwd: string, input: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code ?? "unknown"}`));
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

async function runBufferedShellCommand(
  command: string,
  cwd: string
): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt
      });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findVerificationProfile(
  profiles: VerificationProfile[],
  profileId: string | null
): VerificationProfile | null {
  if (!profileId) {
    return null;
  }

  return profiles.find((profile) => profile.id === profileId) ?? null;
}

function summarizeVerificationResult(exitCode: number, stdout: string, stderr: string): string {
  if (exitCode === 0) {
    return "Command completed successfully.";
  }

  const combined = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return combined[0] ?? `Command failed with exit code ${exitCode}.`;
}

function buildCommandLogContent(
  label: string,
  checkpointId: string,
  commandValue: string,
  status: "passed" | "failed",
  exitCode: number,
  durationMs: number,
  stdout: string,
  stderr: string
): string {
  return [
    `label: ${label}`,
    `checkpoint: ${checkpointId}`,
    `command: ${commandValue}`,
    `status: ${status}`,
    `exitCode: ${exitCode}`,
    `durationMs: ${durationMs}`,
    "",
    "--- stdout ---",
    stdout.trimEnd(),
    "",
    "--- stderr ---",
    stderr.trimEnd(),
    ""
  ].join("\n");
}

async function persistVerificationResult(
  repositoryRoot: string,
  checkpointId: string,
  verificationName: string,
  commandValue: string,
  triggerPhase: "beforeCheckpoint" | "afterHook" | "afterCheckpoint" | "manual",
  result: { exitCode: number; stdout: string; stderr: string; durationMs: number }
): Promise<{
  status: "passed" | "failed";
  summary: string;
  durationMs: number;
  logFilePath: string;
  exitCode: number;
}> {
  const status = result.exitCode === 0 ? "passed" : "failed";
  const summary = summarizeVerificationResult(result.exitCode, result.stdout, result.stderr);
  const logFilePath = await writeVerificationLog(
    repositoryRoot,
    checkpointId,
    verificationName,
    buildCommandLogContent(
      verificationName,
      checkpointId,
      commandValue,
      status,
      result.exitCode,
      result.durationMs,
      result.stdout,
      result.stderr
    )
  );

  await appendGeneratedInsights(repositoryRoot, [
    {
      checkpointId,
      extensionId: `profile:${verificationName}`,
      insightType: "profile-run",
      title: `${verificationName}: ${status}`,
      body: summary,
      createdAt: new Date().toISOString(),
      source: "builtin",
      metadata: {
        profile: verificationName,
        command: commandValue,
        status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        logFilePath
      }
    }
  ]);

  await appendOrchestrationRunRecord(repositoryRoot, checkpointId, {
    actionId: verificationName,
    actionType: "runProfile",
    triggerPhase,
    status,
    summary,
    command: commandValue,
    durationMs: result.durationMs,
    logFilePath,
    metadata: {
      profile: verificationName,
      exitCode: result.exitCode
    }
  });

  return {
    status,
    summary,
    durationMs: result.durationMs,
    logFilePath,
    exitCode: result.exitCode
  };
}

async function persistRunCommandResult(
  repositoryRoot: string,
  checkpointId: string,
  actionId: string,
  commandValue: string,
  triggerPhase: "beforeCheckpoint" | "afterHook" | "afterCheckpoint",
  summaryLabel: string,
  result: { exitCode: number; stdout: string; stderr: string; durationMs: number },
  metadata?: Record<string, unknown>
): Promise<{ status: "passed" | "failed"; summary: string; logFilePath: string }> {
  const status = result.exitCode === 0 ? "passed" : "failed";
  const summary = summarizeVerificationResult(result.exitCode, result.stdout, result.stderr);
  const logFilePath = await writeVerificationLog(
    repositoryRoot,
    checkpointId,
    actionId.replace(/[:/\\]+/g, "-"),
    buildCommandLogContent(
      summaryLabel,
      checkpointId,
      commandValue,
      status,
      result.exitCode,
      result.durationMs,
      result.stdout,
      result.stderr
    )
  );

  await appendOrchestrationRunRecord(repositoryRoot, checkpointId, {
    actionId,
    actionType: "runCommand",
    triggerPhase,
    status,
    summary,
    command: commandValue,
    durationMs: result.durationMs,
    logFilePath,
    metadata: {
      exitCode: result.exitCode,
      ...(metadata ?? {})
    }
  });

  return { status, summary, logFilePath };
}

async function appendOrchestrationRunRecord(
  repositoryRoot: string,
  checkpointId: string,
  options: {
    actionId: string;
    actionType: "runExtension" | "runProfile" | "runVerification" | "runCommand";
    triggerPhase: "beforeCheckpoint" | "afterHook" | "afterCheckpoint" | "manual";
    status: "passed" | "failed";
    summary: string;
    command?: string;
    durationMs?: number;
    logFilePath?: string;
    error?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await appendGeneratedInsights(repositoryRoot, [
    {
      checkpointId,
      extensionId: `orchestration:${options.actionId}`,
      insightType: "orchestration-run",
      title: `${options.actionType}: ${options.status}`,
      body: options.summary,
      createdAt: new Date().toISOString(),
      source: "builtin",
      metadata: {
        actionId: options.actionId,
        actionType: options.actionType,
        triggerPhase: options.triggerPhase,
        status: options.status,
        command: options.command,
        durationMs: options.durationMs,
        logFilePath: options.logFilePath,
        error: options.error,
        ...(options.metadata ?? {})
      }
    }
  ]);
}

async function dirtyWorkspaceSignature(repositoryRoot: string, files: string[]): Promise<string> {
  const hash = createHash("sha256");

  for (const filePath of [...files].sort()) {
    hash.update(filePath);
    hash.update("\0");

    const absolutePath = path.join(repositoryRoot, filePath);
    if (!existsSync(absolutePath)) {
      hash.update("<missing>");
      hash.update("\0");
      continue;
    }

    try {
      const content = await readFile(absolutePath);
      hash.update(content);
    } catch {
      hash.update("<unreadable>");
    }

    hash.update("\0");
  }

  return hash.digest("hex");
}

function launchExtensionProcessor(repositoryRoot: string): void {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    return;
  }

  const child = spawn(process.execPath, [...process.execArgv, scriptPath, "__process-extensions"], {
    cwd: repositoryRoot,
    stdio: "ignore",
    detached: true,
    windowsHide: true
  });
  child.unref();
}

function launchHookOrchestrationProcessor(repositoryRoot: string): void {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    return;
  }

  const child = spawn(process.execPath, [...process.execArgv, scriptPath, "__process-hook-orchestration"], {
    cwd: repositoryRoot,
    stdio: "ignore",
    detached: true,
    windowsHide: true
  });
  child.unref();
}

async function runExtensionForCheckpoint(
  repositoryRoot: string,
  store: CheckpointStore,
  checkpointId: string,
  extensionId: string,
  triggerPhase: "afterHook" | "afterCheckpoint"
): Promise<void> {
  const checkpoint = await store.findCheckpoint(checkpointId);
  if (!checkpoint) {
    throw new Error(`Checkpoint ${checkpointId} was not found for extension ${extensionId}.`);
  }

  const config = await loadOrchestrationConfig(repositoryRoot);
  const extension = config.afterCheckpoint.extensions.find((item) => item.enabled && item.id === extensionId);
  if (!extension) {
    throw new Error(`Enabled extension ${extensionId} was not found in orchestration config.`);
  }

  const payload: ExtensionCheckpointPayload = {
    version: 1,
    repositoryRoot,
    checkpoint
  };

  const stdout = await runCommandWithInput(extension.command, repositoryRoot, JSON.stringify(payload));
  const parsed = stdout ? (JSON.parse(stdout) as ExtensionRunnerOutput) : { insights: [] };
  const insights = (parsed.insights ?? [])
    .filter((item) => item && typeof item.type === "string" && typeof item.title === "string" && typeof item.body === "string")
    .map((item) => ({
      checkpointId,
      extensionId: extension.id,
      insightType: item.type,
      title: item.title,
      body: item.body,
      files: Array.isArray(item.files) ? item.files.filter((file): file is string => typeof file === "string") : undefined,
      createdAt: new Date().toISOString(),
      source: "extension" as const
    }));

  await appendGeneratedInsights(repositoryRoot, insights);
  await appendOrchestrationRunRecord(repositoryRoot, checkpointId, {
    actionId: extension.id,
    actionType: "runExtension",
    triggerPhase,
    status: "passed",
    summary:
      insights.length > 0
        ? `Extension ${extension.id} generated ${insights.length} insight${insights.length === 1 ? "" : "s"}.`
        : `Extension ${extension.id} completed without emitting structured insights.`,
    command: extension.command,
    metadata: {
      emittedInsightCount: insights.length
    }
  });
}

async function runVerificationAgainstCheckpoint(
  repositoryRoot: string,
  checkpointId: string,
  verificationName: string,
  commandValue: string,
  triggerPhase: "beforeCheckpoint" | "afterHook" | "afterCheckpoint" | "manual"
): Promise<{
  status: "passed" | "failed";
  summary: string;
  durationMs: number;
  logFilePath: string;
  exitCode: number;
}> {
  const result = await runBufferedShellCommand(commandValue, repositoryRoot);
  return persistVerificationResult(
    repositoryRoot,
    checkpointId,
    verificationName,
    commandValue,
    triggerPhase,
    result
  );
}

async function runHookOrchestrationActions(
  repositoryRoot: string,
  store: CheckpointStore,
  event: HookOrchestrationEvent
): Promise<void> {
  const config = await loadOrchestrationConfig(repositoryRoot);
  const matchingRules = config.afterHook.rules.filter(
    (rule) => rule.mode === "background" && matchesAfterHookRule(rule, event)
  );

  for (const rule of matchingRules) {
    for (const action of rule.actions) {
      try {
        if (action.type === "runCommand") {
          const command = action.command;
          if (!command) {
            throw new Error(`Rule ${rule.id} is missing a command for runCommand.`);
          }

          const result = await runBufferedShellCommand(command, repositoryRoot);
          const status = result.exitCode === 0 ? "passed" : "failed";
          const summary = summarizeVerificationResult(result.exitCode, result.stdout, result.stderr);
          const logFilePath = await writeVerificationLog(
            repositoryRoot,
            event.checkpointId ?? "hook-context",
            `orchestration-${rule.id}-${action.type}`,
            [
              `rule: ${rule.id}`,
              `hook: ${event.host}:${event.event}`,
              `command: ${command}`,
              `status: ${status}`,
              `exitCode: ${result.exitCode}`,
              `durationMs: ${result.durationMs}`,
              "",
              "--- stdout ---",
              result.stdout.trimEnd(),
              "",
              "--- stderr ---",
              result.stderr.trimEnd(),
              ""
            ].join("\n")
          );

          await appendOrchestrationRunRecord(repositoryRoot, event.checkpointId ?? "hook-context", {
            actionId: `${rule.id}:${action.type}`,
            actionType: "runCommand",
            triggerPhase: "afterHook",
            status,
            summary,
            command,
            durationMs: result.durationMs,
            logFilePath,
            metadata: {
              host: event.host,
              event: event.event,
              ruleId: rule.id,
              files: event.files,
              exitCode: result.exitCode
            }
          });

          if (status === "failed") {
            break;
          }
          continue;
        }

        if (!event.checkpointId) {
          throw new Error(`Rule ${rule.id} action ${action.type} requires checkpoint context.`);
        }

        if (action.type === "runProfile" || action.type === "runVerification") {
          const profileId = action.profile;
          const profile = config.afterCheckpoint.verifications.profiles.find((item) => item.id === profileId);
          if (!profileId || !profile) {
            throw new Error(`Rule ${rule.id} references missing profile ${profileId ?? "unknown"}.`);
          }
          const result = await runVerificationAgainstCheckpoint(
            repositoryRoot,
            event.checkpointId,
            profile.id,
            profile.command,
            "afterHook"
          );
          if (result.status === "failed") {
            break;
          }
          continue;
        }

        if (action.type === "runExtension") {
          const extensionId = action.extensionId;
          if (!extensionId) {
            throw new Error(`Rule ${rule.id} is missing extensionId for runExtension.`);
          }
          await runExtensionForCheckpoint(repositoryRoot, store, event.checkpointId, extensionId, "afterHook");
          continue;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendOrchestrationRunRecord(repositoryRoot, event.checkpointId ?? "hook-context", {
          actionId: `${rule.id}:${action.type}`,
          actionType: action.type,
          triggerPhase: "afterHook",
          status: "failed",
          summary: `Hook orchestration rule ${rule.id} failed while running ${action.type}.`,
          command: action.command,
          error: message,
          metadata: {
            host: event.host,
            event: event.event,
            ruleId: rule.id,
            files: event.files,
            profile: action.profile,
            extensionId: action.extensionId
          }
        });
        break;
      }
    }
  }
}

type PreparedBeforeCheckpointAction =
  | {
      kind: "runCommand";
      actionId: string;
      ruleId: string;
      command: string;
      result: { exitCode: number; stdout: string; stderr: string; durationMs: number };
      files: string[];
    }
  | {
      kind: "runProfile";
      actionId: string;
      ruleId: string;
      profile: string;
      command: string;
      result: { exitCode: number; stdout: string; stderr: string; durationMs: number };
      files: string[];
    };

async function runBeforeCheckpointBlockingActions(
  repositoryRoot: string,
  files: string[]
): Promise<PreparedBeforeCheckpointAction[]> {
  const config = await loadOrchestrationConfig(repositoryRoot);
  const prepared: PreparedBeforeCheckpointAction[] = [];
  const matchingRules = config.beforeCheckpoint.rules.filter(
    (rule) => rule.mode === "blocking" && matchesAfterCheckpointRule(rule, files)
  );

  for (const rule of matchingRules) {
    for (const action of rule.actions) {
      if (action.type === "runExtension") {
        throw new Error(`beforeCheckpoint rule ${rule.id} cannot run extensions before checkpoint creation.`);
      }

      if (action.type === "runCommand") {
        const command = action.command;
        if (!command) {
          throw new Error(`beforeCheckpoint rule ${rule.id} is missing a command for runCommand.`);
        }

        const result = await runBufferedShellCommand(command, repositoryRoot);
        prepared.push({
          kind: "runCommand",
          actionId: `${rule.id}:${action.type}`,
          ruleId: rule.id,
          command,
          result,
          files
        });
        if (result.exitCode !== 0) {
          throw new Error(`beforeCheckpoint rule ${rule.id} failed while running ${command}.`);
        }
        continue;
      }

      const profileId = action.profile;
      const profile = config.afterCheckpoint.verifications.profiles.find((item) => item.id === profileId);
      if (!profileId || !profile) {
        throw new Error(`beforeCheckpoint rule ${rule.id} references missing profile ${profileId ?? "<missing>"}.`);
      }

      const result = await runBufferedShellCommand(profile.command, repositoryRoot);
      prepared.push({
        kind: "runProfile",
        actionId: `${rule.id}:${action.type}`,
        ruleId: rule.id,
        profile: profile.id,
        command: profile.command,
        result,
        files
      });
      if (result.exitCode !== 0) {
        throw new Error(`beforeCheckpoint rule ${rule.id} failed while running profile ${profile.id}.`);
      }
    }
  }

  return prepared;
}

async function persistPreparedBeforeCheckpointActions(
  repositoryRoot: string,
  checkpointId: string,
  prepared: PreparedBeforeCheckpointAction[]
): Promise<void> {
  for (const action of prepared) {
    if (action.kind === "runCommand") {
      await persistRunCommandResult(
        repositoryRoot,
        checkpointId,
        action.actionId,
        action.command,
        "beforeCheckpoint",
        action.ruleId,
        action.result,
        {
          checkpointId,
          ruleId: action.ruleId,
          files: action.files
        }
      );
      continue;
    }

    await persistVerificationResult(
      repositoryRoot,
      checkpointId,
      action.profile,
      action.command,
      "beforeCheckpoint",
      action.result
    );
  }
}

async function runAfterCheckpointBlockingActions(
  repositoryRoot: string,
  store: CheckpointStore,
  checkpointId: string
): Promise<void> {
  const checkpoint = await store.findCheckpoint(checkpointId);
  if (!checkpoint) {
    return;
  }

  const config = await loadOrchestrationConfig(repositoryRoot);
  const matchingRules = config.afterCheckpoint.rules.filter(
    (rule) => rule.mode === "blocking" && matchesAfterCheckpointRule(rule, checkpoint.filesChanged)
  );

  for (const rule of matchingRules) {
    for (const action of rule.actions) {
      if (action.type === "runCommand") {
        const command = action.command;
        if (!command) {
          throw new Error(`Rule ${rule.id} is missing a command for runCommand.`);
        }

        const result = await runBufferedShellCommand(command, repositoryRoot);
        const persisted = await persistRunCommandResult(
          repositoryRoot,
          checkpointId,
          `${rule.id}:${action.type}`,
          command,
          "afterCheckpoint",
          rule.id,
          result,
          {
            checkpointId,
            ruleId: rule.id,
            files: checkpoint.filesChanged
          }
        );
        if (persisted.status === "failed") {
          throw new Error(`Rule ${rule.id} failed while running ${command}.`);
        }
        continue;
      }

      if (action.type === "runProfile" || action.type === "runVerification") {
        const profileId = action.profile;
        const profile = config.afterCheckpoint.verifications.profiles.find((item) => item.id === profileId);
        if (!profileId || !profile) {
          throw new Error(`Rule ${rule.id} references missing profile ${profileId ?? "<missing>"}.`);
        }
        const result = await runVerificationAgainstCheckpoint(
          repositoryRoot,
          checkpointId,
          profile.id,
          profile.command,
          "afterCheckpoint"
        );
        if (result.status === "failed") {
          throw new Error(`Rule ${rule.id} failed while running profile ${profile.id}.`);
        }
        continue;
      }

      const extensionId = action.extensionId;
      if (!extensionId) {
        throw new Error(`Rule ${rule.id} is missing extensionId for runExtension.`);
      }
      await runExtensionForCheckpoint(repositoryRoot, store, checkpointId, extensionId, "afterCheckpoint");
    }
  }
}

async function runAfterCheckpointActions(
  repositoryRoot: string,
  store: CheckpointStore,
  checkpointId: string
): Promise<void> {
  const checkpoint = await store.findCheckpoint(checkpointId);
  if (!checkpoint) {
    return;
  }

  const config = await loadOrchestrationConfig(repositoryRoot);
  const beforeCheckpointRules = config.beforeCheckpoint.rules.filter(
    (rule) => rule.mode === "background" && matchesAfterCheckpointRule(rule, checkpoint.filesChanged)
  );
  const matchingRules = config.afterCheckpoint.rules.filter(
    (rule) => rule.mode === "background" && matchesAfterCheckpointRule(rule, checkpoint.filesChanged)
  );
  const enabledLegacyExtensions = config.afterCheckpoint.extensions.filter((extension) => extension.enabled);

  if (beforeCheckpointRules.length === 0 && matchingRules.length === 0 && enabledLegacyExtensions.length === 0) {
    return;
  }

  for (const rule of beforeCheckpointRules) {
    for (const action of rule.actions) {
      try {
        if (action.type === "runExtension") {
          throw new Error(`beforeCheckpoint rule ${rule.id} cannot run extensions without checkpoint context preparation.`);
        }

        if (action.type === "runCommand") {
          const command = action.command;
          if (!command) {
            throw new Error(`Rule ${rule.id} is missing a command for runCommand.`);
          }

          const result = await runBufferedShellCommand(command, repositoryRoot);
          await persistRunCommandResult(
            repositoryRoot,
            checkpointId,
            `${rule.id}:${action.type}`,
            command,
            "beforeCheckpoint",
            rule.id,
            result,
            {
              checkpointId,
              ruleId: rule.id,
              files: checkpoint.filesChanged
            }
          );
          if (result.exitCode !== 0) {
            break;
          }
          continue;
        }

        const profileId = action.profile;
        const profile = config.afterCheckpoint.verifications.profiles.find((item) => item.id === profileId);
        if (!profileId || !profile) {
          throw new Error(`Rule ${rule.id} references missing profile ${profileId ?? "<missing>"}.`);
        }

        const result = await runVerificationAgainstCheckpoint(
          repositoryRoot,
          checkpointId,
          profile.id,
          profile.command,
          "beforeCheckpoint"
        );
        if (result.status === "failed") {
          break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendOrchestrationRunRecord(repositoryRoot, checkpointId, {
          actionId: `${rule.id}:${action.type}`,
          actionType: action.type,
          triggerPhase: "beforeCheckpoint",
          status: "failed",
          summary: `Rule ${rule.id} failed during beforeCheckpoint background processing.`,
          command: action.command,
          error: message,
          metadata: {
            checkpointId,
            ruleId: rule.id,
            files: checkpoint.filesChanged,
            profile: action.profile,
            extensionId: action.extensionId
          }
        });
        break;
      }
    }
  }

  for (const rule of matchingRules) {
    for (const action of rule.actions) {
      try {
        if (action.type === "runCommand") {
          const command = action.command;
          if (!command) {
            throw new Error(`Rule ${rule.id} is missing a command for runCommand.`);
          }

          const result = await runBufferedShellCommand(command, repositoryRoot);
          const status = result.exitCode === 0 ? "passed" : "failed";
          const summary = summarizeVerificationResult(result.exitCode, result.stdout, result.stderr);
          const logFilePath = await writeVerificationLog(
            repositoryRoot,
            checkpointId,
            `orchestration-${rule.id}-${action.type}`,
            [
              `rule: ${rule.id}`,
              `checkpoint: ${checkpointId}`,
              `command: ${command}`,
              `status: ${status}`,
              `exitCode: ${result.exitCode}`,
              `durationMs: ${result.durationMs}`,
              "",
              "--- stdout ---",
              result.stdout.trimEnd(),
              "",
              "--- stderr ---",
              result.stderr.trimEnd(),
              ""
            ].join("\n")
          );

          await appendOrchestrationRunRecord(repositoryRoot, checkpointId, {
            actionId: `${rule.id}:${action.type}`,
            actionType: "runCommand",
            triggerPhase: "afterCheckpoint",
            status,
            summary,
            command,
            durationMs: result.durationMs,
            logFilePath,
            metadata: {
              checkpointId,
              ruleId: rule.id,
              files: checkpoint.filesChanged
            }
          });
        } else if (action.type === "runProfile" || action.type === "runVerification") {
          const profileId = action.profile;
          const profile = config.afterCheckpoint.verifications.profiles.find((item) => item.id === profileId);
          if (!profileId || !profile) {
            throw new Error(`Rule ${rule.id} references missing profile ${profileId ?? "<missing>"}.`);
          }

          await runVerificationAgainstCheckpoint(
            repositoryRoot,
            checkpointId,
            profile.id,
            profile.command,
            "afterCheckpoint"
          );
        } else if (action.type === "runExtension") {
          const extensionId = action.extensionId;
          if (!extensionId) {
            throw new Error(`Rule ${rule.id} is missing extensionId for runExtension.`);
          }

          await runExtensionForCheckpoint(repositoryRoot, store, checkpointId, extensionId, "afterCheckpoint");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendOrchestrationRunRecord(repositoryRoot, checkpointId, {
          actionId: `${rule.id}:${action.type}`,
          actionType: action.type,
          triggerPhase: "afterCheckpoint",
          status: "failed",
          summary: `Rule ${rule.id} failed during afterCheckpoint processing.`,
          command: action.command,
          error: message,
          metadata: {
            checkpointId,
            ruleId: rule.id,
            files: checkpoint.filesChanged,
            profile: action.profile,
            extensionId: action.extensionId
          }
        });
        break;
      }
    }
  }

  for (const extension of enabledLegacyExtensions) {
    const alreadyHandledByRule = matchingRules.some((rule) =>
      rule.actions.some((action) => action.type === "runExtension" && action.extensionId === extension.id)
    );
    if (alreadyHandledByRule) {
      continue;
    }

    try {
      await runExtensionForCheckpoint(repositoryRoot, store, checkpointId, extension.id, "afterCheckpoint");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendOrchestrationRunRecord(repositoryRoot, checkpointId, {
        actionId: extension.id,
        actionType: "runExtension",
        triggerPhase: "afterCheckpoint",
        status: "failed",
        summary: `Extension ${extension.id} failed during afterCheckpoint processing.`,
        command: extension.command,
        error: message
      });
    }
  }
}

async function gitStatusFiles(cwd: string, ignoreRules?: AnvilIgnoreRules): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["status", "--short", "--untracked-files=all"], {
    cwd,
    windowsHide: true
  });

  return filterIgnoredAnvilPaths(
    stdout
    .replace(/\r?\n$/, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const filePart = line.length >= 4 ? line.slice(3).trim() : line.trim();
      const renameParts = filePart.split(" -> ");
      return renameParts.at(-1)?.trim() ?? filePart.trim();
    }),
    ignoreRules
  );
}

async function gitStatusSnapshot(
  cwd: string,
  ignoreRules?: AnvilIgnoreRules
): Promise<{ visible: string[]; ignored: string[] }> {
  const { stdout } = await execFileAsync("git", ["status", "--short", "--untracked-files=all"], {
    cwd,
    windowsHide: true
  });

  const paths = stdout
    .replace(/\r?\n$/, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const filePart = line.length >= 4 ? line.slice(3).trim() : line.trim();
      const renameParts = filePart.split(" -> ");
      return renameParts.at(-1)?.trim() ?? filePart.trim();
    });

  return {
    visible: filterIgnoredAnvilPaths(paths, ignoreRules),
    ignored: collectIgnoredAnvilPaths(paths, ignoreRules).filter(
      (filePath) =>
        !filePath.startsWith(".anvil/") &&
        filePath !== ".anvilignore" &&
        filePath !== ".github/hooks/anvil-copilot-vs.json" &&
        filePath !== ".github/hooks/anvil-copilot-cli.json" &&
        filePath !== ".codex/hooks.json"
    )
  };
}

async function resolvedBranchLabel(store: CheckpointStore): Promise<string> {
  return (await store.currentBranch()) ?? "unknown";
}

function printRepositoryContext(repositoryRoot: string, launchCwd: string, branch: string): void {
  console.log(`Repo root: ${repositoryRoot}`);
  if (repositoryRoot !== launchCwd) {
    console.log(`Launched from: ${launchCwd}`);
  }
  console.log(`Branch: ${branch}`);
}

function formatStatusLine(label: string, value: string): string {
  return `${label}: ${value}`;
}

function normalizeHookFilePathForRepo(repositoryRoot: string, filePath: string): string {
  const normalizedRepositoryRoot = path.resolve(repositoryRoot).replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedFilePath = path.resolve(filePath).replace(/\\/g, "/");

  if (
    normalizedFilePath.length > normalizedRepositoryRoot.length &&
    normalizedFilePath.startsWith(`${normalizedRepositoryRoot}/`)
  ) {
    return normalizedFilePath.slice(normalizedRepositoryRoot.length + 1);
  }

  return filePath.replace(/\\/g, "/");
}

function normalizeHookFilePathsForRepo(repositoryRoot: string, filePaths: string[]): string[] {
  return filePaths.map((filePath) => normalizeHookFilePathForRepo(repositoryRoot, filePath));
}

async function commandExists(commandName: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      await execFileAsync("where", [commandName], { windowsHide: true });
    } else {
      await execFileAsync("which", [commandName]);
    }
    return true;
  } catch {
    return false;
  }
}

async function printHookStatus(
  repositoryRoot: string,
  launchCwd: string,
  store: CheckpointStore,
  ignoreRules?: AnvilIgnoreRules
): Promise<void> {
  const branch = await resolvedBranchLabel(store);
  const config = await loadHookConfig(repositoryRoot);
  const policy = await loadExecutionGuardPolicy(repositoryRoot);
  const hookConfigFile = hookConfigPath(repositoryRoot);
  const copilotVsHookFile = vscodeCopilotHookConfigPath(repositoryRoot);
  const copilotCliHookFile = copilotCliHookConfigPath(repositoryRoot);
  const codexHookFile = codexHookConfigPath(repositoryRoot);
  const policyFile = path.join(repositoryRoot, ".anvil", "policy.yaml");
  const orchestrationFile = path.join(repositoryRoot, ".anvil", "orchestration.yaml");
  const guardScriptFile = executionGuardScriptPath(repositoryRoot);
  const codexPromptWrapperFile = codexPromptWrapperPath(repositoryRoot);
  const copilotVsPromptWrapperFile = path.join(repositoryRoot, ".anvil", "anvil-copilot-vs-prompt-submit.mjs");
  const copilotCliPromptWrapperFile = copilotCliPromptWrapperPath(repositoryRoot);
  const hookWrapperErrorFile = hookWrapperErrorLogPath(repositoryRoot);
  const anvilIgnoreFile = path.join(repositoryRoot, ".anvilignore");
  const ignorePatternCount = ignoreRules?.patterns.length ?? 0;
  const gitStatus = await gitStatusSnapshot(repositoryRoot, ignoreRules);
  const copilotCliRequiresPwsh = process.platform === "win32";
  const pwshAvailable = copilotCliRequiresPwsh ? await commandExists("pwsh") : true;

  const copilotVsReady = existsSync(copilotVsHookFile) && Boolean(config.copilotVs?.autoCheckpoint);
  const copilotCliReady =
    existsSync(copilotCliHookFile) && Boolean(config.copilotCli?.autoCheckpoint) && pwshAvailable;
  const codexReady = existsSync(codexHookFile) && Boolean(config.codex?.autoCheckpoint);
  const executionGuardReady =
    existsSync(copilotVsHookFile) &&
    existsSync(copilotCliHookFile) &&
    existsSync(codexHookFile) &&
    existsSync(guardScriptFile) &&
    policy.enabled;
  const lastHookExecution = await readLastHookExecutionLog(repositoryRoot);

  console.log("Anvil hook status\n");
  printRepositoryContext(repositoryRoot, launchCwd, branch);
  console.log("");
  console.log("Hook config");
  console.log(`  ${formatStatusLine(".anvil/hooks.yaml", existsSync(hookConfigFile) ? "present" : "missing")}`);
  console.log(`  ${formatStatusLine(".anvil/policy.yaml", existsSync(policyFile) ? "present" : "missing")}`);
  console.log(`  ${formatStatusLine(".anvil/orchestration.yaml", existsSync(orchestrationFile) ? "present" : "missing")}`);
  console.log(`  ${formatStatusLine(".anvil/anvil-execution-guard.mjs", existsSync(guardScriptFile) ? "present" : "missing")}`);
  console.log(`  ${formatStatusLine(".anvil/anvil-codex-prompt-submit.mjs", existsSync(codexPromptWrapperFile) ? "present" : "missing")}`);
  console.log(`  ${formatStatusLine(".anvil/anvil-copilot-vs-prompt-submit.mjs", existsSync(copilotVsPromptWrapperFile) ? "present" : "missing")}`);
  console.log(`  ${formatStatusLine(".anvil/anvil-copilot-cli-prompt-submit.mjs", existsSync(copilotCliPromptWrapperFile) ? "present" : "missing")}`);
  console.log(`  ${formatStatusLine(".anvil/hook-wrapper-errors.log", existsSync(hookWrapperErrorFile) ? "present" : "missing")}`);
  console.log(`  ${formatStatusLine("copilotVs.autoCheckpoint", String(config.copilotVs?.autoCheckpoint ?? false))}`);
  console.log(`  ${formatStatusLine("copilotCli.autoCheckpoint", String(config.copilotCli?.autoCheckpoint ?? false))}`);
  if (copilotCliRequiresPwsh) {
    console.log(`  ${formatStatusLine("copilotCli.pwshAvailable", pwshAvailable ? "true" : "false")}`);
  }
  console.log(`  ${formatStatusLine("codex.autoCheckpoint", String(config.codex?.autoCheckpoint ?? false))}`);
  console.log(`  ${formatStatusLine("executionGuard.enabled", String(policy.enabled))}`);
  console.log(
    `  ${formatStatusLine(
      "executionGuard.enforcementMode",
      policy.askAsDeny
        ? "codex: strict (ask -> deny), copilotVs: host-ask, copilotCli: host-ask"
        : "codex: host-ask, copilotVs: host-ask, copilotCli: host-ask"
    )}`
  );
  console.log("");
  console.log("Installed hook files");
  console.log(`  ${formatStatusLine(".github/hooks/anvil-copilot-vs.json", existsSync(copilotVsHookFile) ? "present" : "missing")}`);
  console.log(`  ${formatStatusLine(".github/hooks/anvil-copilot-cli.json", existsSync(copilotCliHookFile) ? "present" : "missing")}`);
  console.log(`  ${formatStatusLine(".codex/hooks.json", existsSync(codexHookFile) ? "present" : "missing")}`);
  console.log("");
  console.log("Ignore rules");
  console.log(`  ${formatStatusLine(".anvilignore", existsSync(anvilIgnoreFile) ? "present" : "missing")}`);
  console.log(`  ${formatStatusLine("active custom ignore patterns", String(ignorePatternCount))}`);
  if (ignoreRules?.patterns.length) {
    console.log(`  ${formatStatusLine("patterns", ignoreRules.patterns.map((rule) => rule.raw).join(", "))}`);
  }
  console.log(`  ${formatStatusLine("currently ignored dirty paths", String(gitStatus.ignored.length))}`);
  if (gitStatus.ignored.length) {
    console.log(`  ${formatStatusLine("ignored paths", gitStatus.ignored.join(", "))}`);
  }
  console.log("");
  console.log("Ready state");
  console.log(`  ${formatStatusLine("Copilot VS hook ready", copilotVsReady ? "yes" : "no")}`);
  console.log(`  ${formatStatusLine("Copilot CLI hook ready", copilotCliReady ? "yes" : "no")}`);
  console.log(`  ${formatStatusLine("Codex hook ready", codexReady ? "yes" : "no")}`);
  console.log(`  ${formatStatusLine("Execution guard ready", executionGuardReady ? "yes" : "no")}`);
  console.log("");
  console.log("Last hook execution");
  if (lastHookExecution) {
    console.log(`  ${formatStatusLine("time", lastHookExecution.timestamp)}`);
    console.log(`  ${formatStatusLine("hook", lastHookExecution.hookName)}`);
    console.log(`  ${formatStatusLine("mode", lastHookExecution.mode)}`);
    console.log(`  ${formatStatusLine("status", lastHookExecution.status)}`);
    if (lastHookExecution.branch) {
      console.log(`  ${formatStatusLine("branch", lastHookExecution.branch)}`);
    }
    if (lastHookExecution.checkpointId) {
      console.log(`  ${formatStatusLine("checkpoint", lastHookExecution.checkpointId)}`);
    }
    if (lastHookExecution.files?.length) {
      console.log(`  ${formatStatusLine("files", lastHookExecution.files.join(", "))}`);
    }
    if (lastHookExecution.message) {
      console.log(`  ${formatStatusLine("message", lastHookExecution.message)}`);
    }
  } else {
    console.log("  none");
  }
  console.log("");
  console.log("Notes");
  console.log("  Hooks only auto-checkpoint when the host actually executes them and autoCheckpoint is true.");
  if (copilotCliRequiresPwsh && !pwshAvailable) {
    console.log("  Copilot CLI on Windows requires PowerShell 7+ (`pwsh`) for the generated hook commands.");
  }
  console.log("  If a hook looks installed but nothing fires, verify the editor/agent supports repo hooks in that session.");
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const launchCwd = process.cwd();

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const globalInstall = command === "install" && (args.includes("-g") || args.includes("--global"));
  const globalUninstall = command === "uninstall" && (args.includes("-g") || args.includes("--global"));
  const repositoryRoot = globalInstall || globalUninstall ? launchCwd : (await getRepositoryRoot(launchCwd)) ?? launchCwd;
  const ignoreRules = globalInstall || globalUninstall ? undefined : await loadAnvilIgnoreRules(repositoryRoot);
  const store = new CheckpointStore(repositoryRoot);

  switch (command) {
    case "init": {
      await store.init();
      const config = await store.loadConfig();
      const pwshAvailable = process.platform === "win32" ? await commandExists("pwsh") : true;
      const selectedHookTargets = parseInitHookTargets(args);
      const installedHookPaths: string[] = [];
      if (selectedHookTargets.includes("copilot-vs")) {
        installedHookPaths.push(`Copilot VS hook: ${await installCopilotVsHook(repositoryRoot)}`);
      }
      if (selectedHookTargets.includes("copilot-cli")) {
        installedHookPaths.push(`Copilot CLI hook: ${await installCopilotCliHook(repositoryRoot)}`);
      }
      if (selectedHookTargets.includes("codex")) {
        installedHookPaths.push(`Codex hook: ${await installCodexHook(repositoryRoot)}`);
      }
      const hookConfigPath = await ensureHookConfigTemplate(repositoryRoot);
      const policyTemplate = await ensurePolicyTemplate(repositoryRoot);
      const orchestrationTemplate = await ensureOrchestrationTemplate(repositoryRoot);
      const anvilIgnore = await ensureAnvilIgnoreTemplate(repositoryRoot);
      console.log(`Anvil initialized for ${repositoryRoot}`);
      console.log(`State directory: ${path.dirname(config.shadowGitDir)}`);
      console.log(`Shadow store: ${config.shadowGitDir}`);
      console.log(`Metadata: ${config.metadataFile}`);
      console.log(`Anvil ignore: ${anvilIgnore.filePath}`);
      for (const line of installedHookPaths) {
        console.log(line);
      }
      console.log(`Hook config: ${hookConfigPath}`);
      console.log(`Execution policy: ${policyTemplate.filePath}`);
      console.log(`Orchestration config: ${orchestrationTemplate.filePath}`);
      if (orchestrationTemplate.migratedFromLegacy) {
        console.log("Orchestration config was created by migrating the legacy .anvil/extensions.yaml file.");
      }
      if (anvilIgnore.source === "gitignore") {
        console.log("Anvil ignore was created by copying .gitignore.");
      } else if (anvilIgnore.source === "starter") {
        console.log("Anvil ignore was created with a starter template because .gitignore was not found.");
      }
      const selectedLabel =
        selectedHookTargets.length === 3
          ? "Copilot VS, Copilot CLI, and Codex"
          : selectedHookTargets
              .map((target) =>
                target === "copilot-vs" ? "Copilot VS" : target === "copilot-cli" ? "Copilot CLI" : "Codex"
              )
              .join(", ");
      const selectedVerb = selectedHookTargets.length === 1 ? "remains" : "remain";
      console.log(`${selectedLabel} auto-checkpoint ${selectedVerb} disabled until you set autoCheckpoint: true in .anvil/hooks.yaml.`);
      console.log("Execution safety remains disabled until you set executionGuard.enabled: true in .anvil/policy.yaml.");
      if (process.platform === "win32" && !pwshAvailable && selectedHookTargets.includes("copilot-cli")) {
        console.log("Copilot CLI prerequisite warning: PowerShell 7+ (`pwsh`) is not installed or not on PATH, so Windows Copilot CLI hooks will not run yet.");
      }
      return;
    }

    case "install": {
      if (!(args.includes("-g") || args.includes("--global"))) {
        throw new Error("install currently supports only -g or --global");
      }

      await runStreamingCommand(npmCommand(), ["install"], repositoryRoot);
      await runStreamingCommand(npmCommand(), ["run", "build:all"], repositoryRoot);
      await runStreamingCommand(npmCommand(), ["link"], repositoryRoot);
      console.log("Anvil installed globally.");
      return;
    }

    case "install-copilot-hook": {
      await store.init();
      const hookPath = await installCopilotVsHook(repositoryRoot);
      const hookConfigPath = await ensureHookConfigTemplate(repositoryRoot);
      const policyTemplate = await ensurePolicyTemplate(repositoryRoot);
      const orchestrationTemplate = await ensureOrchestrationTemplate(repositoryRoot);
      console.log(`Installed Copilot VS hook at ${hookPath}`);
      console.log("Compatibility note: `install-copilot-hook` currently refreshes the Copilot VS setup. Use `install-copilot-cli-hook` for Copilot CLI.");
      console.log(`Hook config: ${hookConfigPath}`);
      console.log(`Execution policy: ${policyTemplate.filePath}`);
      console.log(`Orchestration config: ${orchestrationTemplate.filePath}`);
      if (orchestrationTemplate.migratedFromLegacy) {
        console.log("Orchestration config was created by migrating the legacy .anvil/extensions.yaml file.");
      }
      console.log("Enable .anvil/hooks.yaml to allow automatic Anvil checkpoints after Copilot VS file edits.");
      return;
    }

    case "install-copilot-vs-hook": {
      await store.init();
      const hookPath = await installCopilotVsHook(repositoryRoot);
      const hookConfigPath = await ensureHookConfigTemplate(repositoryRoot);
      const policyTemplate = await ensurePolicyTemplate(repositoryRoot);
      const orchestrationTemplate = await ensureOrchestrationTemplate(repositoryRoot);
      console.log(`Installed Copilot VS hook at ${hookPath}`);
      console.log(`Hook config: ${hookConfigPath}`);
      console.log(`Execution policy: ${policyTemplate.filePath}`);
      console.log(`Orchestration config: ${orchestrationTemplate.filePath}`);
      if (orchestrationTemplate.migratedFromLegacy) {
        console.log("Orchestration config was created by migrating the legacy .anvil/extensions.yaml file.");
      }
      console.log("Enable .anvil/hooks.yaml to allow automatic Anvil checkpoints after Copilot VS file edits.");
      return;
    }

    case "install-copilot-cli-hook": {
      await store.init();
      const pwshAvailable = process.platform === "win32" ? await commandExists("pwsh") : true;
      const hookPath = await installCopilotCliHook(repositoryRoot);
      const hookConfigPath = await ensureHookConfigTemplate(repositoryRoot);
      const policyTemplate = await ensurePolicyTemplate(repositoryRoot);
      const orchestrationTemplate = await ensureOrchestrationTemplate(repositoryRoot);
      console.log(`Installed Copilot CLI hook at ${hookPath}`);
      console.log(`Hook config: ${hookConfigPath}`);
      console.log(`Execution policy: ${policyTemplate.filePath}`);
      console.log(`Orchestration config: ${orchestrationTemplate.filePath}`);
      if (orchestrationTemplate.migratedFromLegacy) {
        console.log("Orchestration config was created by migrating the legacy .anvil/extensions.yaml file.");
      }
      console.log("Enable .anvil/hooks.yaml to allow automatic Anvil checkpoints after Copilot CLI file edits.");
      if (process.platform === "win32" && !pwshAvailable) {
        console.log("Prerequisite warning: PowerShell 7+ (`pwsh`) is not installed or not on PATH, so Copilot CLI hooks will not run on Windows until it is available.");
      }
      return;
    }

    case "install-codex-hook": {
      await store.init();
      const hookPath = await installCodexHook(repositoryRoot);
      const hookConfigPath = await ensureHookConfigTemplate(repositoryRoot);
      const policyTemplate = await ensurePolicyTemplate(repositoryRoot);
      const orchestrationTemplate = await ensureOrchestrationTemplate(repositoryRoot);
      console.log(`Installed Codex hook at ${hookPath}`);
      console.log(`Hook config: ${hookConfigPath}`);
      console.log(`Execution policy: ${policyTemplate.filePath}`);
      console.log(`Orchestration config: ${orchestrationTemplate.filePath}`);
      if (orchestrationTemplate.migratedFromLegacy) {
        console.log("Orchestration config was created by migrating the legacy .anvil/extensions.yaml file.");
      }
      console.log("Enable .anvil/hooks.yaml to allow automatic Anvil checkpoints after Codex file edits.");
      return;
    }

    case "repair-baseline": {
      await store.init();
      const result = await store.repairCurrentBranchBaseline();
      console.log(`Repaired Anvil baseline for branch ${result.branch}.`);
      console.log(`Shadow ref: ${result.shadowRef}`);
      console.log(`Baseline commit: ${result.baselineSha}`);
      if (result.updatedCheckpointId) {
        console.log(`Updated first checkpoint: ${result.updatedCheckpointId}`);
      } else {
        console.log("No checkpoints existed on this branch yet; the shadow ref now points at the repaired baseline.");
      }
      return;
    }

    case "guard": {
      if (args[0] !== "evaluate") {
        throw new Error("Unknown guard command. Supported: evaluate");
      }

      await store.init();
      const copilotVsHookMode = args.includes("--copilot-vs-hook") || args.includes("--vscode-hook");
      const copilotCliHookMode = args.includes("--copilot-cli-hook") || args.includes("--copilot-hook");
      const copilotHookMode = copilotVsHookMode || copilotCliHookMode;
      const codexHookMode = args.includes("--codex-hook");
      const forcedPermissionRequest = args.includes("--permission-request");
      const hookMode = copilotVsHookMode ? "copilot-vs-hook" : copilotCliHookMode ? "copilot-cli-hook" : codexHookMode ? "codex-hook" : "cli";
      const stdInText = copilotHookMode || codexHookMode ? await readStdInText() : "";
      let vscodeHookInput: VSCodeHookInput | null = null;
      let codexHookInput: CodexHookInput | null = null;

      if (copilotHookMode && stdInText) {
        try {
          vscodeHookInput = JSON.parse(stdInText) as VSCodeHookInput;
        } catch {
          await appendHookExecutionLog(repositoryRoot, {
            timestamp: new Date().toISOString(),
            hookName: copilotCliHookMode ? "copilot-cli-pre-tool-use" : "copilot-vs-pre-tool-use",
            status: "invalid_payload",
            mode: hookMode,
            message: "Could not parse Copilot CLI hook payload."
          });
          const isPermissionRequestPayload = stdInText.includes("\"hook_event_name\":\"PermissionRequest\"") || stdInText.includes("\"hookEventName\":\"PermissionRequest\"");
          if (isPermissionRequestPayload) {
            emitCopilotPermissionRequestDecision("deny", "Anvil execution guard could not parse the tool payload.");
          } else {
            emitCopilotGuardDecision("deny", "Anvil execution guard could not parse the tool payload.");
          }
          return;
        }
      }

      if (codexHookMode && stdInText) {
        try {
          codexHookInput = JSON.parse(stdInText) as CodexHookInput;
        } catch {
          await appendHookExecutionLog(repositoryRoot, {
            timestamp: new Date().toISOString(),
            hookName: "codex-hook-parse",
            status: "invalid_payload",
            mode: hookMode,
            message: "Could not parse Codex PreToolUse payload."
          });
          const isPermissionRequestPayload = stdInText.includes("\"hook_event_name\":\"PermissionRequest\"");
          if (isPermissionRequestPayload) {
            emitCodexPermissionRequestDecision("deny", "Anvil execution guard could not parse the tool payload.");
          } else {
            emitCodexGuardDecision("deny", "Anvil execution guard could not parse the tool payload.");
          }
          return;
        }
      }

      const copilotEventName = vscodeHookInput?.hookEventName ?? vscodeHookInput?.hook_event_name;
      const isCopilotPermissionRequest =
        copilotHookMode && (forcedPermissionRequest || copilotEventName === "PermissionRequest" || copilotEventName === "permissionRequest");
      const isCodexPermissionRequest = codexHookMode && codexHookInput?.hook_event_name === "PermissionRequest";
      const toolName = vscodeHookInput?.tool_name ?? codexHookInput?.tool_name ?? "unknown";
      const commandText = copilotHookMode
        ? extractVSCodeGuardCommand(vscodeHookInput)
        : codexHookMode
          ? extractCodexGuardCommand(codexHookInput)
          : optionValue(args, "--command");
      const filePaths = copilotHookMode
        ? extractHookFilePaths(vscodeHookInput)
        : codexHookMode
          ? extractCodexHookFilePaths(codexHookInput)
          : parsePathList(optionValue(args, "--files"));
      const policy = await loadExecutionGuardPolicy(repositoryRoot);
      const evaluation = evaluateExecutionGuard(policy, {
        toolName,
        commandText,
        filePaths
      });
      const hookName = isCopilotPermissionRequest
        ? (copilotCliHookMode ? "copilot-cli-permission-request" : "copilot-vs-permission-request")
        : copilotHookMode
          ? (copilotCliHookMode ? "copilot-cli-pre-tool-use" : "copilot-vs-pre-tool-use")
        : isCodexPermissionRequest
          ? "codex-permission-request"
          : "codex-pre-tool-use";
      await appendHookExecutionLog(repositoryRoot, {
        timestamp: new Date().toISOString(),
        hookName,
        status:
          evaluation.decision === "allow"
            ? "allowed"
            : evaluation.decision === "ask"
              ? "asked"
              : "denied",
        mode: hookMode,
        branch: await resolvedBranchLabel(store),
        files: filePaths.length > 0 ? filePaths : undefined,
        message: `${evaluation.category}: ${evaluation.reason} ${evaluation.nextStep}`.trim()
      });
      await appendPendingHookOrchestrationEvent(repositoryRoot, {
        hookName,
        host: copilotCliHookMode ? "copilotCli" : copilotVsHookMode ? "copilotVs" : "codex",
        event: isCopilotPermissionRequest || isCodexPermissionRequest ? "PermissionRequest" : "PreToolUse",
        files: filePaths,
        timestamp: new Date().toISOString()
      });
      launchHookOrchestrationProcessor(repositoryRoot);

        const explanation = `${evaluation.category}: ${evaluation.reason}`;
        const additionalContext = `${evaluation.reason} ${evaluation.nextStep}`.trim();
        if (copilotHookMode) {
          const copilotExternalDecision =
            evaluation.decision === "ask" && policy.askAsDeny
              ? "deny"
              : evaluation.decision;
          if (isCopilotPermissionRequest) {
            if (copilotExternalDecision === "deny") {
              emitCopilotPermissionRequestDecision("deny", evaluation.reason);
            } else if (copilotExternalDecision === "allow") {
              emitCopilotPermissionRequestDecision("allow");
            }
            return;
          }

          emitCopilotGuardDecision(copilotExternalDecision, explanation, additionalContext);
          return;
        }

      if (codexHookMode) {
        const codexExternalDecision =
          evaluation.decision === "ask" && policy.askAsDeny
            ? "deny"
            : evaluation.decision;

        if (isCodexPermissionRequest) {
          if (evaluation.decision === "deny") {
            emitCodexPermissionRequestDecision("deny", evaluation.reason);
          } else if (evaluation.decision === "allow") {
            emitCodexPermissionRequestDecision("allow");
          }
          return;
        }

        if (evaluation.decision === "ask" && !policy.askAsDeny) {
          return;
        }

        emitCodexGuardDecision(codexExternalDecision, explanation, additionalContext);
        return;
      }

      console.log(`${evaluation.decision.toUpperCase()} ${evaluation.category}: ${evaluation.reason}`);
      console.log(evaluation.nextStep);
      return;
    }

    case "__process-extensions": {
      await store.init();
      const checkpointIds = await consumePendingExtensionEvents(repositoryRoot);
      for (const checkpointId of checkpointIds) {
        await runAfterCheckpointActions(repositoryRoot, store, checkpointId);
      }
      return;
    }

    case "__process-hook-orchestration": {
      await store.init();
      const events = await consumePendingHookOrchestrationEvents(repositoryRoot);
      for (const event of events) {
        await runHookOrchestrationActions(repositoryRoot, store, event);
      }
      return;
    }

    case "uninstall": {
      if (args.includes("-g") || args.includes("--global")) {
        try {
          await runStreamingCommand(npmCommand(), ["uninstall", "-g", "anvil"], repositoryRoot);
        } catch {
          await runStreamingCommand(npmCommand(), ["unlink", "-g", "anvil"], repositoryRoot);
        }
        console.log("Removed global Anvil CLI.");
        return;
      }

      await store.uninstall();
      console.log(`Removed Anvil state from ${repositoryRoot}`);
      return;
    }

    case "compact": {
      await store.init();
      const mode = (optionValue(args, "--mode") ?? "keep-last") as "keep-last" | "squash";
      if (mode !== "keep-last" && mode !== "squash") {
        throw new Error('compact requires --mode keep-last or --mode squash');
      }

      const result = await store.compactBranchHistory(mode);
      if (!result) {
        console.log("No Anvil checkpoints exist on the current branch.");
        return;
      }

      console.log(`Compacted Anvil history on ${result.gitBranch ?? "unknown"} using mode ${mode}.`);
      console.log(`Retained checkpoint: ${result.checkpointId}`);
      return;
    }

    case "prune": {
      await store.init();
      const dryRun = args.includes("--dry-run");
      const maxCheckpointsPerBranchValue = optionValue(args, "--max-checkpoints-per-branch");
      const maxHookLogsValue = optionValue(args, "--max-hook-logs");
      const result = await store.prune({
        dryRun,
        maxCheckpointsPerBranch: maxCheckpointsPerBranchValue ? Number(maxCheckpointsPerBranchValue) : undefined,
        maxHookLogs: maxHookLogsValue ? Number(maxHookLogsValue) : undefined
      });

      console.log(dryRun ? "Anvil prune dry run" : "Anvil prune complete");
      console.log(`Max checkpoints per branch: ${result.maxCheckpointsPerBranch}`);
      console.log(`Max hook logs: ${result.maxHookLogs}`);
      console.log(`Checkpoints removed: ${result.checkpointsRemoved}`);
      console.log(`Hook log entries removed: ${result.hookLogsRemoved}`);
      console.log(
        `Affected branches: ${result.affectedBranches.length > 0 ? result.affectedBranches.join(", ") : "none"}`
      );
      return;
    }

    case "hook": {
      const hookName = args[0];
      if (hookName === "status" || hookName === "doctor") {
        await printHookStatus(repositoryRoot, launchCwd, store, ignoreRules);
        return;
      }
      await store.init();
      if (
        hookName !== "copilot-after-edit" &&
        hookName !== "codex-after-edit" &&
        hookName !== "codex-prompt-submit" &&
        hookName !== "copilot-prompt-submit" &&
        hookName !== "copilot-vs-prompt-submit" &&
        hookName !== "copilot-cli-prompt-submit"
      ) {
        throw new Error(
          "Unknown hook. Supported hooks: status, doctor, copilot-after-edit, codex-after-edit, codex-prompt-submit, copilot-prompt-submit, copilot-vs-prompt-submit, copilot-cli-prompt-submit"
        );
      }

      const copilotVsHookMode = args.includes("--copilot-vs-hook") || args.includes("--vscode-hook");
      const copilotCliHookMode = args.includes("--copilot-cli-hook") || args.includes("--copilot-hook");
      const copilotHookMode = copilotVsHookMode || copilotCliHookMode;
      const codexHookMode = args.includes("--codex-hook");
      const hookMode = copilotVsHookMode ? "copilot-vs-hook" : copilotCliHookMode ? "copilot-cli-hook" : codexHookMode ? "codex-hook" : "cli";
      const stdInText = copilotHookMode || codexHookMode ? await readStdInText() : "";
      let vscodeHookInput: VSCodeHookInput | null = null;
      let codexHookInput: CodexHookInput | null = null;
      if (copilotHookMode && stdInText) {
        try {
          vscodeHookInput = JSON.parse(stdInText) as VSCodeHookInput;
        } catch {
          await appendHookExecutionLog(repositoryRoot, {
            timestamp: new Date().toISOString(),
            hookName,
            status: "invalid_payload",
            mode: hookMode,
            message: "Could not parse Copilot CLI hook payload."
          });
          emitCopilotHookResponse();
          return;
        }
      }
      if (codexHookMode && stdInText) {
        try {
          codexHookInput = JSON.parse(stdInText) as CodexHookInput;
        } catch {
          await appendHookExecutionLog(repositoryRoot, {
            timestamp: new Date().toISOString(),
            hookName,
            status: "invalid_payload",
            mode: hookMode,
            message: "Could not parse Codex hook payload."
          });
          return;
        }
      }

      if (hookName === "codex-prompt-submit") {
        if (codexHookMode && !isCodexPromptSubmitEvent(codexHookInput)) {
          await appendHookExecutionLog(repositoryRoot, {
            timestamp: new Date().toISOString(),
            hookName,
            status: "ignored",
            mode: hookMode,
            message: "Hook payload was not a Codex prompt-submit event."
          });
          return;
        }

        const config = await loadHookConfig(repositoryRoot);
        if (!config.codex?.autoCheckpoint) {
          await appendPendingHookOrchestrationEvent(repositoryRoot, {
            hookName,
            host: "codex",
            event: "UserPromptSubmit",
            files: [],
            timestamp: new Date().toISOString()
          });
          launchHookOrchestrationProcessor(repositoryRoot);
          await appendHookExecutionLog(repositoryRoot, {
            timestamp: new Date().toISOString(),
            hookName,
            status: "disabled",
            mode: hookMode,
            branch: await resolvedBranchLabel(store),
            message: "autoCheckpoint is disabled in .anvil/hooks.yaml."
          });
          return;
        }

        const prompt = optionValue(args, "--prompt") ?? extractCodexHookPrompt(codexHookInput);
        const rationale = optionValue(args, "--rationale") ?? extractCodexHookRationale(codexHookInput);
        if (!prompt) {
          await appendPendingHookOrchestrationEvent(repositoryRoot, {
            hookName,
            host: "codex",
            event: "UserPromptSubmit",
            files: [],
            timestamp: new Date().toISOString()
          });
          launchHookOrchestrationProcessor(repositoryRoot);
          await appendHookExecutionLog(repositoryRoot, {
            timestamp: new Date().toISOString(),
            hookName,
            status: "ignored",
            mode: hookMode,
            branch: await resolvedBranchLabel(store),
            message: "No prompt text was available to capture."
          });
          return;
        }

        await writePendingCodexPrompt(repositoryRoot, prompt, rationale);
        await appendHookExecutionLog(repositoryRoot, {
          timestamp: new Date().toISOString(),
          hookName,
          status: "captured",
          mode: hookMode,
          branch: await resolvedBranchLabel(store),
          message: "Captured Codex prompt for the next Anvil checkpoint."
        });
        await appendPendingHookOrchestrationEvent(repositoryRoot, {
          hookName,
          host: "codex",
          event: "UserPromptSubmit",
          files: [],
          timestamp: new Date().toISOString()
        });
        launchHookOrchestrationProcessor(repositoryRoot);
        if (!codexHookMode) {
          console.log("Captured Codex prompt for the next Anvil checkpoint.");
        }
        return;
      }

      if (
        hookName === "copilot-prompt-submit" ||
        hookName === "copilot-vs-prompt-submit" ||
        hookName === "copilot-cli-prompt-submit"
      ) {
        if (copilotHookMode && !isCopilotPromptSubmitEvent(vscodeHookInput)) {
          await appendHookExecutionLog(repositoryRoot, {
            timestamp: new Date().toISOString(),
            hookName,
            status: "ignored",
            mode: hookMode,
            message: "Hook payload was not a Copilot prompt-submit event."
          });
          emitCopilotHookResponse();
          return;
        }

        const config = await loadHookConfig(repositoryRoot);
        const copilotHookConfig = copilotCliHookMode ? config.copilotCli : config.copilotVs;
        if (!copilotHookConfig?.autoCheckpoint) {
          
          await appendPendingHookOrchestrationEvent(repositoryRoot, {
            hookName,
            host: copilotCliHookMode ? "copilotCli" : "copilotVs",
            event: "UserPromptSubmit",
            files: [],
            timestamp: new Date().toISOString()
          });
          launchHookOrchestrationProcessor(repositoryRoot);
          await appendHookExecutionLog(repositoryRoot, {
            timestamp: new Date().toISOString(),
            hookName,
            status: "disabled",
            mode: hookMode,
            branch: await resolvedBranchLabel(store),
            message: "autoCheckpoint is disabled in .anvil/hooks.yaml."
          });
          emitCopilotHookResponse();
          return;
        }

        const prompt = optionValue(args, "--prompt") ?? extractVSCodeHookPrompt(vscodeHookInput);
        const rationale = optionValue(args, "--rationale") ?? extractVSCodeHookRationale(vscodeHookInput);
        if (!prompt) {
          await appendPendingHookOrchestrationEvent(repositoryRoot, {
            hookName,
            host: copilotCliHookMode ? "copilotCli" : "copilotVs",
            event: "UserPromptSubmit",
            files: [],
            timestamp: new Date().toISOString()
          });
          launchHookOrchestrationProcessor(repositoryRoot);
          await appendHookExecutionLog(repositoryRoot, {
            timestamp: new Date().toISOString(),
            hookName,
            status: "ignored",
            mode: hookMode,
            branch: await resolvedBranchLabel(store),
            message: "No prompt text was available to capture."
          });
          emitCopilotHookResponse();
          return;
        }

        if (copilotCliHookMode) {
          await writePendingCopilotCliPrompt(repositoryRoot, prompt, rationale);
        } else {
          await writePendingCopilotPrompt(repositoryRoot, prompt, rationale);
        }
        await appendHookExecutionLog(repositoryRoot, {
          timestamp: new Date().toISOString(),
          hookName,
          status: "captured",
          mode: hookMode,
          branch: await resolvedBranchLabel(store),
          message: `Captured ${copilotCliHookMode ? "Copilot CLI" : "Copilot VS"} prompt for the next Anvil checkpoint.`
        });
        await appendPendingHookOrchestrationEvent(repositoryRoot, {
          hookName,
          host: copilotCliHookMode ? "copilotCli" : "copilotVs",
          event: "UserPromptSubmit",
          files: [],
          timestamp: new Date().toISOString()
        });
        launchHookOrchestrationProcessor(repositoryRoot);
        emitCopilotHookResponse(`Captured ${copilotCliHookMode ? "Copilot CLI" : "Copilot VS"} prompt for the next Anvil checkpoint.`);
        return;
      }

      if (copilotHookMode && !isCopilotFileEditEvent(vscodeHookInput)) {
        const copilotEventName = vscodeHookInput?.hookEventName ?? vscodeHookInput?.hook_event_name ?? "unknown";
        const copilotToolName = vscodeHookInput?.toolName ?? vscodeHookInput?.tool_name ?? "unknown";
        const extractedPaths = normalizeHookFilePathsForRepo(repositoryRoot, extractHookFilePaths(vscodeHookInput));
        await appendHookExecutionLog(repositoryRoot, {
          timestamp: new Date().toISOString(),
          hookName,
          status: "ignored",
          mode: hookMode,
          message: `Hook payload was not a Copilot file-edit event. event=${copilotEventName}; tool=${copilotToolName}; files=${extractedPaths.join(", ") || "none"}`
        });
        emitCopilotHookResponse();
        return;
      }
      if (codexHookMode && !isCodexFileEditEvent(codexHookInput)) {
        await appendHookExecutionLog(repositoryRoot, {
          timestamp: new Date().toISOString(),
          hookName,
          status: "ignored",
          mode: hookMode,
          message: "Hook payload was not a Codex file-edit event."
        });
        return;
      }

      const hookFiles = copilotHookMode
        ? extractHookFilePaths(vscodeHookInput)
        : codexHookMode
          ? (() => {
              const extracted = extractCodexHookFilePaths(codexHookInput);
              return extracted.length > 0 ? extracted : extractCodexHookFilePathsFromText(stdInText);
            })()
          : [];
      const normalizedHookFiles = normalizeHookFilePathsForRepo(repositoryRoot, hookFiles);

      const config = await loadHookConfig(repositoryRoot);
      const hookConfig =
        hookName === "copilot-after-edit"
          ? (copilotCliHookMode ? config.copilotCli : config.copilotVs)
          : config.codex;
      if (!hookConfig?.autoCheckpoint) {
        await appendPendingHookOrchestrationEvent(repositoryRoot, {
          hookName,
          host: hookName === "copilot-after-edit" ? (copilotCliHookMode ? "copilotCli" : "copilotVs") : "codex",
          event: "PostToolUse",
          files: normalizedHookFiles,
          timestamp: new Date().toISOString()
        });
        launchHookOrchestrationProcessor(repositoryRoot);
        await appendHookExecutionLog(repositoryRoot, {
          timestamp: new Date().toISOString(),
          hookName,
          status: "disabled",
          mode: hookMode,
          branch: await resolvedBranchLabel(store),
          message: "autoCheckpoint is disabled in .anvil/hooks.yaml."
        });
        if (copilotHookMode) {
          emitCopilotHookResponse();
          return;
        }
        if (codexHookMode) {
          return;
        }
        console.log(`${hookName} is disabled.`);
        return;
      }

      const defaultSummary =
        hookName === "copilot-after-edit"
          ? (copilotCliHookMode ? "Copilot CLI file changes" : "Copilot VS file changes")
          : "Codex file changes";
      const summary = optionValue(args, "--summary") ?? hookConfig.summary ?? defaultSummary;
      const kind = (optionValue(args, "--kind") ?? hookConfig.kind ?? "after_edit_batch") as CheckpointKind;
      const defaultCommand =
        hookName === "copilot-after-edit"
          ? (copilotCliHookMode ? "copilot-cli" : "copilot-vs")
          : "codex";
      const commandValue = optionValue(args, "--command") ?? hookConfig.command ?? defaultCommand;
      const pendingCodexPrompt = codexHookMode ? await readPendingCodexPrompt(repositoryRoot) : null;
      const pendingCopilotPrompt = copilotHookMode
        ? (copilotCliHookMode ? await readPendingCopilotCliPrompt(repositoryRoot) : await readPendingCopilotPrompt(repositoryRoot))
        : null;
      const rationale = optionValue(args, "--rationale")
        ?? (copilotHookMode ? extractVSCodeHookRationale(vscodeHookInput) : codexHookMode ? extractCodexHookRationale(codexHookInput) : null)
        ?? pendingCopilotPrompt?.rationale
        ?? pendingCodexPrompt?.rationale
        ?? undefined;
      const testStatus = (optionValue(args, "--test-status") ?? hookConfig.testStatus ?? "unknown") as
        | "unknown"
        | "passed"
        | "failed";
      const prompt = optionValue(args, "--prompt")
        ?? (copilotHookMode ? extractVSCodeHookPrompt(vscodeHookInput) : codexHookMode ? extractCodexHookPrompt(codexHookInput) : null)
        ?? pendingCopilotPrompt?.prompt
        ?? pendingCodexPrompt?.prompt
        ?? undefined;
      const statusFiles = await gitStatusFiles(repositoryRoot, ignoreRules);
      const files = copilotHookMode
        ? normalizedHookFiles.length > 0
          ? [...new Set(filterIgnoredAnvilPaths(normalizedHookFiles, ignoreRules))]
          : statusFiles
        : codexHookMode
          ? normalizedHookFiles.length > 0
            ? [...new Set(filterIgnoredAnvilPaths(normalizedHookFiles, ignoreRules))]
            : statusFiles
          : [...new Set(filterIgnoredAnvilPaths([...normalizedHookFiles, ...statusFiles], ignoreRules))];

      if (files.length === 0) {
        await appendHookExecutionLog(repositoryRoot, {
          timestamp: new Date().toISOString(),
          hookName,
          status: "no_changes",
          mode: hookMode,
          branch: await resolvedBranchLabel(store),
          message: "No Git-detected workspace changes were available to checkpoint."
        });
        if (copilotHookMode) {
          emitCopilotHookResponse();
          return;
        }
        if (codexHookMode) {
          return;
        }
        console.log("No workspace changes to checkpoint.");
        return;
      }

      const preparedBeforeCheckpoint = await runBeforeCheckpointBlockingActions(repositoryRoot, files);

      const checkpoint = await store.recordCheckpoint({
        kind,
        summary,
        snapshotMode: normalizedHookFiles.length > 0 ? "partial" : "full",
        filesChanged: files,
        origin: "ai",
        aiSource: hookName === "copilot-after-edit" ? (copilotCliHookMode ? "copilot-cli" : "copilot-vs") : "codex",
        prompt,
        rationale,
        commandsRun: commandValue ? [commandValue] : [],
        testStatus
      });

      await persistPreparedBeforeCheckpointActions(repositoryRoot, checkpoint.checkpointId, preparedBeforeCheckpoint);
      await runAfterCheckpointBlockingActions(repositoryRoot, store, checkpoint.checkpointId);

      if (copilotHookMode && (prompt || pendingCopilotPrompt?.prompt)) {
        if (copilotCliHookMode) {
          await clearPendingCopilotCliPrompt(repositoryRoot);
        } else {
          await clearPendingCopilotPrompt(repositoryRoot);
        }
      }
      if (codexHookMode && (prompt || pendingCodexPrompt?.prompt)) {
        await clearPendingCodexPrompt(repositoryRoot);
      }

      await appendHookExecutionLog(repositoryRoot, {
        timestamp: new Date().toISOString(),
        hookName,
        status: "recorded",
        mode: hookMode,
        branch: checkpoint.gitBranch ?? "unknown",
        checkpointId: checkpoint.checkpointId,
        files: checkpoint.filesChanged,
        message: `Recorded ${checkpoint.checkpointId}.`
      });
      await appendPendingHookOrchestrationEvent(repositoryRoot, {
        hookName,
        host: hookName === "copilot-after-edit" ? (copilotCliHookMode ? "copilotCli" : "copilotVs") : "codex",
        event: "PostToolUse",
        files: checkpoint.filesChanged,
        checkpointId: checkpoint.checkpointId,
        timestamp: new Date().toISOString()
      });
      launchHookOrchestrationProcessor(repositoryRoot);

      if (copilotHookMode) {
        launchExtensionProcessor(repositoryRoot);
        emitCopilotHookResponse(`Anvil recorded checkpoint ${checkpoint.checkpointId} on branch ${checkpoint.gitBranch ?? "unknown"}.`);
        return;
      }
      if (codexHookMode) {
        launchExtensionProcessor(repositoryRoot);
        return;
      }

      launchExtensionProcessor(repositoryRoot);
      console.log(`Recorded ${checkpoint.checkpointId}`);
      console.log(`Branch: ${checkpoint.gitBranch ?? "unknown"}`);
      console.log(`Shadow ref: ${checkpoint.shadowRef ?? "unknown"}`);
      console.log(`Files: ${checkpoint.filesChanged.join(", ")}`);
      return;
    }

    case "review": {
      await store.init();
      const port = optionValue(args, "--port") ?? process.env.ANVIL_PORT ?? "4312";
      const serverScript = path.join(__dirname, "server.js");
      console.log(`Starting Anvil review app for ${repositoryRoot}`);
      console.log(`Anvil will auto-initialize this repo if needed.`);
      console.log(`Open http://localhost:${port}/`);

      const child = spawn(process.execPath, [serverScript], {
        cwd: repositoryRoot,
        stdio: "inherit",
        env: {
          ...process.env,
          ANVIL_PORT: port
        },
        windowsHide: false
      });

      child.on("exit", (code) => {
        process.exitCode = code ?? 0;
      });
      return;
    }

    case "watch": {
      await store.init();
      const intervalMs = Number(optionValue(args, "--interval-ms") ?? "1500");
      const debounceMs = Number(optionValue(args, "--debounce-ms") ?? "2000");
      const summary = optionValue(args, "--summary") ?? "Watcher file changes";
      const kind = (optionValue(args, "--kind") ?? "after_edit_batch") as CheckpointKind;
      const commandValue = optionValue(args, "--command") ?? "watcher";
      const originValue = optionValue(args, "--origin");
      const aiSource = optionValue(args, "--ai-source");
      const testStatus = (optionValue(args, "--test-status") ?? "unknown") as "unknown" | "passed" | "failed";

      if (!Number.isFinite(intervalMs) || intervalMs < 250) {
        throw new Error("watch requires --interval-ms to be at least 250");
      }

      if (!Number.isFinite(debounceMs) || debounceMs < 250) {
        throw new Error("watch requires --debounce-ms to be at least 250");
      }

      let active = true;
      let pendingSignature: string | null = null;
      let pendingFiles: string[] = [];
      let pendingSince = 0;
      let lastRecordedSignature: string | null = null;

      const stopWatching = (): void => {
        active = false;
      };

      process.on("SIGINT", stopWatching);
      process.on("SIGTERM", stopWatching);

      console.log(`Watching ${repositoryRoot} for fallback Anvil checkpoints...`);
      console.log(`Interval: ${intervalMs}ms  Debounce: ${debounceMs}ms`);
      console.log("Press Ctrl+C to stop.");

      while (active) {
        try {
          const files = await gitStatusFiles(repositoryRoot, ignoreRules);

          if (files.length === 0) {
            pendingSignature = null;
            pendingFiles = [];
            pendingSince = 0;
            await delay(intervalMs);
            continue;
          }

          const signature = await dirtyWorkspaceSignature(repositoryRoot, files);
          if (signature === lastRecordedSignature) {
            await delay(intervalMs);
            continue;
          }

          if (signature !== pendingSignature) {
            pendingSignature = signature;
            pendingFiles = files;
            pendingSince = Date.now();
            await delay(intervalMs);
            continue;
          }

          if (Date.now() - pendingSince < debounceMs) {
            await delay(intervalMs);
            continue;
          }

          const preparedBeforeCheckpoint = await runBeforeCheckpointBlockingActions(repositoryRoot, pendingFiles);

          const checkpoint = await store.recordCheckpoint({
            kind,
            summary,
            snapshotMode: "partial",
            filesChanged: pendingFiles,
            origin: (originValue as "ai" | "manual" | null) ?? (aiSource ? "ai" : "manual"),
            aiSource: aiSource ?? null,
            commandsRun: commandValue ? [commandValue] : [],
            testStatus
          });

          await persistPreparedBeforeCheckpointActions(repositoryRoot, checkpoint.checkpointId, preparedBeforeCheckpoint);
          await runAfterCheckpointBlockingActions(repositoryRoot, store, checkpoint.checkpointId);

          launchExtensionProcessor(repositoryRoot);
          lastRecordedSignature = signature;
          pendingSignature = null;
          pendingFiles = [];
          pendingSince = 0;

          console.log(
            `[${formatTimestamp(checkpoint.timestamp)}] Recorded ${checkpoint.checkpointId} (${checkpoint.filesChanged.join(", ")})`
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Watcher error: ${message}`);
        }

        await delay(intervalMs);
      }

      process.off("SIGINT", stopWatching);
      process.off("SIGTERM", stopWatching);
      console.log("Watcher stopped.");
      return;
    }

    case "run":
    case "verify": {
      await store.init();
      const config = await loadOrchestrationConfig(repositoryRoot);
      const profileId = args[0] && !args[0].startsWith("-") ? args[0] : optionValue(args, "--name");
      const profile = findVerificationProfile(config.afterCheckpoint.verifications.profiles, profileId ?? null);
      const commandValue = optionValue(args, "--command") ?? profile?.command ?? null;
      const profileName = optionValue(args, "--name") ?? profile?.id ?? profileId ?? "custom";
      const checkpointId = optionValue(args, "--checkpoint");

      if (!commandValue) {
        throw new Error(`${command} requires a configured profile name or --command "..."`);
      }

      const checkpoint =
        checkpointId
          ? await store.findCheckpoint(checkpointId)
          : (await store.timeline()).checkpoints.at(-1) ?? null;

      if (!checkpoint) {
        throw new Error(
          checkpointId
            ? `Unknown checkpoint: ${checkpointId}`
            : "No checkpoint exists on the current branch yet. Record or restore a checkpoint first."
        );
      }

      const result = await runVerificationAgainstCheckpoint(
        repositoryRoot,
        checkpoint.checkpointId,
        profileName,
        commandValue,
        "manual"
      );

      console.log(`Profile ${profileName}: ${result.status}`);
      console.log(`Checkpoint: ${checkpoint.checkpointId}`);
      console.log(`Command: ${commandValue}`);
      console.log(`Duration: ${result.durationMs}ms`);
      console.log(`Summary: ${result.summary}`);
      console.log(`Log: ${result.logFilePath}`);
      if (command === "verify") {
        console.log('Alias note: `anvil verify` is supported for compatibility; prefer `anvil run <profile>`.');
      }
      return;
    }

    case "timeline": {
      await store.init();
      const timeline = await store.timeline();
      const checkpoints = timeline.checkpoints;
      if (checkpoints.length === 0) {
        console.log("No checkpoints recorded yet.");
        return;
      }

      console.log(`Branch: ${timeline.currentBranch ?? "unknown"}\n`);

      for (const checkpoint of checkpoints) {
        const files = checkpoint.filesChanged.length > 0 ? checkpoint.filesChanged.join(", ") : "no file delta";
        console.log(
          `${checkpoint.checkpointId}  ${formatTimestamp(checkpoint.timestamp)}  ${checkpoint.kind}\n  branch: ${checkpoint.gitBranch ?? "unknown"}\n  ${checkpoint.summary}\n  files: ${files}\n`
        );
      }
      return;
    }

    case "checkpoint": {
      await store.init();
      const summary = optionValue(args, "--summary");
      if (!summary) {
        throw new Error('checkpoint requires --summary "summary"');
      }

      const kind = optionValue(args, "--kind") ?? "after_edit_batch";
      const commandValue = optionValue(args, "--command");
      const prompt = optionValue(args, "--prompt");
      const rationale = optionValue(args, "--rationale");
      const originValue = optionValue(args, "--origin");
      const aiSource = optionValue(args, "--ai-source");
      const testStatus = optionValue(args, "--test-status") as "unknown" | "passed" | "failed" | null;
      const onlyPaths = parsePathList(optionValue(args, "--only"));
      const branch = await resolvedBranchLabel(store);
      const files =
        onlyPaths.length > 0
          ? filterIgnoredAnvilPaths(onlyPaths, ignoreRules)
          : await gitStatusFiles(repositoryRoot, ignoreRules);

      if (files.length === 0) {
        console.log("No Git-detected workspace changes to checkpoint.");
        printRepositoryContext(repositoryRoot, launchCwd, branch);
        console.log('Hint: run `git status --short` here to confirm which files Git sees.');
        return;
      }

      const preparedBeforeCheckpoint = await runBeforeCheckpointBlockingActions(repositoryRoot, files);

      const checkpoint = await store.recordCheckpoint({
        kind: kind as "after_edit_batch",
        summary,
        snapshotMode: onlyPaths.length > 0 ? "partial" : "full",
        filesChanged: files,
        origin: (originValue as "ai" | "manual" | null) ?? (prompt || rationale || aiSource ? "ai" : "manual"),
        aiSource: aiSource ?? null,
        commandsRun: commandValue ? [commandValue] : [],
        prompt: prompt ?? undefined,
        rationale: rationale ?? undefined,
        testStatus: testStatus ?? "unknown"
      });

      await persistPreparedBeforeCheckpointActions(repositoryRoot, checkpoint.checkpointId, preparedBeforeCheckpoint);
      await runAfterCheckpointBlockingActions(repositoryRoot, store, checkpoint.checkpointId);

      launchExtensionProcessor(repositoryRoot);
      console.log(`Recorded ${checkpoint.checkpointId}`);
      printRepositoryContext(repositoryRoot, launchCwd, checkpoint.gitBranch ?? branch);
      console.log(`Shadow ref: ${checkpoint.shadowRef ?? "unknown"}`);
      console.log(`Files: ${checkpoint.filesChanged.join(", ")}`);
      console.log(`Origin: ${checkpoint.origin}${checkpoint.aiSource ? ` (${checkpoint.aiSource})` : ""}`);
      if (checkpoint.rationale) {
        console.log(`Rationale: ${checkpoint.rationale}`);
      }
      if (checkpoint.bootstrappedFromBranch) {
        console.log(`Bootstrapped from branch: ${checkpoint.bootstrappedFromBranch}`);
      }
      if (checkpoint.bootstrappedFromCheckpointId) {
        console.log(`Bootstrapped from checkpoint: ${checkpoint.bootstrappedFromCheckpointId}`);
      }
      return;
    }

    case "diff": {
      await store.init();
      const [fromId, toId] = args;
      const diff = await store.diff(fromId, toId);
      console.log(diff);
      return;
    }

    case "restore": {
      await store.init();
      const checkpointId = args[0];
      if (!checkpointId) {
        throw new Error("restore requires a checkpoint id");
      }

      const restoreEvent = await store.restore(checkpointId);
      launchExtensionProcessor(repositoryRoot);
      console.log(`Workspace restored. Recorded ${restoreEvent.checkpointId}.`);
      return;
    }

    case "explain": {
      await store.init();
      const checkpointId = args[0];
      if (!checkpointId) {
        throw new Error("explain requires a checkpoint id");
      }

      const checkpoint = await store.explain(checkpointId);
      console.log(`${checkpoint.checkpointId} (${checkpoint.kind})`);
      console.log(`Time: ${formatTimestamp(checkpoint.timestamp)}`);
      console.log(`Branch: ${checkpoint.gitBranch ?? "unknown"}`);
      console.log(`Shadow ref: ${checkpoint.shadowRef ?? "unknown"}`);
      console.log(`Summary: ${checkpoint.summary}`);
      console.log(`Origin: ${checkpoint.origin}${checkpoint.aiSource ? ` (${checkpoint.aiSource})` : ""}`);
      if (checkpoint.rationale) {
        console.log(`Rationale: ${checkpoint.rationale}`);
      }
      if (checkpoint.prompt) {
        console.log(`Prompt: ${checkpoint.prompt}`);
      }
      console.log(`Files: ${checkpoint.filesChanged.join(", ") || "none"}`);
      console.log(`Prompt hash: ${checkpoint.promptHash ?? "none"}`);
      console.log(`Commands: ${checkpoint.commandsRun.join(" | ") || "none"}`);
      console.log(`Test status: ${checkpoint.testStatus}`);
      console.log(`Shadow commit: ${checkpoint.shadowCommitSha}`);
      if (checkpoint.bootstrappedFromBranch) {
        console.log(`Bootstrapped from branch: ${checkpoint.bootstrappedFromBranch}`);
      }
      if (checkpoint.bootstrappedFromCheckpointId) {
        console.log(`Bootstrapped from checkpoint: ${checkpoint.bootstrappedFromCheckpointId}`);
      }
      if (checkpoint.restoreSourceCheckpointId) {
        console.log(`Restore source: ${checkpoint.restoreSourceCheckpointId}`);
      }
      return;
    }

    case "assign-branch": {
      await store.init();
      const checkpointId = args[0];
      const branch = args[1] ?? (await store.currentBranch());
      if (!checkpointId) {
        throw new Error("assign-branch requires a checkpoint id");
      }
      if (!branch) {
        throw new Error("Could not determine a branch. Pass one explicitly.");
      }

      const checkpoint = await store.assignCheckpointBranch(checkpointId, branch);
      console.log(`Assigned ${checkpoint.checkpointId} to branch ${checkpoint.gitBranch}.`);
      return;
    }

    case "export": {
      await store.init();
      const previewOnly = args.includes("--preview");
      const message = optionValue(args, "--message") ?? "AI export";
      const result = await store.exportToGit(message, previewOnly);
      if (!previewOnly) {
        launchExtensionProcessor(repositoryRoot);
      }
      console.log(result);
      return;
    }

    case "__record": {
      await store.init();
      const kind = optionValue(args, "--kind");
      const summary = optionValue(args, "--summary");
      if (!kind || !summary) {
        throw new Error("__record requires --kind and --summary");
      }

      const files = optionValue(args, "--files");
      const commandValue = optionValue(args, "--command");
      const prompt = optionValue(args, "--prompt");
      const rationale = optionValue(args, "--rationale");
      const originValue = optionValue(args, "--origin");
      const aiSource = optionValue(args, "--ai-source");
      const testStatus = optionValue(args, "--test-status") as "unknown" | "passed" | "failed" | null;

      const recordFiles = files ? files.split(",").map((item) => item.trim()).filter(Boolean) : undefined;
      const preparedBeforeCheckpoint = await runBeforeCheckpointBlockingActions(repositoryRoot, recordFiles ?? []);

      const checkpoint = await store.recordCheckpoint({
        kind: kind as "after_edit_batch",
        summary,
        filesChanged: recordFiles,
        origin: (originValue as "ai" | "manual" | null) ?? (prompt || rationale || aiSource ? "ai" : "manual"),
        aiSource: aiSource ?? null,
        commandsRun: commandValue ? [commandValue] : [],
        prompt: prompt ?? undefined,
        rationale: rationale ?? undefined,
        testStatus: testStatus ?? "unknown"
      });

      await persistPreparedBeforeCheckpointActions(repositoryRoot, checkpoint.checkpointId, preparedBeforeCheckpoint);
      await runAfterCheckpointBlockingActions(repositoryRoot, store, checkpoint.checkpointId);

      launchExtensionProcessor(repositoryRoot);
      console.log(`Recorded ${checkpoint.checkpointId}`);
      return;
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
