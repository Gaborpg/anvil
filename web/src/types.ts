export interface TimelineItem {
  checkpointId: string;
  timestamp: string;
  kind: string;
  origin: "ai" | "manual";
  aiSource: string | null;
  gitBranch: string | null;
  shadowRef: string | null;
  summary: string;
  filesChanged: string[];
  commandsRun: string[];
  testStatus: string;
  bootstrappedFromBranch?: string | null;
  bootstrappedFromCheckpointId?: string | null;
  bootstrappedAt?: string | null;
}

export interface ExplainItem extends TimelineItem {
  parentCheckpointId: string | null;
  shadowCommitSha: string;
  prompt: string | null;
  rationale: string | null;
  promptHash: string | null;
  restoreSourceCheckpointId: string | null;
}

export interface GeneratedInsightItem {
  checkpointId: string;
  extensionId: string;
  insightType: string;
  title: string;
  body: string;
  files?: string[];
  createdAt: string;
  source: "extension" | "builtin";
  metadata?: Record<string, unknown>;
}

export interface VerificationLogItem {
  checkpointId: string;
  extensionId: string;
  title: string;
  body: string;
  createdAt: string;
  profile: string;
  command: string;
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  logFilePath: string;
}

export interface VerificationLogListResponse {
  logs: VerificationLogItem[];
}

export interface VerificationLogContentResponse {
  logFilePath: string;
  content: string;
}

export interface OrchestrationRunItem {
  checkpointId: string;
  extensionId: string;
  title: string;
  body: string;
  createdAt: string;
  actionId: string;
  actionType: string;
  triggerPhase: string;
  status: string;
  command: string;
  durationMs: number | null;
  logFilePath: string | null;
  error: string | null;
  metadata?: Record<string, unknown>;
}

export interface OrchestrationRunListResponse {
  runs: OrchestrationRunItem[];
}

export interface TimelineResponse {
  repositoryName: string;
  repositoryRoot: string;
  originUrl: string | null;
  currentBranch: string | null;
  checkpoints: TimelineItem[];
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

export interface RepositoryOption {
  name: string;
  root: string;
}

export interface FileSnapshotResponse {
  checkpointId: string;
  filePath: string;
  beforeContent: string | null;
  afterContent: string | null;
}

export interface DiffResponse {
  diff: string;
}

export interface ExportPreviewResponse {
  preview: string;
}

export interface ParsedDiffFile {
  filePath: string;
  header: string;
  diff: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
  sideBySideRows: SideBySideRow[];
}

export interface DiffLine {
  kind: "context" | "add" | "remove" | "hunk" | "meta";
  content: string;
  leftLineNumber: number | null;
  rightLineNumber: number | null;
}

export interface SideBySideRow {
  kind: "paired" | "meta";
  left: DiffLine | null;
  right: DiffLine | null;
  content?: string;
}
