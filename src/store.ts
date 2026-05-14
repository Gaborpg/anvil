import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { getCurrentBranch, getHeadReflogMessages, runGit } from "./git.js";
import type { CheckpointMetadata, RecordCheckpointOptions, StoreConfig, TimelineResponse } from "./types.js";
import { checkpointNumber, ensureDir, hashText, readJson, writeJson } from "./utils.js";

const STORE_DIR_NAME = ".anvil";
const SHADOW_DIR_NAME = "store.git";
const METADATA_FILE_NAME = "metadata.jsonl";
const CONFIG_FILE_NAME = "config.json";

interface ShadowBranchContext {
  branch: string;
  shadowRef: string;
  bootstrappedFromBranch: string | null;
  bootstrappedFromCheckpointId: string | null;
  bootstrappedAt: string | null;
}

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
          shadowRef: parsed.shadowRef ?? null,
          parentCheckpointId: parsed.parentCheckpointId ?? null,
          shadowCommitSha: parsed.shadowCommitSha ?? "",
          filesChanged: parsed.filesChanged ?? [],
          summary: parsed.summary ?? "",
          promptHash: parsed.promptHash ?? null,
          commandsRun: parsed.commandsRun ?? [],
          testStatus: parsed.testStatus ?? "unknown",
          restoreSourceCheckpointId: parsed.restoreSourceCheckpointId ?? null,
          bootstrappedFromBranch: parsed.bootstrappedFromBranch ?? null,
          bootstrappedFromCheckpointId: parsed.bootstrappedFromCheckpointId ?? null,
          bootstrappedAt: parsed.bootstrappedAt ?? null
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
      checkpoints: checkpoints.filter((entry) => entry.gitBranch === currentBranch)
    };
  }

  async findCheckpoint(checkpointId: string): Promise<CheckpointMetadata | null> {
    const checkpoints = await this.readMetadata();
    return checkpoints.find((entry) => entry.checkpointId === checkpointId) ?? null;
  }

  private shadowRefForBranch(branch: string): string {
    return `refs/anvil/${branch}`;
  }

  private async shadowRefExists(shadowRef: string): Promise<boolean> {
    try {
      await runGit(["show-ref", "--verify", "--quiet", shadowRef], this.repositoryRoot, this.shadowGitDir);
      return true;
    } catch {
      return false;
    }
  }

  private async shadowRefHead(shadowRef: string): Promise<string | null> {
    try {
      const sha = await runGit(["rev-parse", shadowRef], this.repositoryRoot, this.shadowGitDir);
      return sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  }

  private async pointShadowHeadAt(shadowRef: string): Promise<void> {
    await runGit(["symbolic-ref", "HEAD", shadowRef], this.repositoryRoot, this.shadowGitDir);
  }

  private async latestCheckpointForBranch(branch: string): Promise<CheckpointMetadata | null> {
    const checkpoints = await this.readMetadata();
    const matches = checkpoints.filter((entry) => entry.gitBranch === branch);
    return matches.at(-1) ?? null;
  }

  private async inferBootstrapSourceBranch(targetBranch: string): Promise<string | null> {
    const reflogMessages = await getHeadReflogMessages(this.repositoryRoot, 30);
    const checkoutPattern = /^checkout: moving from (.+) to (.+)$/;

    for (const message of reflogMessages) {
      const match = message.match(checkoutPattern);
      if (!match) {
        continue;
      }

      const [, fromBranch, toBranch] = match;
      if (toBranch !== targetBranch || fromBranch === targetBranch) {
        continue;
      }

      const candidateRef = this.shadowRefForBranch(fromBranch);
      if (await this.shadowRefExists(candidateRef)) {
        return fromBranch;
      }
    }

    const checkpoints = await this.readMetadata();
    for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
      const checkpoint = checkpoints[index];
      if (!checkpoint.gitBranch || checkpoint.gitBranch === targetBranch) {
        continue;
      }

      const candidateRef = this.shadowRefForBranch(checkpoint.gitBranch);
      if (await this.shadowRefExists(candidateRef)) {
        return checkpoint.gitBranch;
      }
    }

    return null;
  }

  private async ensureShadowBranch(branch: string): Promise<ShadowBranchContext> {
    const shadowRef = this.shadowRefForBranch(branch);
    const exists = await this.shadowRefExists(shadowRef);

    if (exists) {
      await this.pointShadowHeadAt(shadowRef);
      return {
        branch,
        shadowRef,
        bootstrappedFromBranch: null,
        bootstrappedFromCheckpointId: null,
        bootstrappedAt: null
      };
    }

    const sourceBranch = await this.inferBootstrapSourceBranch(branch);
    let bootstrappedFromCheckpointId: string | null = null;

    if (sourceBranch) {
      const sourceRef = this.shadowRefForBranch(sourceBranch);
      const sourceSha = await this.shadowRefHead(sourceRef);
      if (sourceSha) {
        await runGit(["update-ref", shadowRef, sourceSha], this.repositoryRoot, this.shadowGitDir);
        const sourceCheckpoint = await this.latestCheckpointForBranch(sourceBranch);
        bootstrappedFromCheckpointId = sourceCheckpoint?.checkpointId ?? null;
      }
    }

    await this.pointShadowHeadAt(shadowRef);

    return {
      branch,
      shadowRef,
      bootstrappedFromBranch: sourceBranch,
      bootstrappedFromCheckpointId,
      bootstrappedAt: new Date().toISOString()
    };
  }

  private async assertCheckpointMatchesCurrentBranch(checkpoint: CheckpointMetadata): Promise<void> {
    const currentBranch = await this.currentBranch();
    if (!checkpoint.gitBranch || !currentBranch) {
      return;
    }

    if (checkpoint.gitBranch !== currentBranch) {
      throw new Error(
        `Checkpoint ${checkpoint.checkpointId} belongs to branch "${checkpoint.gitBranch}", but the current branch is "${currentBranch}". Switch branches or choose a matching checkpoint.`
      );
    }
  }

  private async latestCheckpointForCurrentBranch(): Promise<CheckpointMetadata | null> {
    const timeline = await this.timeline();
    return timeline.checkpoints.at(-1) ?? null;
  }

  async recordCheckpoint(options: RecordCheckpointOptions): Promise<CheckpointMetadata> {
    await this.loadConfig();

    const existing = await this.readMetadata();
    const latestOverall = existing.at(-1) ?? null;
    const nextNumber = latestOverall ? checkpointNumber(latestOverall.checkpointId) + 1 : 1;
    const checkpointId = `cp-${nextNumber}`;
    const gitBranch = await this.currentBranch();
    if (!gitBranch) {
      throw new Error("Cannot record an Anvil checkpoint without an active Git branch.");
    }

    const parent = await this.latestCheckpointForBranch(gitBranch);
    const shadowContext = await this.ensureShadowBranch(gitBranch);

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
      shadowRef: shadowContext.shadowRef,
      parentCheckpointId: parent?.checkpointId ?? null,
      shadowCommitSha,
      filesChanged,
      summary: options.summary,
      promptHash: hashText(options.prompt),
      commandsRun: options.commandsRun ?? [],
      testStatus: options.testStatus ?? "unknown",
      restoreSourceCheckpointId: options.restoreSourceCheckpointId ?? null,
      bootstrappedFromBranch: shadowContext.bootstrappedFromBranch,
      bootstrappedFromCheckpointId: shadowContext.bootstrappedFromCheckpointId,
      bootstrappedAt: shadowContext.bootstrappedAt
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

    await this.assertCheckpointMatchesCurrentBranch(checkpoint);

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

  async assignCheckpointBranch(checkpointId: string, branch: string): Promise<CheckpointMetadata> {
    const checkpoints = await this.readMetadata();
    const targetIndex = checkpoints.findIndex((entry) => entry.checkpointId === checkpointId);
    if (targetIndex === -1) {
      throw new Error(`Unknown checkpoint: ${checkpointId}`);
    }

    const updated = checkpoints.map((entry, index) =>
      index === targetIndex
        ? {
            ...entry,
            gitBranch: branch,
            shadowRef: entry.shadowRef ?? this.shadowRefForBranch(branch)
          }
        : entry
    );

    const serialized = updated.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(this.metadataFile, `${serialized}\n`, "utf8");
    return updated[targetIndex];
  }

  async exportToGit(message: string, previewOnly: boolean): Promise<string> {
    const latest = await this.latestCheckpointForCurrentBranch();
    if (!latest) {
      const currentBranch = await this.currentBranch();
      throw new Error(
        currentBranch
          ? `No checkpoints available to export for branch "${currentBranch}".`
          : "No checkpoints available to export."
      );
    }

    await this.assertCheckpointMatchesCurrentBranch(latest);

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
      summary: `Prepared current workspace for export to canonical Git from ${latest.checkpointId}`,
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
