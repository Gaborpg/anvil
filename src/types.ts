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
  gitBranch: string | null;
  shadowRef: string | null;
  parentCheckpointId: string | null;
  shadowCommitSha: string;
  filesChanged: string[];
  summary: string;
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
}

export interface TimelineResponse {
  currentBranch: string | null;
  checkpoints: CheckpointMetadata[];
}

export interface RecordCheckpointOptions {
  kind: CheckpointKind;
  summary: string;
  filesChanged?: string[];
  prompt?: string;
  commandsRun?: string[];
  testStatus?: "unknown" | "passed" | "failed";
  restoreSourceCheckpointId?: string | null;
}
