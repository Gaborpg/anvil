import { useEffect, useRef, useState } from "react";
import { fetchCheckpoint, fetchDiff, fetchExportPreview, fetchFileSnapshot, fetchTimeline, restoreCheckpoint } from "./api";
import { parseDiffByFile } from "./diff";
import type { DiffLine, ExplainItem, FileSnapshotResponse, ParsedDiffFile, RepositoryOption, SideBySideRow, TimelineItem } from "./types";

const RECENT_REPOSITORIES_KEY = "anvil.recentRepositories";
type DiffViewMode = "summary" | "unified" | "side-by-side" | "snapshot";

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

function loadRecentRepositories(): RepositoryOption[] {
  try {
    const raw = window.localStorage.getItem(RECENT_REPOSITORIES_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as RepositoryOption[];
    return parsed.filter((item) => item && item.root && item.name);
  } catch {
    return [];
  }
}

function repositoryNameFromRoot(root: string): string {
  const normalized = root.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? root;
}

function saveRecentRepositories(items: RepositoryOption[]): void {
  window.localStorage.setItem(RECENT_REPOSITORIES_KEY, JSON.stringify(items.slice(0, 8)));
}

export function App() {
  const diffCardRef = useRef<HTMLElement | null>(null);
  const summaryListRef = useRef<HTMLDivElement | null>(null);
  const summaryCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [repositoryName, setRepositoryName] = useState<string>("Repository");
  const [repositoryRoot, setRepositoryRoot] = useState<string>("");
  const [originUrl, setOriginUrl] = useState<string | null>(null);
  const [repositoryOptions, setRepositoryOptions] = useState<RepositoryOption[]>([]);
  const [repositoryInput, setRepositoryInput] = useState<string>("");
  const [selectedRepositoryRoot, setSelectedRepositoryRoot] = useState<string>("");
  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string | null>(null);
  const [selectedCheckpoint, setSelectedCheckpoint] = useState<ExplainItem | null>(null);
  const [diffText, setDiffText] = useState<string>("Loading diff...");
  const [parsedFiles, setParsedFiles] = useState<ParsedDiffFile[]>([]);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>("summary");
  const [fileSnapshot, setFileSnapshot] = useState<FileSnapshotResponse | null>(null);
  const [previewText, setPreviewText] = useState<string>("Export preview will appear here.");
  const [exportMessage, setExportMessage] = useState<string>("Anvil export");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [timelineCollapsed, setTimelineCollapsed] = useState<boolean>(false);
  const [heroCollapsed, setHeroCollapsed] = useState<boolean>(false);
  const [detailsCollapsed, setDetailsCollapsed] = useState<boolean>(false);
  const [expandedSummaryFiles, setExpandedSummaryFiles] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setRepositoryOptions(loadRecentRepositories());
    void loadTimeline();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadTimeline(true);
    }, 4000);

    return () => window.clearInterval(timer);
  }, [selectedCheckpointId, selectedRepositoryRoot]);

  useEffect(() => {
    if (!selectedCheckpointId) {
      return;
    }

    void loadCheckpoint(selectedCheckpointId);
    void loadDiff(selectedCheckpointId);
  }, [selectedCheckpointId]);

  useEffect(() => {
    if (diffViewMode !== "snapshot" || !selectedCheckpointId || !selectedFilePath) {
      setFileSnapshot(null);
      return;
    }

    void loadFileSnapshot(selectedCheckpointId, selectedFilePath);
  }, [diffViewMode, selectedCheckpointId, selectedFilePath, selectedRepositoryRoot]);

  async function loadTimeline(fromPolling = false, repoOverride?: string) {
    setError(null);
    const repo = repoOverride ?? (selectedRepositoryRoot || undefined);
    const response = await fetchTimeline(repo);
    const items = response.checkpoints;
    setTimeline(items);
    setCurrentBranch(response.currentBranch);
    setRepositoryName(response.repositoryName);
    setRepositoryRoot(response.repositoryRoot);
    setOriginUrl(response.originUrl);
    setSelectedRepositoryRoot(response.repositoryRoot);
    setRepositoryInput(response.repositoryRoot);
    setRepositoryOptions((current) => {
      const next = [
        { name: response.repositoryName, root: response.repositoryRoot },
        ...current.filter((item) => item.root !== response.repositoryRoot)
      ];
      saveRecentRepositories(next);
      return next;
    });

    const latest = items.at(-1)?.checkpointId ?? null;
    setSelectedCheckpointId((current) => {
      if (!current) {
        return latest;
      }

      const stillExists = items.some((item) => item.checkpointId === current);
      if (stillExists) {
        return current;
      }

      if (fromPolling && latest && current !== latest) {
        setPreviewText("Export preview will appear here.");
      }

      return latest;
    });
  }

  async function loadCheckpoint(checkpointId: string) {
    try {
      const checkpoint = await fetchCheckpoint(checkpointId, selectedRepositoryRoot || undefined);
      setSelectedCheckpoint(checkpoint);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }

  async function loadDiff(checkpointId?: string) {
    try {
      const response = await fetchDiff(checkpointId, undefined, selectedRepositoryRoot || undefined);
      setDiffText(response.diff);
      const files = parseDiffByFile(response.diff);
      setParsedFiles(files);
      setSelectedFilePath((current) => {
        if (files.length === 0) {
          return null;
        }

        if (current && files.some((file) => file.filePath === current)) {
          return current;
        }

        return files[0].filePath;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }

  async function loadFileSnapshot(checkpointId: string, filePath: string) {
    try {
      const snapshot = await fetchFileSnapshot(checkpointId, filePath, selectedRepositoryRoot || undefined);
      setFileSnapshot(snapshot);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }

  async function handlePreview() {
    setBusy(true);
    setError(null);

    try {
      const response = await fetchExportPreview(exportMessage, selectedRepositoryRoot || undefined);
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
      await restoreCheckpoint(selectedCheckpointId, selectedRepositoryRoot || undefined);
      await loadTimeline();
      await loadDiff(selectedCheckpointId);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(false);
    }
  }

  async function handleRepositoryChange(nextRoot: string) {
    const trimmed = nextRoot.trim();
    if (!trimmed) {
      return;
    }

    setBusy(true);
    setError(null);
    setSelectedCheckpoint(null);
    setSelectedCheckpointId(null);
    setParsedFiles([]);
    setSelectedFilePath(null);
    setFileSnapshot(null);
    setExpandedSummaryFiles({});
    setPreviewText("Export preview will appear here.");
    setDiffText("Loading diff...");

    try {
      await loadTimeline(false, trimmed);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(false);
    }
  }

  const selectedFile = parsedFiles.find((file) => file.filePath === selectedFilePath) ?? null;
  const visibleFilePaths =
    parsedFiles.length > 0
      ? parsedFiles.map((file) => file.filePath)
      : (selectedCheckpoint?.filesChanged ?? []).filter((file) => !file.startsWith(".anvil"));
  const reviewFiles = visibleFilePaths.map((filePath) => {
    const parsed = parsedFiles.find((file) => file.filePath === filePath);
    return (
      parsed ?? {
        filePath,
        header: "",
        diff: "",
        additions: 0,
        deletions: 0,
        lines: [],
        sideBySideRows: []
      }
    );
  });

  function jumpToReviewedFile(filePath: string) {
    setSelectedFilePath(filePath);

    window.requestAnimationFrame(() => {
      if (diffViewMode === "summary") {
        const container = summaryListRef.current;
        const target = summaryCardRefs.current[filePath];
        if (container && target) {
          const top = target.offsetTop - container.offsetTop;
          container.scrollTo({ top, behavior: "smooth" });
        }
        return;
      }

      const container = diffCardRef.current?.querySelector<HTMLElement>(".card-scroll");
      if (container) {
        container.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  }

  function renderUnifiedLine(line: DiffLine, key: string) {
    return (
      <div key={key} className={`diff-line diff-line-${line.kind}`}>
        <span className="diff-gutter">{line.leftLineNumber ?? ""}</span>
        <span className="diff-gutter">{line.rightLineNumber ?? ""}</span>
        <code>{line.content || " "}</code>
      </div>
    );
  }

  function renderSideBySideRow(row: SideBySideRow, key: string) {
    if (row.kind === "meta") {
      return (
        <div key={key} className="side-by-side-meta">
          <code>{row.content}</code>
        </div>
      );
    }

    const leftClass = row.left ? `side-cell side-cell-${row.left.kind}` : "side-cell side-cell-empty";
    const rightClass = row.right ? `side-cell side-cell-${row.right.kind}` : "side-cell side-cell-empty";

    return (
      <div key={key} className="side-by-side-row">
        <div className={leftClass}>
          <span className="diff-gutter">{row.left?.leftLineNumber ?? ""}</span>
          <code>{row.left?.content || " "}</code>
        </div>
        <div className={rightClass}>
          <span className="diff-gutter">{row.right?.rightLineNumber ?? ""}</span>
          <code>{row.right?.content || " "}</code>
        </div>
      </div>
    );
  }

  function renderSummaryCard(file: ParsedDiffFile) {
    const previewLines = file.lines.filter((line) => line.kind !== "meta");
    const previewRows = file.sideBySideRows.filter((row) => row.kind !== "meta");
    const isExpanded = expandedSummaryFiles[file.filePath] ?? false;
    const visibleLines = isExpanded ? previewLines : previewLines.slice(0, 5);
    const visibleRows = isExpanded ? previewRows : previewRows.slice(0, 5);
    const hasMore = previewLines.length > 5;

    return (
      <article
        key={file.filePath}
        ref={(element) => {
          summaryCardRefs.current[file.filePath] = element;
        }}
        className={`summary-file-card${selectedFilePath === file.filePath ? " active" : ""}`}
      >
        <div className="summary-file-top">
          <div>
            <strong>{file.filePath}</strong>
            <div className="summary-file-meta">
              <span className="delta-add">+{file.additions}</span>
              <span className="delta-remove">-{file.deletions}</span>
            </div>
          </div>
          <button
            onClick={() => {
              jumpToReviewedFile(file.filePath);
              setDiffViewMode("snapshot");
              window.requestAnimationFrame(() => {
                diffCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              });
            }}
            type="button"
          >
            View
          </button>
        </div>
        <div className="summary-file-preview">
          {previewLines.length === 0 ? (
            <div className="summary-empty">No inline patch preview for this file. Use View for the full file snapshot.</div>
          ) : diffViewMode === "side-by-side" ? (
            <div className="side-by-side-preview">
              {visibleRows.map((row, index) => renderSideBySideRow(row, `${file.filePath}-${index}`))}
            </div>
          ) : (
            <div className="unified-preview">
              {visibleLines.map((line, index) => renderUnifiedLine(line, `${file.filePath}-${index}`))}
            </div>
          )}
        </div>
        {hasMore ? (
          <div className="summary-file-footer">
            <button
              onClick={() =>
                setExpandedSummaryFiles((current) => ({
                  ...current,
                  [file.filePath]: !isExpanded
                }))
              }
              type="button"
            >
              {isExpanded ? "Collapse" : `Expand all ${previewLines.length} changes`}
            </button>
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <div className={`shell${timelineCollapsed ? " shell-timeline-collapsed" : ""}`}>
      <aside className={`timeline${timelineCollapsed ? " collapsed" : ""}`}>
        <div className="panel-head">
          <div>
            <div className="panel-title">Anvil Timeline</div>
            {!timelineCollapsed ? <div className="panel-subtitle">Private checkpoints for AI-driven changes</div> : null}
          </div>
          <button
            className="icon-toggle"
            onClick={() => setTimelineCollapsed((value) => !value)}
            type="button"
            title={timelineCollapsed ? "Expand timeline" : "Collapse timeline"}
          >
            {timelineCollapsed ? "»" : "«"}
          </button>
        </div>
        {!timelineCollapsed ? (
          <>
            <div className="repo-chip">{repositoryName}</div>
            <div className="branch-chip">Branch: {currentBranch ?? "unknown"}</div>
            <div className="timeline-count">{timeline.length} checkpoint{timeline.length === 1 ? "" : "s"} on this branch</div>
            {timeline.length > 0 ? (
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
            ) : (
              <div className="empty-state">
                <strong>No checkpoints on this branch yet.</strong>
                <p>Switch branches or create an Anvil checkpoint to start a branch-local timeline.</p>
              </div>
            )}
          </>
        ) : (
          <div className="timeline-compact-list">
            {timeline.map((item) => (
              <button
                key={item.checkpointId}
                className={`timeline-compact-item${item.checkpointId === selectedCheckpointId ? " active" : ""}`}
                onClick={() => setSelectedCheckpointId(item.checkpointId)}
                type="button"
                title={`${item.checkpointId} - ${item.summary}`}
              >
                {item.checkpointId.replace("cp-", "")}
              </button>
            ))}
          </div>
        )}
      </aside>

      <main className="review">
        <header className={`hero${heroCollapsed ? " collapsed" : ""}`}>
          <div className="panel-head">
            <div>
              <div className="eyebrow">Shadow Review</div>
              <h1>Anvil Review Surface</h1>
            </div>
            <button
              className="icon-toggle"
              onClick={() => setHeroCollapsed((value) => !value)}
              type="button"
              title={heroCollapsed ? "Expand review header" : "Collapse review header"}
            >
              {heroCollapsed ? "▾" : "▴"}
            </button>
          </div>
          {!heroCollapsed ? (
            <>
              <div>
                <p>Review checkpoint diffs locally, restore safely, and preview the final Git export.</p>
                <div className="repository-switcher">
                  <label className="hero-repo-label" htmlFor="repo-selector">
                    Repository Selector
                  </label>
                  <div className="repository-switcher-row">
                    <select
                      id="repo-selector"
                      value={selectedRepositoryRoot}
                      onChange={(event) => {
                        void handleRepositoryChange(event.target.value);
                      }}
                    >
                      {repositoryOptions.map((option) => (
                        <option key={option.root} value={option.root}>
                          {option.name} - {option.root}
                        </option>
                      ))}
                    </select>
                    <input
                      value={repositoryInput}
                      onChange={(event) => setRepositoryInput(event.target.value)}
                      placeholder="Paste a repository path"
                    />
                    <button onClick={() => void handleRepositoryChange(repositoryInput)} type="button" disabled={busy}>
                      Open Repo
                    </button>
                  </div>
                </div>
                <div className="hero-repo-stack">
                  <div className="hero-repo-card">
                    <span className="hero-repo-label">Repository</span>
                    <strong>{repositoryName}</strong>
                    <span className="mono hero-repo-path">{repositoryRoot || "unknown"}</span>
                  </div>
                  {originUrl ? (
                    <div className="hero-repo-card">
                      <span className="hero-repo-label">Origin</span>
                      <a href={originUrl} target="_blank" rel="noreferrer">
                        {originUrl}
                      </a>
                    </div>
                  ) : null}
                </div>
                <div className="hero-branch">Current Git branch: {currentBranch ?? "unknown"}</div>
                {selectedCheckpoint ? (
                  <div className="hero-shadow">
                    Shadow ref: <span className="mono">{selectedCheckpoint.shadowRef ?? "unknown"}</span>
                  </div>
                ) : null}
              </div>
              <div className="hero-actions">
                <input
                  value={exportMessage}
                  onChange={(event) => setExportMessage(event.target.value)}
                  placeholder="Export commit message"
                />
                <button onClick={() => void loadTimeline()} type="button">
                  Refresh Timeline
                </button>
                <button onClick={() => void handlePreview()} type="button" disabled={busy}>
                  {busy ? "Working..." : "Refresh Export Preview"}
                </button>
              </div>
            </>
          ) : null}
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        <section className="content-grid">
          <section className="card files-card">
            <div className="section-heading">
              <h2>Changed Files</h2>
              <span>{reviewFiles.length} file{reviewFiles.length === 1 ? "" : "s"}</span>
            </div>
            {visibleFilePaths.length > 0 ? (
              <div className="card-scroll file-selector-list">
                {visibleFilePaths.map((filePath) => (
                  <button
                    key={filePath}
                    className={`file-selector${filePath === selectedFilePath ? " active" : ""}`}
                    onClick={() => jumpToReviewedFile(filePath)}
                    type="button"
                  >
                    {filePath}
                  </button>
                ))}
              </div>
            ) : (
              <p>No file-level diff sections were parsed for this checkpoint yet.</p>
            )}
          </section>

          <section className={`card detail-card${detailsCollapsed ? " collapsed" : ""}`}>
            <div className="section-heading">
              <h2>Checkpoint Details</h2>
              <div className="section-actions">
                <button
                  className="icon-toggle"
                  onClick={() => setDetailsCollapsed((value) => !value)}
                  type="button"
                  title={detailsCollapsed ? "Expand checkpoint details" : "Collapse checkpoint details"}
                >
                  {detailsCollapsed ? "▾" : "▴"}
                </button>
                <button onClick={() => void handleRestore()} type="button" disabled={!selectedCheckpointId || busy}>
                  Restore This Checkpoint
                </button>
              </div>
            </div>

            {!detailsCollapsed ? (
              selectedCheckpoint ? (
                <div className="detail-grid">
                  <div>
                    <span className="label">Branch</span>
                    <p>{selectedCheckpoint.gitBranch ?? "unknown"}</p>
                  </div>
                  <div>
                    <span className="label">Shadow Ref</span>
                    <p className="mono">{selectedCheckpoint.shadowRef ?? "unknown"}</p>
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
                    <span className="label">Bootstrap</span>
                    <p>
                      {selectedCheckpoint.bootstrappedFromBranch
                        ? `${selectedCheckpoint.bootstrappedFromBranch} via ${selectedCheckpoint.bootstrappedFromCheckpointId ?? "unknown checkpoint"}`
                        : "Native branch checkpoint"}
                    </p>
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
              )
            ) : null}
          </section>

          <section className="card diff-card" ref={diffCardRef}>
            <div className="section-heading">
              <h2>{diffViewMode === "summary" ? "Files Review" : selectedFile ? `Diff: ${selectedFile.filePath}` : "Checkpoint Diff"}</h2>
              <button onClick={() => void loadDiff(selectedCheckpointId ?? undefined)} type="button">
                Refresh Diff
              </button>
            </div>
            {diffViewMode === "summary" ? (
              reviewFiles.length > 0 ? (
                <div className="card-scroll summary-file-list" ref={summaryListRef}>
                  {reviewFiles.map((file) => renderSummaryCard(file))}
                </div>
              ) : (
                <pre>{diffText || "No net patch is available for this checkpoint versus its parent. The Changed Files list still reflects the checkpoint metadata."}</pre>
              )
            ) : diffViewMode === "snapshot" ? (
              selectedFile ? (
                <div className="card-scroll snapshot-grid">
                  <div className="snapshot-pane">
                    <div className="diff-header">
                      <span>Before snapshot</span>
                    </div>
                    <pre>{fileSnapshot?.beforeContent ?? "File did not exist before this checkpoint."}</pre>
                  </div>
                  <div className="snapshot-pane">
                    <div className="diff-header">
                      <span>After snapshot</span>
                    </div>
                    <pre>{fileSnapshot?.afterContent ?? "File does not exist in this checkpoint."}</pre>
                  </div>
                </div>
              ) : (
                <pre>Select a file to inspect its full before/after snapshot.</pre>
              )
            ) : selectedFile ? (
              <div className="card-scroll diff-view-shell">
                <div className="diff-header">
                  <span>
                    {diffViewMode === "side-by-side"
                      ? "Before / after columns for the selected file"
                      : "Unified patch for the selected file"}
                  </span>
                  <div className="summary-file-meta">
                    <span className="delta-add">+{selectedFile.additions}</span>
                    <span className="delta-remove">-{selectedFile.deletions}</span>
                  </div>
                </div>
                {diffViewMode === "side-by-side" ? (
                  <div className="side-by-side-table">
                    {selectedFile.sideBySideRows.filter((row) => row.kind !== "meta").map((row, index) =>
                      renderSideBySideRow(row, `${selectedFile.filePath}-side-${index}`)
                    )}
                  </div>
                ) : (
                  <div className="unified-table">
                    {selectedFile.lines
                      .filter((line) => line.kind !== "meta")
                      .map((line, index) => renderUnifiedLine(line, `${selectedFile.filePath}-line-${index}`))}
                  </div>
                )}
              </div>
            ) : (
              <pre>{diffText || "No net patch is available for this checkpoint versus its parent. The Changed Files list still reflects the checkpoint metadata."}</pre>
            )}
          </section>

          <section className="card export-card">
            <div className="section-heading">
              <h2>Git Commit Preview</h2>
              <span>What Anvil would export into real Git</span>
            </div>
            <pre>{previewText}</pre>
          </section>
        </section>

        <section className="mode-bar card">
          <div className="mode-title-block">
            <strong>Files</strong>
            <span className="panel-subtitle">Updates and commits are not separate views yet, so I removed the fake tabs.</span>
          </div>
          <div className="diff-toolbar">
            <div className="toolbar-chip">All Changes</div>
            <div className="toolbar-chip">{reviewFiles.length} changed files</div>
            <div className="toolbar-chip">Checkpoint {selectedCheckpointId ?? "none"}</div>
            {diffViewMode !== "summary" ? (
              <button
                onClick={() => {
                  setDiffViewMode("summary");
                  setFileSnapshot(null);
                }}
                type="button"
              >
                Back to Files
              </button>
            ) : null}
            <select value={diffViewMode} onChange={(event) => setDiffViewMode(event.target.value as DiffViewMode)}>
              <option value="summary">Summary view</option>
              <option value="unified">Unified diff</option>
              <option value="side-by-side">Side-by-side</option>
              <option value="snapshot">File snapshot</option>
            </select>
          </div>
        </section>
      </main>
    </div>
  );
}
