import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { getCurrentBranch, runGit } from "./git.js";
import type { CheckpointMetadata, RecordCheckpointOptions, StoreConfig, TimelineResponse } from "./types.js";
import { checkpointNumber, ensureDir, hashText, readJson, writeJson } from "./utils.js";

const STORE_DIR_NAME = ".anvil";
const SHADOW_DIR_NAME = "store.git";
const METADATA_FILE_NAME = "metadata.jsonl";
const CONFIG_FILE_NAME = "config.json";

export class CheckpointStore {
  constructor(private readonly repositoryRoot: string) {}

  get baseDir(): string {
    return path.join(this.repositoryRoot, STORE_DIR_NAME);
  }

  get shadowGitDir(): string {
    return path.join(this.baseDir, SHADOW_DIR_NAME);
  }

  get metadataFile(): string {
    return path.join(this.baseDir, METADATA_FILE_NAME);
  }

  get configFile(): string {
    return path.join(this.baseDir, CONFIG_FILE_NAME);
  }

  async init(): Promise<StoreConfig> {
    await ensureDir(this.baseDir);

    const shadowHeadFile = path.join(this.shadowGitDir, "HEAD");
    if (!existsSync(shadowHeadFile)) {
      try {
        await runGit(["init", "--bare", this.shadowGitDir], this.repositoryRoot);
      } catch (error) {
        if (!existsSync(shadowHeadFile)) {
          throw error;
        }
      }
    }

    const config: StoreConfig = {
      version: 1,
      repositoryRoot: this.repositoryRoot,
      shadowGitDir: this.shadowGitDir,
      metadataFile: this.metadataFile
    };

    if (!existsSync(this.configFile)) {
      await writeJson(this.configFile, config);
    }

    if (!existsSync(this.metadataFile)) {
      await appendFile(this.metadataFile, "", "utf8");
    }

    return config;
  }

  async loadConfig(): Promise<StoreConfig> {
    const config = await readJson<StoreConfig>(this.configFile);
    if (!config) {
      return this.init();
    }

    return config;
  }

  async readMetadata(): Promise<CheckpointMetadata[]> {
    await this.loadConfig();
    const raw = await readFile(this.metadataFile, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parsed = JSON.parse(line) as Partial<CheckpointMetadata>;
        return {
          checkpointId: parsed.checkpointId ?? "unknown",
          timestamp: parsed.timestamp ?? new Date(0).toISOString(),
          kind: parsed.kind ?? "manual",
          gitBranch: parsed.gitBranch ?? null,
          parentCheckpointId: parsed.parentCheckpointId ?? null,
          shadowCommitSha: parsed.shadowCommitSha ?? "",
          filesChanged: parsed.filesChanged ?? [],
          summary: parsed.summary ?? "",
          promptHash: parsed.promptHash ?? null,
          commandsRun: parsed.commandsRun ?? [],
          testStatus: parsed.testStatus ?? "unknown",
          restoreSourceCheckpointId: parsed.restoreSourceCheckpointId ?? null
        } satisfies CheckpointMetadata;
      });
  }

  async latestCheckpointId(): Promise<string | null> {
    const checkpoints = await this.readMetadata();
    return checkpoints.at(-1)?.checkpointId ?? null;
  }

  async currentBranch(): Promise<string | null> {
    return getCurrentBranch(this.repositoryRoot);
  }

  async timeline(branch?: string | null): Promise<TimelineResponse> {
    const checkpoints = await this.readMetadata();
    const currentBranch = branch === undefined ? await this.currentBranch() : branch;

    if (!currentBranch) {
      return {
        currentBranch: null,
        checkpoints
      };
    }

    return {
      currentBranch,
      checkpoints: checkpoints.filter((entry) => entry.gitBranch === currentBranch || entry.gitBranch === null)
    };
  }

  async findCheckpoint(checkpointId: string): Promise<CheckpointMetadata | null> {
    const checkpoints = await this.readMetadata();
    return checkpoints.find((entry) => entry.checkpointId === checkpointId) ?? null;
  }

  async recordCheckpoint(options: RecordCheckpointOptions): Promise<CheckpointMetadata> {
    await this.loadConfig();

    const existing = await this.readMetadata();
    const parent = existing.at(-1) ?? null;
    const nextNumber = parent ? checkpointNumber(parent.checkpointId) + 1 : 1;
    const checkpointId = `cp-${nextNumber}`;
    const gitBranch = await this.currentBranch();

    await runGit(["add", "-A"], this.repositoryRoot, this.shadowGitDir);

    const commitMessage = `${checkpointId} ${options.kind}: ${options.summary}`;
    try {
      await runGit(
        [
          "-c",
          "user.name=anvil",
          "-c",
          "user.email=anvil@local",
          "commit",
          "--allow-empty",
          "-m",
          commitMessage
        ],
        this.repositoryRoot,
        this.shadowGitDir
      );
    } catch (error) {
      throw new Error(`Failed to create shadow checkpoint commit: ${String(error)}`);
    }

    const shadowCommitSha = await runGit(["rev-parse", "HEAD"], this.repositoryRoot, this.shadowGitDir);
    const filesChanged =
      options.filesChanged && options.filesChanged.length > 0
        ? options.filesChanged
        : (await runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", shadowCommitSha], this.repositoryRoot, this.shadowGitDir))
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

    const metadata: CheckpointMetadata = {
      checkpointId,
      timestamp: new Date().toISOString(),
      kind: options.kind,
      gitBranch,
      parentCheckpointId: parent?.checkpointId ?? null,
      shadowCommitSha,
      filesChanged,
      summary: options.summary,
      promptHash: hashText(options.prompt),
      commandsRun: options.commandsRun ?? [],
      testStatus: options.testStatus ?? "unknown",
      restoreSourceCheckpointId: options.restoreSourceCheckpointId ?? null
    };

    await appendFile(this.metadataFile, `${JSON.stringify(metadata)}\n`, "utf8");
    return metadata;
  }

  async diff(fromId?: string, toId?: string): Promise<string> {
    const checkpoints = await this.readMetadata();
    if (checkpoints.length === 0) {
      return "No checkpoints recorded yet.";
    }

    let fromSha: string | null = null;
    let toSha: string;

    if (!toId && fromId) {
      const target = checkpoints.find((entry) => entry.checkpointId === fromId);
      if (!target) {
        throw new Error(`Unknown checkpoint: ${fromId}`);
      }

      const index = checkpoints.findIndex((entry) => entry.checkpointId === fromId);
      fromSha = index > 0 ? checkpoints[index - 1].shadowCommitSha : null;
      toSha = target.shadowCommitSha;
    } else {
      const to = toId ? checkpoints.find((entry) => entry.checkpointId === toId) : checkpoints.at(-1);
      if (!to) {
        throw new Error(`Unknown checkpoint: ${toId}`);
      }

      toSha = to.shadowCommitSha;

      if (fromId) {
        const from = checkpoints.find((entry) => entry.checkpointId === fromId);
        if (!from) {
          throw new Error(`Unknown checkpoint: ${fromId}`);
        }

        fromSha = from.shadowCommitSha;
      }
    }

    if (!fromSha) {
      return runGit(["show", "--stat", "--patch", "--format=medium", toSha], this.repositoryRoot, this.shadowGitDir);
    }

    return runGit(["diff", `${fromSha}..${toSha}`], this.repositoryRoot, this.shadowGitDir);
  }

  async restore(checkpointId: string): Promise<CheckpointMetadata> {
    const checkpoint = await this.findCheckpoint(checkpointId);
    if (!checkpoint) {
      throw new Error(`Unknown checkpoint: ${checkpointId}`);
    }

    await this.recordCheckpoint({
      kind: "before_restore",
      summary: `Before restoring workspace to ${checkpointId}`,
      restoreSourceCheckpointId: checkpointId
    });

    await runGit(["checkout", checkpoint.shadowCommitSha, "--", "."], this.repositoryRoot, this.shadowGitDir);

    return this.recordCheckpoint({
      kind: "after_restore",
      summary: `Restored workspace files to ${checkpointId}`,
      restoreSourceCheckpointId: checkpointId
    });
  }

  async explain(checkpointId: string): Promise<CheckpointMetadata> {
    const checkpoint = await this.findCheckpoint(checkpointId);
    if (!checkpoint) {
      throw new Error(`Unknown checkpoint: ${checkpointId}`);
    }

    return checkpoint;
  }

  async exportToGit(message: string, previewOnly: boolean): Promise<string> {
    const checkpoints = await this.readMetadata();
    const latest = checkpoints.at(-1);
    if (!latest) {
      throw new Error("No checkpoints available to export.");
    }
    if (previewOnly) {
      const diff = await runGit(["diff", "--", "."], this.repositoryRoot);
      const status = await runGit(["status", "--short", "--untracked-files=all"], this.repositoryRoot);
      if (diff.length > 0) {
        return diff;
      }

      return status.length > 0 ? `Workspace changes to export:\n${status}` : "No workspace diff to export.";
    }

    await this.recordCheckpoint({
      kind: "before_export",
      summary: "Prepared current workspace for export to canonical Git",
      commandsRun: [`git commit -m "${message}"`]
    });

    await runGit(["add", "-A"], this.repositoryRoot);
    await runGit(
      ["-c", "user.name=anvil-export", "-c", "user.email=anvil-export@local", "commit", "-m", message],
      this.repositoryRoot
    );

    return `Exported ${latest.checkpointId} to real Git with message: ${message}`;
  }
}
