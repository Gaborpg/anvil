#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  type CodexHookInput,
  ensureHookConfigTemplate,
  extractHookFilePaths,
  installCodexHook,
  installVSCodeCopilotHook,
  isCodexFileEditEvent,
  isCopilotFileEditEvent,
  loadHookConfig,
  type VSCodeHookInput
} from "./hooks.js";
import { getRepositoryRoot } from "./git.js";
import { filterIgnoredAnvilPaths, loadAnvilIgnoreRules, type AnvilIgnoreRules } from "./ignore.js";
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
  anvil init
  anvil install -g
  anvil install-codex-hook
  anvil install-copilot-hook
  anvil uninstall
  anvil uninstall -g
  anvil compact --mode keep-last|squash
  anvil hook copilot-after-edit [--summary "summary"] [--kind after_edit_batch] [--command "copilot"] [--test-status passed|failed|unknown] [--vscode-hook]
  anvil hook codex-after-edit [--summary "summary"] [--kind after_edit_batch] [--command "codex"] [--test-status passed|failed|unknown] [--codex-hook]
  anvil review [--port 4312]
  anvil timeline
  anvil checkpoint --summary "summary" [--kind after_edit_batch] [--command "npm test"] [--test-status passed|failed|unknown] [--only path/a,path/b]
  anvil diff [checkpoint] [checkpoint]
  anvil restore <checkpoint>
  anvil explain <checkpoint>
  anvil assign-branch <checkpoint> [branch]
  anvil export [--preview] [--message "message"]

Internal:
  anvil __record --kind <kind> --summary "summary" [--files a,b] [--command "..."] [--prompt "..."] [--test-status passed|failed|unknown]
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

function emitVSCodeHookResponse(additionalContext?: string): void {
  const payload = additionalContext
    ? {
        continue: true,
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext
        }
      }
    : { continue: true };

  console.log(JSON.stringify(payload));
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
      const hookPath = await installVSCodeCopilotHook(repositoryRoot);
      const codexHookPath = await installCodexHook(repositoryRoot);
      const hookConfigPath = await ensureHookConfigTemplate(repositoryRoot);
      console.log(`Anvil initialized for ${repositoryRoot}`);
      console.log(`State directory: ${path.dirname(config.shadowGitDir)}`);
      console.log(`Shadow store: ${config.shadowGitDir}`);
      console.log(`Metadata: ${config.metadataFile}`);
      console.log(`Copilot hook: ${hookPath}`);
      console.log(`Codex hook: ${codexHookPath}`);
      console.log(`Hook config: ${hookConfigPath}`);
      console.log("Copilot and Codex auto-checkpoint remain disabled until you set autoCheckpoint: true in .anvil/hooks.yaml.");
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
      const hookPath = await installVSCodeCopilotHook(repositoryRoot);
      const hookConfigPath = await ensureHookConfigTemplate(repositoryRoot);
      console.log(`Installed VS Code Copilot hook at ${hookPath}`);
      console.log(`Hook config: ${hookConfigPath}`);
      console.log("Enable .anvil/hooks.yaml to allow automatic Anvil checkpoints after Copilot file edits.");
      return;
    }

    case "install-codex-hook": {
      await store.init();
      const hookPath = await installCodexHook(repositoryRoot);
      const hookConfigPath = await ensureHookConfigTemplate(repositoryRoot);
      console.log(`Installed Codex hook at ${hookPath}`);
      console.log(`Hook config: ${hookConfigPath}`);
      console.log("Enable .anvil/hooks.yaml to allow automatic Anvil checkpoints after Codex file edits.");
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

    case "hook": {
      await store.init();
      const hookName = args[0];
      if (hookName !== "copilot-after-edit" && hookName !== "codex-after-edit") {
        throw new Error("Unknown hook. Supported hooks: copilot-after-edit, codex-after-edit");
      }

      const vscodeHookMode = args.includes("--vscode-hook");
      const codexHookMode = args.includes("--codex-hook");
      const stdInText = vscodeHookMode || codexHookMode ? await readStdInText() : "";
      let vscodeHookInput: VSCodeHookInput | null = null;
      let codexHookInput: CodexHookInput | null = null;
      if (vscodeHookMode && stdInText) {
        try {
          vscodeHookInput = JSON.parse(stdInText) as VSCodeHookInput;
        } catch {
          emitVSCodeHookResponse();
          return;
        }
      }
      if (codexHookMode && stdInText) {
        try {
          codexHookInput = JSON.parse(stdInText) as CodexHookInput;
        } catch {
          return;
        }
      }

      if (vscodeHookMode && !isCopilotFileEditEvent(vscodeHookInput)) {
        emitVSCodeHookResponse();
        return;
      }
      if (codexHookMode && !isCodexFileEditEvent(codexHookInput)) {
        return;
      }

      const config = await loadHookConfig(repositoryRoot);
      const hookConfig = hookName === "copilot-after-edit" ? config.copilot : config.codex;
      if (!hookConfig?.autoCheckpoint) {
        if (vscodeHookMode) {
          emitVSCodeHookResponse();
          return;
        }
        if (codexHookMode) {
          return;
        }
        console.log(`${hookName} is disabled.`);
        return;
      }

      const defaultSummary = hookName === "copilot-after-edit" ? "Copilot file changes" : "Codex file changes";
      const summary = optionValue(args, "--summary") ?? hookConfig.summary ?? defaultSummary;
      const kind = (optionValue(args, "--kind") ?? hookConfig.kind ?? "after_edit_batch") as CheckpointKind;
      const defaultCommand = hookName === "copilot-after-edit" ? "copilot" : "codex";
      const commandValue = optionValue(args, "--command") ?? hookConfig.command ?? defaultCommand;
      const testStatus = (optionValue(args, "--test-status") ?? hookConfig.testStatus ?? "unknown") as
        | "unknown"
        | "passed"
        | "failed";
      const hookFiles = vscodeHookMode ? extractHookFilePaths(vscodeHookInput) : [];
      const statusFiles = await gitStatusFiles(repositoryRoot, ignoreRules);
      const files = [...new Set(filterIgnoredAnvilPaths([...hookFiles, ...statusFiles], ignoreRules))];

      if (files.length === 0) {
        if (vscodeHookMode) {
          emitVSCodeHookResponse();
          return;
        }
        if (codexHookMode) {
          return;
        }
        console.log("No workspace changes to checkpoint.");
        return;
      }

      const checkpoint = await store.recordCheckpoint({
        kind,
        summary,
        filesChanged: files,
        commandsRun: commandValue ? [commandValue] : [],
        testStatus
      });

      if (vscodeHookMode) {
        emitVSCodeHookResponse(`Anvil recorded checkpoint ${checkpoint.checkpointId} on branch ${checkpoint.gitBranch ?? "unknown"}.`);
        return;
      }
      if (codexHookMode) {
        return;
      }

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

      const checkpoint = await store.recordCheckpoint({
        kind: kind as "after_edit_batch",
        summary,
        snapshotMode: onlyPaths.length > 0 ? "partial" : "full",
        filesChanged: files,
        commandsRun: commandValue ? [commandValue] : [],
        prompt: prompt ?? undefined,
        testStatus: testStatus ?? "unknown"
      });

      console.log(`Recorded ${checkpoint.checkpointId}`);
      printRepositoryContext(repositoryRoot, launchCwd, checkpoint.gitBranch ?? branch);
      console.log(`Shadow ref: ${checkpoint.shadowRef ?? "unknown"}`);
      console.log(`Files: ${checkpoint.filesChanged.join(", ")}`);
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
      const testStatus = optionValue(args, "--test-status") as "unknown" | "passed" | "failed" | null;

      const checkpoint = await store.recordCheckpoint({
        kind: kind as "after_edit_batch",
        summary,
        filesChanged: files ? files.split(",").map((item) => item.trim()).filter(Boolean) : undefined,
        commandsRun: commandValue ? [commandValue] : [],
        prompt: prompt ?? undefined,
        testStatus: testStatus ?? "unknown"
      });

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
