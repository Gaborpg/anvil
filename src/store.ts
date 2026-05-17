import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { appendPendingExtensionEvent, readGeneratedInsights } from "./extensions.js";
import { getCurrentBranch, getHeadReflogMessages, getOriginUrl, runGit, runGitRaw } from "./git.js";
import { filterIgnoredAnvilPaths, isIgnoredAnvilPath, loadAnvilIgnoreRules, type AnvilIgnoreRules } from "./ignore.js";
import type { BranchListResponse, BranchSummary, CheckpointMetadata, FileSnapshotResponse, GeneratedInsightRecord, PruneOptions, PruneResult, RecordCheckpointOptions, StoreConfig, TimelineResponse } from "./types.js";
import { checkpointNumber, ensureDir, hashText, readJson, writeJson } from "./utils.js";

const STORE_DIR_NAME = ".anvil";
const SHADOW_DIR_NAME = "store.git";
const METADATA_FILE_NAME = "metadata.jsonl";
const CONFIG_FILE_NAME = "config.json";
const HOOK_EXECUTION_LOG_FILE_NAME = "hook-executions.jsonl";
const SHADOW_EXCLUDE_LINES = [".anvil/", ".anvil/**"];
const DEFAULT_RETENTION = {
  maxCheckpointsPerBranch: 50,
  maxHookLogs: 500
} as const;

interface ShadowBranchContext {
  branch: string;
  shadowRef: string;
  headSha: string | null;
  bootstrappedFromBranch: string | null;
  bootstrappedFromCheckpointId: string | null;
  bootstrappedFromShadowCommitSha: string | null;
  bootstrappedAt: string | null;
}

interface WorkspaceStatusEntry {
  path: string;
}

interface ChangedPathSet {
  checkout: string[];
  remove: string[];
}

interface RepairBranchBaselineResult {
  branch: string;
  shadowRef: string;
  baselineSha: string;
  updatedCheckpointId: string | null;
}

export class CheckpointStore {
  constructor(private readonly repositoryRoot: string) {}

  private ignoreRulesPromise: Promise<AnvilIgnoreRules> | null = null;

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

  get hookExecutionLogFile(): string {
    return path.join(this.baseDir, HOOK_EXECUTION_LOG_FILE_NAME);
  }

  private async ignoreRules(): Promise<AnvilIgnoreRules> {
    if (!this.ignoreRulesPromise) {
      this.ignoreRulesPromise = loadAnvilIgnoreRules(this.repositoryRoot);
    }

    return this.ignoreRulesPromise;
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
      metadataFile: this.metadataFile,
      retention: {
        ...DEFAULT_RETENTION
      }
    };

    if (!existsSync(this.configFile)) {
      await writeJson(this.configFile, config);
    }

    if (!existsSync(this.metadataFile)) {
      await appendFile(this.metadataFile, "", "utf8");
    }

    await this.ensureShadowExcludes();
    await this.ensureShadowAlternates();

    return config;
  }

  async uninstall(): Promise<void> {
    await rm(this.baseDir, { force: true, recursive: true });
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

  private async ensureShadowAlternates(): Promise<void> {
    const objectsPathRaw = await runGit(["rev-parse", "--git-path", "objects"], this.repositoryRoot);
    const objectsPath = path.isAbsolute(objectsPathRaw)
      ? objectsPathRaw
      : path.resolve(this.repositoryRoot, objectsPathRaw);
    const alternatesPath = path.join(this.shadowGitDir, "objects", "info", "alternates");
    const existing = existsSync(alternatesPath) ? await readFile(alternatesPath, "utf8") : "";
    const lines = existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.includes(objectsPath)) {
      return;
    }

    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await appendFile(alternatesPath, `${prefix}${objectsPath}\n`, "utf8");
  }

  private async workspaceStatusEntries(): Promise<WorkspaceStatusEntry[]> {
    const ignoreRules = await this.ignoreRules();
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

      if (!filePath || isIgnoredAnvilPath(filePath, ignoreRules)) {
        continue;
      }

      if (status.startsWith("R") || status.startsWith("C")) {
        const renamedTo = tokens[index + 1];
        if (renamedTo && !isIgnoredAnvilPath(renamedTo, ignoreRules)) {
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
    const ignoreRules = await this.ignoreRules();
    const candidatePaths =
      explicitPaths && explicitPaths.length > 0
        ? filterIgnoredAnvilPaths(explicitPaths, ignoreRules)
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
    const ignoreRules = await this.ignoreRules();
    const output = await runGitRaw(
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      this.repositoryRoot
    );
    if (!output) {
      return [];
    }

    return [...new Set(filterIgnoredAnvilPaths(output.split("\0").filter((item) => item.length > 0), ignoreRules))];
  }

  private async shadowTreePaths(commitish = "HEAD"): Promise<string[]> {
    const ignoreRules = await this.ignoreRules();
    try {
      const output = await runGitRaw(["ls-tree", "-r", "--name-only", "-z", commitish], this.repositoryRoot, this.shadowGitDir);
      return filterIgnoredAnvilPaths(output.split("\0").filter((item) => item.length > 0), ignoreRules);
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
    const ignoreRules = await this.ignoreRules();
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
        if (oldPath && !isIgnoredAnvilPath(oldPath, ignoreRules)) {
          remove.add(oldPath);
        }
        if (newPath && !isIgnoredAnvilPath(newPath, ignoreRules)) {
          checkout.add(newPath);
        }
        continue;
      }

      const filePath = tokens[index++];
      if (!filePath || isIgnoredAnvilPath(filePath, ignoreRules)) {
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
    const ignoreRules = await this.ignoreRules();
    for (const relativePath of paths) {
      if (!relativePath || isIgnoredAnvilPath(relativePath, ignoreRules)) {
        continue;
      }

      const absolutePath = path.join(this.repositoryRoot, relativePath);
      await rm(absolutePath, { force: true, recursive: true });
    }
  }

  async loadConfig(): Promise<StoreConfig> {
    const config = await readJson<Partial<StoreConfig>>(this.configFile);
    if (!config) {
      return this.init();
    }

    const normalized: StoreConfig = {
      version: 1,
      repositoryRoot: config.repositoryRoot ?? this.repositoryRoot,
      shadowGitDir: config.shadowGitDir ?? this.shadowGitDir,
      metadataFile: config.metadataFile ?? this.metadataFile,
      retention: {
        maxCheckpointsPerBranch: config.retention?.maxCheckpointsPerBranch ?? DEFAULT_RETENTION.maxCheckpointsPerBranch,
        maxHookLogs: config.retention?.maxHookLogs ?? DEFAULT_RETENTION.maxHookLogs
      }
    };

    const shouldRewrite =
      config.version !== normalized.version ||
      config.repositoryRoot !== normalized.repositoryRoot ||
      config.shadowGitDir !== normalized.shadowGitDir ||
      config.metadataFile !== normalized.metadataFile ||
      config.retention?.maxCheckpointsPerBranch !== normalized.retention.maxCheckpointsPerBranch ||
      config.retention?.maxHookLogs !== normalized.retention.maxHookLogs;

    if (shouldRewrite) {
      await writeJson(this.configFile, normalized);
    }

    return normalized;
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
          origin: parsed.origin ?? "manual",
          aiSource: parsed.aiSource ?? null,
          gitBranch: parsed.gitBranch ?? null,
          shadowRef: parsed.shadowRef ?? null,
          parentCheckpointId: parsed.parentCheckpointId ?? null,
          previousShadowCommitSha: parsed.previousShadowCommitSha ?? null,
          shadowCommitSha: parsed.shadowCommitSha ?? "",
          filesChanged: parsed.filesChanged ?? [],
          summary: parsed.summary ?? "",
          prompt: parsed.prompt ?? null,
          rationale: parsed.rationale ?? null,
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

  async listBranches(): Promise<BranchListResponse> {
    const checkpoints = await this.readMetadata();
    const currentBranch = await this.currentBranch();
    const map = new Map<string, BranchSummary>();

    for (const checkpoint of checkpoints) {
      if (!checkpoint.gitBranch) {
        continue;
      }

      const current = map.get(checkpoint.gitBranch);
      if (!current) {
        map.set(checkpoint.gitBranch, {
          branch: checkpoint.gitBranch,
          shadowRef: checkpoint.shadowRef,
          checkpointCount: 1,
          latestCheckpointId: checkpoint.checkpointId,
          latestTimestamp: checkpoint.timestamp
        });
        continue;
      }

      current.checkpointCount += 1;
      current.latestCheckpointId = checkpoint.checkpointId;
      current.latestTimestamp = checkpoint.timestamp;
      current.shadowRef = checkpoint.shadowRef ?? current.shadowRef;
    }

    const branches = [...map.values()].sort((left, right) => {
      if (left.branch === currentBranch) {
        return -1;
      }
      if (right.branch === currentBranch) {
        return 1;
      }

      return (right.latestTimestamp ?? "").localeCompare(left.latestTimestamp ?? "");
    });

    return {
      repositoryName: path.basename(this.repositoryRoot),
      repositoryRoot: this.repositoryRoot,
      currentBranch,
      branches
    };
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

  private async updateShadowRef(shadowRef: string, commitSha: string): Promise<void> {
    await runGit(["update-ref", shadowRef, commitSha], this.repositoryRoot, this.shadowGitDir);
  }

  private async deleteShadowRef(shadowRef: string): Promise<void> {
    try {
      await runGit(["update-ref", "-d", shadowRef], this.repositoryRoot, this.shadowGitDir);
    } catch {
      // Ignore missing refs.
    }
  }

  private async commitTree(treeSha: string, message: string): Promise<string> {
    return runGit(
      ["-c", "user.name=anvil", "-c", "user.email=anvil@local", "commit-tree", treeSha, "-m", message],
      this.repositoryRoot,
      this.shadowGitDir
    );
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
      const headSha = await this.shadowRefHead(shadowRef);
      await this.pointShadowHeadAt(shadowRef);
      return {
        branch,
        shadowRef,
        headSha,
        bootstrappedFromBranch: null,
        bootstrappedFromCheckpointId: null,
        bootstrappedFromShadowCommitSha: null,
        bootstrappedAt: null
      };
    }

    const sourceBranch = await this.inferBootstrapSourceBranch(branch);
    let bootstrappedFromCheckpointId: string | null = null;
    let bootstrappedFromShadowCommitSha: string | null = null;

    if (sourceBranch) {
      const sourceRef = this.shadowRefForBranch(sourceBranch);
      const sourceSha = await this.shadowRefHead(sourceRef);
      if (sourceSha) {
        await runGit(["update-ref", shadowRef, sourceSha], this.repositoryRoot, this.shadowGitDir);
        bootstrappedFromShadowCommitSha = sourceSha;
        const sourceCheckpoint = await this.latestCheckpointForBranch(sourceBranch);
        bootstrappedFromCheckpointId = sourceCheckpoint?.checkpointId ?? null;
      }
    }

    let headSha = await this.shadowRefHead(shadowRef);
    if (!headSha) {
      try {
        const headTreeSha = await runGit(["rev-parse", "HEAD^{tree}"], this.repositoryRoot);
        const baselineSha = await this.commitTree(headTreeSha, `anvil baseline ${branch}`);
        await runGit(["update-ref", shadowRef, baselineSha], this.repositoryRoot, this.shadowGitDir);
        headSha = baselineSha;
      } catch {
        headSha = null;
      }
    }

    await this.pointShadowHeadAt(shadowRef);

    return {
      branch,
      shadowRef,
      headSha,
      bootstrappedFromBranch: sourceBranch,
      bootstrappedFromCheckpointId,
      bootstrappedFromShadowCommitSha,
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

    const shadowContext = await this.ensureShadowBranch(gitBranch);
    const parent =
      (await this.latestCheckpointForBranch(gitBranch)) ??
      (shadowContext.bootstrappedFromCheckpointId
        ? await this.findCheckpoint(shadowContext.bootstrappedFromCheckpointId)
        : null);
    const snapshotMode = options.snapshotMode ?? "full";
    if (snapshotMode === "partial") {
      await this.stageWorkspacePaths(options.filesChanged);
    } else {
      await this.stageFullWorkspaceSnapshot();
    }

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
    const effectiveParentShadowCommitSha =
      parent?.shadowCommitSha ?? shadowContext.headSha ?? shadowContext.bootstrappedFromShadowCommitSha ?? null;
    const changesSinceParent = await this.changedPathsBetween(effectiveParentShadowCommitSha, shadowCommitSha);
    const filesChanged =
      options.filesChanged && options.filesChanged.length > 0
        ? [...new Set(filterIgnoredAnvilPaths(options.filesChanged, await this.ignoreRules()))]
        : [...new Set([...changesSinceParent.checkout, ...changesSinceParent.remove])];

    const metadata: CheckpointMetadata = {
      checkpointId,
      timestamp: new Date().toISOString(),
      kind: options.kind,
      snapshotMode,
      origin: options.origin ?? (options.prompt || options.rationale || options.aiSource ? "ai" : "manual"),
      aiSource: options.aiSource ?? null,
      gitBranch,
      shadowRef: shadowContext.shadowRef,
      parentCheckpointId: parent?.checkpointId ?? null,
      previousShadowCommitSha: effectiveParentShadowCommitSha,
      shadowCommitSha,
      filesChanged,
      summary: options.summary,
      prompt: options.prompt ?? null,
      rationale: options.rationale ?? null,
      promptHash: hashText(options.prompt),
      commandsRun: options.commandsRun ?? [],
      testStatus: options.testStatus ?? "unknown",
      restoreSourceCheckpointId: options.restoreSourceCheckpointId ?? null,
      bootstrappedFromBranch: shadowContext.bootstrappedFromBranch,
      bootstrappedFromCheckpointId: shadowContext.bootstrappedFromCheckpointId,
      bootstrappedAt: shadowContext.bootstrappedAt
    };

    await appendFile(this.metadataFile, `${JSON.stringify(metadata)}\n`, "utf8");
    await appendPendingExtensionEvent(this.repositoryRoot, checkpointId);
    return metadata;
  }

  async generatedInsights(checkpointId?: string): Promise<GeneratedInsightRecord[]> {
    return readGeneratedInsights(this.repositoryRoot, checkpointId);
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
      fromSha = index > 0 ? checkpoints[index - 1].shadowCommitSha : target.previousShadowCommitSha;
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
      : checkpoint.previousShadowCommitSha;

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
        : checkpoint.previousShadowCommitSha;
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

  async compactBranchHistory(mode: "keep-last" | "squash"): Promise<CheckpointMetadata | null> {
    await this.loadConfig();
    const branch = await this.currentBranch();
    if (!branch) {
      throw new Error("Cannot compact Anvil history without an active Git branch.");
    }

    const checkpoints = await this.readMetadata();
    const branchCheckpoints = checkpoints.filter((entry) => entry.gitBranch === branch);
    if (branchCheckpoints.length === 0) {
      return null;
    }

    const latest = branchCheckpoints.at(-1)!;
    let targetSha = latest.shadowCommitSha;
    let summary = latest.summary;

    if (mode === "squash") {
      const treeSha = await runGit(["rev-parse", `${latest.shadowCommitSha}^{tree}`], this.repositoryRoot, this.shadowGitDir);
      targetSha = await this.commitTree(treeSha, `anvil squash ${branch} -> ${latest.checkpointId}`);
      summary = `Squashed Anvil history for ${branch} into ${latest.checkpointId}`;
    }

    const retainedEntry: CheckpointMetadata = {
      ...latest,
      parentCheckpointId: null,
      previousShadowCommitSha: latest.previousShadowCommitSha,
      shadowCommitSha: targetSha,
      summary,
      bootstrappedFromBranch: null,
      bootstrappedFromCheckpointId: null,
      bootstrappedAt: null
    };

    const nextMetadata = checkpoints.map((entry) => {
      if (entry.gitBranch !== branch) {
        return entry;
      }

      return entry.checkpointId === latest.checkpointId ? retainedEntry : null;
    }).filter((entry): entry is CheckpointMetadata => entry !== null);

    await this.updateShadowRef(latest.shadowRef ?? this.shadowRefForBranch(branch), targetSha);
    await this.pointShadowHeadAt(latest.shadowRef ?? this.shadowRefForBranch(branch));

    const serialized = nextMetadata.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(this.metadataFile, serialized.length > 0 ? `${serialized}\n` : "", "utf8");

    try {
      await runGit(["reflog", "expire", "--expire=now", "--all"], this.repositoryRoot, this.shadowGitDir);
      await runGit(["gc", "--prune=now"], this.repositoryRoot, this.shadowGitDir);
    } catch {
      // Best-effort cleanup only.
    }

    return retainedEntry;
  }

  private async treeShaForCommit(commitSha: string): Promise<string> {
    return runGit(["rev-parse", `${commitSha}^{tree}`], this.repositoryRoot, this.shadowGitDir);
  }

  private async rebuildRetainedBranchHistory(
    branch: string,
    branchCheckpoints: CheckpointMetadata[],
    maxCheckpointsPerBranch: number
  ): Promise<CheckpointMetadata[]> {
    if (branchCheckpoints.length <= maxCheckpointsPerBranch) {
      return branchCheckpoints;
    }

    const retained = branchCheckpoints.slice(-maxCheckpointsPerBranch);
    const shadowRef = retained.at(-1)?.shadowRef ?? this.shadowRefForBranch(branch);
    let parentSha: string | null = null;
    const rebuilt: CheckpointMetadata[] = [];

    for (let index = 0; index < retained.length; index += 1) {
      const checkpoint = retained[index];
      const treeSha = await this.treeShaForCommit(checkpoint.shadowCommitSha);
      const commitArgs = [
        "-c",
        "user.name=anvil",
        "-c",
        "user.email=anvil@local",
        "commit-tree",
        treeSha
      ];
      if (parentSha) {
        commitArgs.push("-p", parentSha);
      }
      commitArgs.push("-m", `${checkpoint.checkpointId} ${checkpoint.kind}: ${checkpoint.summary}`);
      const rebuiltSha = await runGit(commitArgs, this.repositoryRoot, this.shadowGitDir);

      const rebuiltCheckpoint: CheckpointMetadata = {
        ...checkpoint,
        parentCheckpointId: rebuilt.at(-1)?.checkpointId ?? null,
        previousShadowCommitSha: index === 0 ? checkpoint.previousShadowCommitSha : parentSha,
        shadowCommitSha: rebuiltSha,
        shadowRef,
        bootstrappedFromBranch: index === 0 ? checkpoint.bootstrappedFromBranch : null,
        bootstrappedFromCheckpointId: index === 0 ? checkpoint.bootstrappedFromCheckpointId : null,
        bootstrappedAt: index === 0 ? checkpoint.bootstrappedAt : null
      };

      rebuilt.push(rebuiltCheckpoint);
      parentSha = rebuiltSha;
    }

    if (parentSha) {
      await this.updateShadowRef(shadowRef, parentSha);
      await this.pointShadowHeadAt(shadowRef);
    }

    return rebuilt;
  }

  private async pruneHookExecutionLog(maxHookLogs: number, dryRun: boolean): Promise<number> {
    if (!existsSync(this.hookExecutionLogFile)) {
      return 0;
    }

    const raw = await readFile(this.hookExecutionLogFile, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length <= maxHookLogs) {
      return 0;
    }

    const retained = lines.slice(-maxHookLogs);
    const removed = lines.length - retained.length;

    if (!dryRun) {
      await writeFile(this.hookExecutionLogFile, retained.length > 0 ? `${retained.join("\n")}\n` : "", "utf8");
    }

    return removed;
  }

  async prune(options: PruneOptions = {}): Promise<PruneResult> {
    const config = await this.loadConfig();
    const dryRun = Boolean(options.dryRun);
    const maxCheckpointsPerBranch = options.maxCheckpointsPerBranch ?? config.retention.maxCheckpointsPerBranch;
    const maxHookLogs = options.maxHookLogs ?? config.retention.maxHookLogs;

    if (!Number.isInteger(maxCheckpointsPerBranch) || maxCheckpointsPerBranch < 1) {
      throw new Error("maxCheckpointsPerBranch must be an integer >= 1.");
    }
    if (!Number.isInteger(maxHookLogs) || maxHookLogs < 1) {
      throw new Error("maxHookLogs must be an integer >= 1.");
    }

    const checkpoints = await this.readMetadata();
    const grouped = new Map<string, CheckpointMetadata[]>();
    for (const checkpoint of checkpoints) {
      const branch = checkpoint.gitBranch ?? "__unknown__";
      const list = grouped.get(branch) ?? [];
      list.push(checkpoint);
      grouped.set(branch, list);
    }

    let checkpointsRemoved = 0;
    const affectedBranches: string[] = [];
    const rebuiltById = new Map<string, CheckpointMetadata>();
    for (const [branch, branchCheckpoints] of grouped) {
      if (branch === "__unknown__") {
        continue;
      }

      if (branchCheckpoints.length > maxCheckpointsPerBranch) {
        checkpointsRemoved += branchCheckpoints.length - maxCheckpointsPerBranch;
        affectedBranches.push(branch);
      }

      const retained = dryRun
        ? branchCheckpoints.slice(-maxCheckpointsPerBranch)
        : await this.rebuildRetainedBranchHistory(branch, branchCheckpoints, maxCheckpointsPerBranch);

      for (const checkpoint of retained) {
        rebuiltById.set(checkpoint.checkpointId, checkpoint);
      }
    }

    const nextMetadata = checkpoints
      .map((checkpoint) => {
        if (!checkpoint.gitBranch) {
          return checkpoint;
        }
        return rebuiltById.get(checkpoint.checkpointId) ?? null;
      })
      .filter((checkpoint): checkpoint is CheckpointMetadata => checkpoint !== null);

    if (!dryRun && checkpointsRemoved > 0) {
      const serialized = nextMetadata.map((entry) => JSON.stringify(entry)).join("\n");
      await writeFile(this.metadataFile, serialized.length > 0 ? `${serialized}\n` : "", "utf8");
    }

    const hookLogsRemoved = await this.pruneHookExecutionLog(maxHookLogs, dryRun);

    if (!dryRun) {
      const updatedConfig: StoreConfig = {
        ...config,
        retention: {
          maxCheckpointsPerBranch,
          maxHookLogs
        }
      };
      await writeJson(this.configFile, updatedConfig);

      try {
        await runGit(["reflog", "expire", "--expire=now", "--all"], this.repositoryRoot, this.shadowGitDir);
        await runGit(["gc", "--prune=now"], this.repositoryRoot, this.shadowGitDir);
      } catch {
        // Best-effort cleanup only.
      }
    }

    return {
      dryRun,
      maxCheckpointsPerBranch,
      maxHookLogs,
      checkpointsRemoved,
      hookLogsRemoved,
      affectedBranches
    };
  }

  async deleteBranches(branchesToDelete: string[]): Promise<BranchListResponse> {
    await this.loadConfig();
    const uniqueBranches = [...new Set(branchesToDelete.map((branch) => branch.trim()).filter(Boolean))];
    if (uniqueBranches.length === 0) {
      return this.listBranches();
    }

    const checkpoints = await this.readMetadata();
    const deletedSet = new Set(uniqueBranches);
    const retained = checkpoints.filter((checkpoint) => !checkpoint.gitBranch || !deletedSet.has(checkpoint.gitBranch));

    for (const branch of uniqueBranches) {
      await this.deleteShadowRef(this.shadowRefForBranch(branch));
    }

    const serialized = retained.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(this.metadataFile, serialized.length > 0 ? `${serialized}\n` : "", "utf8");

    try {
      await runGit(["reflog", "expire", "--expire=now", "--all"], this.repositoryRoot, this.shadowGitDir);
      await runGit(["gc", "--prune=now"], this.repositoryRoot, this.shadowGitDir);
    } catch {
      // Best-effort cleanup only.
    }

    return this.listBranches();
  }

  async keepOnlyBranches(branchesToKeep: string[]): Promise<BranchListResponse> {
    const inventory = await this.listBranches();
    const keepSet = new Set(branchesToKeep.map((branch) => branch.trim()).filter(Boolean));
    const branchesToDelete = inventory.branches
      .map((branch) => branch.branch)
      .filter((branch) => !keepSet.has(branch));

    return this.deleteBranches(branchesToDelete);
  }

  async repairCurrentBranchBaseline(): Promise<RepairBranchBaselineResult> {
    await this.loadConfig();
    const branch = await this.currentBranch();
    if (!branch) {
      throw new Error("Cannot repair an Anvil baseline without an active Git branch.");
    }

    const shadowRef = this.shadowRefForBranch(branch);
    const headTreeSha = await runGit(["rev-parse", "HEAD^{tree}"], this.repositoryRoot);
    const baselineSha = await this.commitTree(headTreeSha, `anvil baseline repair ${branch}`);
    const checkpoints = await this.readMetadata();
    const branchCheckpoints = checkpoints.filter((entry) => entry.gitBranch === branch);

    if (branchCheckpoints.length === 0) {
      await this.updateShadowRef(shadowRef, baselineSha);
      await this.pointShadowHeadAt(shadowRef);
      return {
        branch,
        shadowRef,
        baselineSha,
        updatedCheckpointId: null
      };
    }

    const firstCheckpoint = branchCheckpoints[0];
    const updatedMetadata = checkpoints.map((entry) => {
      if (entry.checkpointId !== firstCheckpoint.checkpointId) {
        return entry;
      }

      return {
        ...entry,
        previousShadowCommitSha: baselineSha,
        parentCheckpointId: null
      };
    });

    const serialized = updatedMetadata.map((entry) => JSON.stringify(entry)).join("\n");
    await writeFile(this.metadataFile, serialized.length > 0 ? `${serialized}\n` : "", "utf8");

    return {
      branch,
      shadowRef,
      baselineSha,
      updatedCheckpointId: firstCheckpoint.checkpointId
    };
  }
}
