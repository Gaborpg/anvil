import { useEffect, useState } from "react";
import { fetchCheckpoint, fetchDiff, fetchExportPreview, fetchTimeline, restoreCheckpoint } from "./api";
import type { ExplainItem, TimelineItem } from "./types";

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

export function App() {
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<ExplainItem | null>(null);
  const [diffText, setDiffText] = useState<string>("Loading diff...");
  const [previewText, setPreviewText] = useState<string>("Export preview will appear here.");
  const [exportMessage, setExportMessage] = useState<string>("Anvil export");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadTimeline();
  }, []);

  useEffect(() => {
    if (!selectedCheckpointId) {
      return;
    }

    void loadCheckpoint(selectedCheckpointId);
    void loadDiff(selectedCheckpointId);
  }, [selectedCheckpointId]);

  async function loadTimeline() {
    setError(null);
    const response = await fetchTimeline();
    const items = response.checkpoints;
    setTimeline(items);
    setCurrentBranch(response.currentBranch);

    const latest = items.at(-1)?.checkpointId ?? null;
    setSelectedCheckpointId((current) => current ?? latest);
  }

  async function loadCheckpoint(checkpointId: string) {
    try {
      const checkpoint = await fetchCheckpoint(checkpointId);
      setSelectedCheckpoint(checkpoint);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }

  async function loadDiff(checkpointId?: string) {
    try {
      const response = await fetchDiff(checkpointId);
      setDiffText(response.diff);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }

  async function handlePreview() {
    setBusy(true);
    setError(null);

    try {
      const response = await fetchExportPreview(exportMessage);
      setPreviewText(response.preview);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore() {
    if (!selectedCheckpointId) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await restoreCheckpoint(selectedCheckpointId);
      await loadTimeline();
      await loadDiff(selectedCheckpointId);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <aside className="timeline">
        <div className="panel-title">Anvil Timeline</div>
        <div className="panel-subtitle">Private checkpoints for AI-driven changes</div>
        <div className="branch-chip">Branch: {currentBranch ?? "unknown"}</div>
        <div className="timeline-list">
          {timeline.map((item) => (
            <button
              key={item.checkpointId}
              className={`timeline-item${item.checkpointId === selectedCheckpointId ? " active" : ""}`}
              onClick={() => setSelectedCheckpointId(item.checkpointId)}
              type="button"
            >
              <div className="timeline-item-top">
                <strong>{item.checkpointId}</strong>
                <span>{item.kind}</span>
              </div>
              <div className="timeline-branch">{item.gitBranch ?? "unknown"}</div>
              <div className="timeline-summary">{item.summary}</div>
              <div className="timeline-meta">{formatTime(item.timestamp)}</div>
            </button>
          ))}
        </div>
      </aside>

      <main className="review">
        <header className="hero">
          <div>
            <div className="eyebrow">Shadow Review</div>
            <h1>Anvil Review Surface</h1>
            <p>Review checkpoint diffs locally, restore safely, and preview the final Git export.</p>
            <div className="hero-branch">Current Git branch: {currentBranch ?? "unknown"}</div>
          </div>
          <div className="hero-actions">
            <input
              value={exportMessage}
              onChange={(event) => setExportMessage(event.target.value)}
              placeholder="Export commit message"
            />
            <button onClick={() => void handlePreview()} type="button" disabled={busy}>
              {busy ? "Working..." : "Refresh Export Preview"}
            </button>
          </div>
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        <section className="content-grid">
          <section className="card detail-card">
            <div className="section-heading">
              <h2>Checkpoint Details</h2>
              <button onClick={() => void handleRestore()} type="button" disabled={!selectedCheckpointId || busy}>
                Restore This Checkpoint
              </button>
            </div>

            {selectedCheckpoint ? (
              <div className="detail-grid">
                <div>
                  <span className="label">Branch</span>
                  <p>{selectedCheckpoint.gitBranch ?? "unknown"}</p>
                </div>
                <div>
                  <span className="label">Summary</span>
                  <p>{selectedCheckpoint.summary}</p>
                </div>
                <div>
                  <span className="label">Timestamp</span>
                  <p>{formatTime(selectedCheckpoint.timestamp)}</p>
                </div>
                <div>
                  <span className="label">Test Status</span>
                  <p>{selectedCheckpoint.testStatus}</p>
                </div>
                <div>
                  <span className="label">Shadow Commit</span>
                  <p className="mono">{selectedCheckpoint.shadowCommitSha}</p>
                </div>
                <div>
                  <span className="label">Commands</span>
                  <p>{selectedCheckpoint.commandsRun.join(" | ") || "None recorded"}</p>
                </div>
                <div>
                  <span className="label">Files</span>
                  <ul className="file-list">
                    {selectedCheckpoint.filesChanged.map((file) => (
                      <li key={file}>{file}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <p>No checkpoint selected.</p>
            )}
          </section>

          <section className="card diff-card">
            <div className="section-heading">
              <h2>Checkpoint Diff</h2>
              <button onClick={() => void loadDiff(selectedCheckpointId ?? undefined)} type="button">
                Refresh Diff
              </button>
            </div>
            <pre>{diffText}</pre>
          </section>

          <section className="card export-card">
            <div className="section-heading">
              <h2>Export Preview</h2>
              <span>Final Git handoff</span>
            </div>
            <pre>{previewText}</pre>
          </section>
        </section>
      </main>
    </div>
  );
}
