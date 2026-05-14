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
  currentBranch: string | null;
  checkpoints: TimelineItem[];
}

export interface DiffResponse {
  diff: string;
}

export interface ExportPreviewResponse {
  preview: string;
}
