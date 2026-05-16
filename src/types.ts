export type CheckpointKind =
  | "after_edit_batch"
  | "after_test_run"
  | "before_restore"
  | "after_restore"
  | "before_export"
  | "manual";

export interface CheckpointMetadata {
  checkpointId: string;
  timestamp: string;
  kind: CheckpointKind;
  snapshotMode: "full" | "partial";
  origin: "ai" | "manual";
  aiSource: string | null;
  gitBranch: string | null;
  shadowRef: string | null;
  parentCheckpointId: string | null;
  previousShadowCommitSha: string | null;
  shadowCommitSha: string;
  filesChanged: string[];
  summary: string;
  prompt: string | null;
  rationale: string | null;
  promptHash: string | null;
  commandsRun: string[];
  testStatus: "unknown" | "passed" | "failed";
  restoreSourceCheckpointId: string | null;
  bootstrappedFromBranch: string | null;
  bootstrappedFromCheckpointId: string | null;
  bootstrappedAt: string | null;
}

export interface StoreConfig {
  version: 1;
  repositoryRoot: string;
  shadowGitDir: string;
  metadataFile: string;
  retention: {
    maxCheckpointsPerBranch: number;
    maxHookLogs: number;
  };
}

export interface TimelineResponse {
  repositoryName: string;
  repositoryRoot: string;
  originUrl: string | null;
  currentBranch: string | null;
  checkpoints: CheckpointMetadata[];
}

export interface BranchSummary {
  branch: string;
  shadowRef: string | null;
  checkpointCount: number;
  latestCheckpointId: string | null;
  latestTimestamp: string | null;
}

export interface BranchListResponse {
  repositoryName: string;
  repositoryRoot: string;
  currentBranch: string | null;
  branches: BranchSummary[];
}

export interface FileSnapshotResponse {
  checkpointId: string;
  filePath: string;
  beforeContent: string | null;
  afterContent: string | null;
}

export interface RecordCheckpointOptions {
  kind: CheckpointKind;
  summary: string;
  snapshotMode?: "full" | "partial";
  filesChanged?: string[];
  origin?: "ai" | "manual";
  aiSource?: string | null;
  prompt?: string;
  rationale?: string;
  commandsRun?: string[];
  testStatus?: "unknown" | "passed" | "failed";
  restoreSourceCheckpointId?: string | null;
}

export interface PruneOptions {
  dryRun?: boolean;
  maxCheckpointsPerBranch?: number;
  maxHookLogs?: number;
}

export interface PruneResult {
  dryRun: boolean;
  maxCheckpointsPerBranch: number;
  maxHookLogs: number;
  checkpointsRemoved: number;
  hookLogsRemoved: number;
  affectedBranches: string[];
}

export interface GeneratedInsightRecord {
  checkpointId: string;
  extensionId: string;
  insightType: string;
  title: string;
  body: string;
  files?: string[];
  createdAt: string;
  source: "extension" | "builtin";
}
