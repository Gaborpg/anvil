import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { getCurrentBranch, getHeadReflogMessages, getOriginUrl, runGit, runGitRaw } from "./git.js";
import type { CheckpointMetadata, FileSnapshotResponse, RecordCheckpointOptions, StoreConfig, TimelineResponse } from "./types.js";
import { checkpointNumber, ensureDir, hashText, readJson, writeJson } from "./utils.js";

const STORE_DIR_NAME = ".anvil";
const SHADOW_DIR_NAME = "store.git";
const METADATA_FILE_NAME = "metadata.jsonl";
const CONFIG_FILE_NAME = "config.json";
const SHADOW_EXCLUDE_LINES = [".anvil/", ".anvil/**"];

interface ShadowBranchContext {
  branch: string;
  shadowRef: string;
  bootstrappedFromBranch: string | null;
  bootstrappedFromCheckpointId: string | null;
  bootstrappedAt: string | null;
}

interface WorkspaceStatusEntry {
  path: string;
}

interface ChangedPathSet {
  checkout: string[];
  remove: string[];
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

    await this.ensureShadowExcludes();

    return config;
  }

  private async ensureShadowExcludes(): Promise<void> {
    const excludePath = path.join(this.shadowGitDir, "info", "exclude");
    const existing = existsSync(excludePath) ? await readFile(excludePath, "utf8") : "";
    const missingLines = SHADOW_EXCLUDE_LINES.filter((line) => !existing.split(/\r?\n/).includes(line));
    if (missingLines.length === 0) {
      return;
    }

    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await appendFile(excludePath, `${prefix}${missingLines.join("\n")}\n`, "utf8");
  }

  private async workspaceStatusEntries(): Promise<WorkspaceStatusEntry[]> {
    const output = await runGitRaw(["status", "--porcelain=v1", "-z"], this.repositoryRoot);
    if (!output) {
      return [];
    }

    const entries: WorkspaceStatusEntry[] = [];
    const tokens = output.split("\0").filter(Boolean);

    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      const status = token.slice(0, 2);
      const filePath = token.slice(3);

      if (!filePath || filePath.startsWith(".anvil")) {
        continue;
      }

      if (status.startsWith("R") || status.startsWith("C")) {
        const renamedTo = tokens[index + 1];
        if (renamedTo && !renamedTo.startsWith(".anvil")) {
          entries.push({ path: renamedTo });
        }
        index += 1;
        continue;
      }

      entries.push({ path: filePath });
    }

    return entries;
  }

  private async stageWorkspacePaths(explicitPaths?: string[]): Promise<string[]> {
    const candidatePaths =
      explicitPaths && explicitPaths.length > 0
        ? explicitPaths.filter((file) => file.length > 0 && !file.startsWith(".anvil"))
        : (await this.workspaceStatusEntries()).map((entry) => entry.path);

    const uniquePaths = [...new Set(candidatePaths)];
    if (uniquePaths.length === 0) {
      return [];
    }

    await runGit(["add", "-A", "--", ...uniquePaths], this.repositoryRoot, this.shadowGitDir);
    return uniquePaths;
  }

  private chunkPaths(paths: string[], size = 100): string[][] {
    const chunks: string[][] = [];
    for (let index = 0; index < paths.length; index += size) {
      chunks.push(paths.slice(index, index + size));
    }
    return chunks;
  }

  private async workspaceSnapshotPaths(): Promise<string[]> {
    const output = await runGitRaw(
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      this.repositoryRoot
    );
    if (!output) {
      return [];
    }

    return [...new Set(output.split("\0").filter((item) => item.length > 0 && !item.startsWith(".anvil")))];
  }

  private async shadowTreePaths(commitish = "HEAD"): Promise<string[]> {
    try {
      const output = await runGitRaw(["ls-tree", "-r", "--name-only", "-z", commitish], this.repositoryRoot, this.shadowGitDir);
      return output.split("\0").filter((item) => item.length > 0 && !item.startsWith(".anvil"));
    } catch {
      return [];
    }
  }

  private async stageFullWorkspaceSnapshot(): Promise<string[]> {
    const presentPaths = await this.workspaceSnapshotPaths();
    const previousPaths = await this.shadowTreePaths();
    const presentSet = new Set(presentPaths);
    const removedPaths = previousPaths.filter((item) => !presentSet.has(item));

    for (const batch of this.chunkPaths(presentPaths)) {
      await runGit(["add", "--", ...batch], this.repositoryRoot, this.shadowGitDir);
    }

    for (const batch of this.chunkPaths(removedPaths)) {
      await runGit(["rm", "--cached", "--ignore-unmatch", "--", ...batch], this.repositoryRoot, this.shadowGitDir);
    }

    return presentPaths;
  }

  private async changedPathsBetween(fromCommit: string | null, toCommit: string): Promise<ChangedPathSet> {
    const checkout = new Set<string>();
    const remove = new Set<string>();
    const output = await runGitRaw(
      ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", ...(fromCommit ? [fromCommit, toCommit] : [toCommit])],
      this.repositoryRoot,
      this.shadowGitDir
    );

    if (!output) {
      return { checkout: [], remove: [] };
    }

    const tokens = output.split("\0").filter((item) => item.length > 0);
    for (let index = 0; index < tokens.length; ) {
      const statusToken = tokens[index++];
      const status = statusToken.trim();
      if (!status) {
        continue;
      }

      const code = status[0];
      if (code === "R" || code === "C") {
        const oldPath = tokens[index++];
        const newPath = tokens[index++];
        if (oldPath && !oldPath.startsWith(".anvil")) {
          remove.add(oldPath);
        }
        if (newPath && !newPath.startsWith(".anvil")) {
          checkout.add(newPath);
        }
        continue;
      }

      const filePath = tokens[index++];
      if (!filePath || filePath.startsWith(".anvil")) {
        continue;
      }

      if (code === "D") {
        remove.add(filePath);
      } else {
        checkout.add(filePath);
      }
    }

    return {
      checkout: [...checkout],
      remove: [...remove]
    };
  }

  private async checkoutPathsFromShadowCommit(commitish: string, paths: string[]): Promise<void> {
    for (const batch of this.chunkPaths(paths)) {
      await runGit(["checkout", commitish, "--", ...batch], this.repositoryRoot, this.shadowGitDir);
    }
  }

  private async removeWorkspacePaths(paths: string[]): Promise<void> {
    for (const relativePath of paths) {
      if (!relativePath || relativePath.startsWith(".anvil")) {
        continue;
      }

      const absolutePath = path.join(this.repositoryRoot, relativePath);
      await rm(absolutePath, { force: true, recursive: true });
    }
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
          snapshotMode: parsed.snapshotMode ?? "partial",
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
        repositoryName: path.basename(this.repositoryRoot),
        repositoryRoot: this.repositoryRoot,
        originUrl: await getOriginUrl(this.repositoryRoot),
        currentBranch: null,
        checkpoints
      };
    }

    return {
      repositoryName: path.basename(this.repositoryRoot),
      repositoryRoot: this.repositoryRoot,
      originUrl: await getOriginUrl(this.repositoryRoot),
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
    const snapshotPaths = await this.stageFullWorkspaceSnapshot();

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
    const changesSinceParent = await this.changedPathsBetween(parent?.shadowCommitSha ?? null, shadowCommitSha);
    const filesChanged =
      options.filesChanged && options.filesChanged.length > 0
        ? [...new Set(options.filesChanged.filter((file) => file.length > 0 && !file.startsWith(".anvil")))]
        : [...new Set([...changesSinceParent.checkout, ...changesSinceParent.remove])];

    const metadata: CheckpointMetadata = {
      checkpointId,
      timestamp: new Date().toISOString(),
      kind: options.kind,
      snapshotMode: "full",
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

  private async readFileFromShadow(commitish: string | null, filePath: string): Promise<string | null> {
    if (!commitish) {
      return null;
    }

    try {
      return await runGitRaw(["show", `${commitish}:${filePath}`], this.repositoryRoot, this.shadowGitDir);
    } catch {
      return null;
    }
  }

  async fileSnapshot(checkpointId: string, filePath: string): Promise<FileSnapshotResponse> {
    const checkpoint = await this.findCheckpoint(checkpointId);
    if (!checkpoint) {
      throw new Error(`Unknown checkpoint: ${checkpointId}`);
    }

    const parentSha = checkpoint.parentCheckpointId
      ? (await this.findCheckpoint(checkpoint.parentCheckpointId))?.shadowCommitSha ?? null
      : null;

    return {
      checkpointId,
      filePath,
      beforeContent: await this.readFileFromShadow(parentSha, filePath),
      afterContent: await this.readFileFromShadow(checkpoint.shadowCommitSha, filePath)
    };
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

    if (checkpoint.snapshotMode === "full") {
      const targetPaths = await this.shadowTreePaths(checkpoint.shadowCommitSha);
      const currentPaths = await this.workspaceSnapshotPaths();
      const targetSet = new Set(targetPaths);
      const extraPaths = currentPaths.filter((item) => !targetSet.has(item));

      if (targetPaths.length > 0) {
        await this.checkoutPathsFromShadowCommit(checkpoint.shadowCommitSha, targetPaths);
      }
      if (extraPaths.length > 0) {
        await this.removeWorkspacePaths(extraPaths);
      }
    } else {
      const parentSha = checkpoint.parentCheckpointId
        ? (await this.findCheckpoint(checkpoint.parentCheckpointId))?.shadowCommitSha ?? null
        : null;
      const changedPaths = await this.changedPathsBetween(parentSha, checkpoint.shadowCommitSha);

      if (changedPaths.checkout.length > 0) {
        await this.checkoutPathsFromShadowCommit(checkpoint.shadowCommitSha, changedPaths.checkout);
      }
      if (changedPaths.remove.length > 0) {
        await this.removeWorkspacePaths(changedPaths.remove);
      }
    }

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
