export interface TimelineItem {
  checkpointId: string;
  timestamp: string;
  kind: string;
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
  promptHash: string | null;
  restoreSourceCheckpointId: string | null;
}

export interface TimelineResponse {
  repositoryName: string;
  repositoryRoot: string;
  originUrl: string | null;
  currentBranch: string | null;
  checkpoints: TimelineItem[];
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
