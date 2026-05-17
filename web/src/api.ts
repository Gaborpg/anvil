import type {
  BranchListResponse,
  DiffResponse,
  ExplainItem,
  ExportPreviewResponse,
  FileSnapshotResponse,
  OrchestrationRunListResponse,
  TimelineResponse,
  VerificationLogContentResponse,
  VerificationLogListResponse
} from "./types";

function withRepo(pathname: string, repo?: string): string {
  if (!repo) {
    return pathname;
  }

  const separator = pathname.includes("?") ? "&" : "?";
  return `${pathname}${separator}repo=${encodeURIComponent(repo)}`;
}

async function readJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function fetchTimeline(repo?: string): Promise<TimelineResponse> {
  return readJson<TimelineResponse>(withRepo("/api/timeline", repo));
}

export function fetchBranches(repo?: string): Promise<BranchListResponse> {
  return readJson<BranchListResponse>(withRepo("/api/branches", repo));
}

export function fetchCheckpoint(checkpointId: string, repo?: string): Promise<ExplainItem> {
  return readJson<ExplainItem>(withRepo(`/api/checkpoints/${checkpointId}`, repo));
}

export function fetchVerificationLogs(checkpointId: string, repo?: string): Promise<VerificationLogListResponse> {
  return readJson<VerificationLogListResponse>(withRepo(`/api/checkpoints/${checkpointId}/verification-logs`, repo));
}

export function fetchVerificationLogContent(
  checkpointId: string,
  logFilePath: string,
  repo?: string
): Promise<VerificationLogContentResponse> {
  const query = new URLSearchParams({ path: logFilePath });
  const pathWithQuery = `/api/checkpoints/${checkpointId}/verification-logs/content?${query.toString()}`;
  return readJson<VerificationLogContentResponse>(withRepo(pathWithQuery, repo));
}

export function fetchOrchestrationRuns(repo?: string): Promise<OrchestrationRunListResponse> {
  return readJson<OrchestrationRunListResponse>(withRepo("/api/orchestration-runs", repo));
}

export function fetchOrchestrationRunContent(
  logFilePath: string,
  repo?: string
): Promise<VerificationLogContentResponse> {
  const query = new URLSearchParams({ path: logFilePath });
  const pathWithQuery = `/api/orchestration-runs/content?${query.toString()}`;
  return readJson<VerificationLogContentResponse>(withRepo(pathWithQuery, repo));
}

export function fetchFileSnapshot(checkpointId: string, filePath: string, repo?: string): Promise<FileSnapshotResponse> {
  const query = new URLSearchParams({ path: filePath });
  const pathWithQuery = `/api/checkpoints/${checkpointId}/file?${query.toString()}`;
  return readJson<FileSnapshotResponse>(withRepo(pathWithQuery, repo));
}

export function fetchDiff(from?: string, to?: string, repo?: string): Promise<DiffResponse> {
  const params = new URLSearchParams();
  if (from) {
    params.set("from", from);
  }
  if (to) {
    params.set("to", to);
  }

  if (repo) {
    params.set("repo", repo);
  }

  const query = params.toString();
  return readJson<DiffResponse>(`/api/diff${query ? `?${query}` : ""}`);
}

export function fetchExportPreview(message: string, repo?: string): Promise<ExportPreviewResponse> {
  const params = new URLSearchParams({ message });
  if (repo) {
    params.set("repo", repo);
  }
  return readJson<ExportPreviewResponse>(`/api/export-preview?${params.toString()}`);
}

export function restoreCheckpoint(checkpointId: string, repo?: string): Promise<{ message: string }> {
  return readJson<{ message: string }>("/api/restore", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ checkpointId, repo })
  });
}

export function deleteBranches(branches: string[], repo?: string): Promise<BranchListResponse> {
  return readJson<BranchListResponse>("/api/branches/delete", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ branches, repo })
  });
}

export function keepBranches(branches: string[], repo?: string): Promise<BranchListResponse> {
  return readJson<BranchListResponse>("/api/branches/keep", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ branches, repo })
  });
}
