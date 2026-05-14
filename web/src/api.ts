import type { DiffResponse, ExplainItem, ExportPreviewResponse, TimelineResponse } from "./types";

async function readJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function fetchTimeline(): Promise<TimelineResponse> {
  return readJson<TimelineResponse>("/api/timeline");
}

export function fetchCheckpoint(checkpointId: string): Promise<ExplainItem> {
  return readJson<ExplainItem>(`/api/checkpoints/${checkpointId}`);
}

export function fetchDiff(from?: string, to?: string): Promise<DiffResponse> {
  const params = new URLSearchParams();
  if (from) {
    params.set("from", from);
  }
  if (to) {
    params.set("to", to);
  }

  const query = params.toString();
  return readJson<DiffResponse>(`/api/diff${query ? `?${query}` : ""}`);
}

export function fetchExportPreview(message: string): Promise<ExportPreviewResponse> {
  const params = new URLSearchParams({ message });
  return readJson<ExportPreviewResponse>(`/api/export-preview?${params.toString()}`);
}

export function restoreCheckpoint(checkpointId: string): Promise<{ message: string }> {
  return readJson<{ message: string }>("/api/restore", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ checkpointId })
  });
}
