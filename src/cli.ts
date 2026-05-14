#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { CheckpointStore } from "./store.js";
import { formatTimestamp } from "./utils.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printHelp(): void {
  console.log(`anvil

Usage:
  anvil init
  anvil uninstall
  anvil compact --mode keep-last|squash
  anvil review [--port 4312]
  anvil timeline
  anvil checkpoint --summary "summary" [--kind after_edit_batch] [--command "npm test"] [--test-status passed|failed|unknown]
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

async function gitStatusFiles(cwd: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["status", "--short", "--untracked-files=all"], {
    cwd,
    windowsHide: true
  });

  return stdout
    .replace(/\r?\n$/, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const filePart = line.length >= 4 ? line.slice(3).trim() : line.trim();
      const renameParts = filePart.split(" -> ");
      return renameParts.at(-1)?.trim() ?? filePart.trim();
    })
    .filter((file) => file.length > 0 && !file.startsWith(".anvil"));
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const repositoryRoot = process.cwd();
  const store = new CheckpointStore(repositoryRoot);

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  switch (command) {
    case "init": {
      await store.init();
      const config = await store.loadConfig();
      console.log(`Anvil initialized for ${repositoryRoot}`);
      console.log(`State directory: ${path.dirname(config.shadowGitDir)}`);
      console.log(`Shadow store: ${config.shadowGitDir}`);
      console.log(`Metadata: ${config.metadataFile}`);
      return;
    }

    case "uninstall": {
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
      const files = await gitStatusFiles(repositoryRoot);

      if (files.length === 0) {
        console.log("No workspace changes to checkpoint.");
        return;
      }

      const checkpoint = await store.recordCheckpoint({
        kind: kind as "after_edit_batch",
        summary,
        filesChanged: files,
        commandsRun: commandValue ? [commandValue] : [],
        prompt: prompt ?? undefined,
        testStatus: testStatus ?? "unknown"
      });

      console.log(`Recorded ${checkpoint.checkpointId}`);
      console.log(`Branch: ${checkpoint.gitBranch ?? "unknown"}`);
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
