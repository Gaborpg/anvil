import { useEffect, useRef, useState } from "react";
import {
  deleteBranches,
  fetchBranches,
  fetchCheckpoint,
  fetchDiff,
  fetchExportPreview,
  fetchFileSnapshot,
  fetchTimeline,
  keepBranches,
  restoreCheckpoint
} from "./api";
import { parseDiffByFile } from "./diff";
import type {
  BranchSummary,
  DiffLine,
  ExplainItem,
  FileSnapshotResponse,
  ParsedDiffFile,
  RepositoryOption,
  SideBySideRow,
  TimelineItem
} from "./types";

const RECENT_REPOSITORIES_KEY = "anvil.recentRepositories";
type DiffViewMode = "summary" | "unified" | "side-by-side" | "snapshot";
type SurfaceMode = "review" | "history" | "manage";
type CheckpointDetailTab = "intent" | "files" | "lineage" | "debug";
type SuggestionItem = { title: string; detail: string };

function formatTime(value: string): string {
  return new Date(value).toLocaleString();
}

function formatCommandLabel(commands: string[]): string {
  if (commands.length === 0) {
    return "No commands recorded";
  }

  if (commands.length === 1) {
    return commands[0];
  }

  return `${commands.length} commands recorded`;
}

function buildCheckpointSuggestions(checkpoint: ExplainItem): SuggestionItem[] {
  const suggestions: SuggestionItem[] = [];

  if (!checkpoint.prompt) {
    suggestions.push({
      title: "Prompt metadata missing",
      detail: "This checkpoint does not contain the original AI prompt, so intent review depends more heavily on summary, rationale, and diff context."
    });
  } else {
    suggestions.push({
      title: "Compare prompt against diff",
      detail: "Use the recorded prompt to verify the file changes still match the original AI request and did not drift into unrelated edits."
    });
  }

  if (checkpoint.testStatus === "unknown") {
    suggestions.push({
      title: "Validation not recorded",
      detail: "No passing or failing validation result was stored for this checkpoint, so review should confirm which checks were actually run."
    });
  }

  if (checkpoint.bootstrappedFromBranch) {
    suggestions.push({
      title: "Bootstrapped branch checkpoint",
      detail: `This branch inherited shadow history from ${checkpoint.bootstrappedFromBranch}; verify the first branch-local checkpoint only contains intended edits.`
    });
  }

  if (checkpoint.filesChanged.some((file) => file === "package.json" || file.endsWith("package-lock.json"))) {
    suggestions.push({
      title: "Dependency or workflow change",
      detail: "Package metadata changed, so review should confirm install/build scripts and dependency intent still line up."
    });
  }

  if (checkpoint.filesChanged.some((file) => file.startsWith("scripts/") || file.startsWith(".codex/") || file.startsWith(".github/hooks/"))) {
    suggestions.push({
      title: "Hook or automation change",
      detail: "This checkpoint touches workflow automation or hooks, so the safest review path is a simulated run with realistic payloads."
    });
  }

  if (checkpoint.filesChanged.some((file) => file.startsWith("src/"))) {
    suggestions.push({
      title: "Runtime code touched",
      detail: "Application source files changed, so code review should include runtime behavior and not just configuration correctness."
    });
  }

  if (suggestions.length === 0) {
    suggestions.push({
      title: "No special risks detected",
      detail: "This checkpoint looks straightforward from metadata alone; use the file diff to confirm there are no hidden side effects."
    });
  }

  return suggestions;
}

function buildFileReviewHints(checkpoint: ExplainItem, reviewFiles: ParsedDiffFile[]): SuggestionItem[] {
  const suggestions: SuggestionItem[] = [];

  if (reviewFiles.length > 0) {
    const sortedByChurn = [...reviewFiles].sort(
      (left, right) => right.additions + right.deletions - (left.additions + left.deletions)
    );
    const topFile = sortedByChurn[0];
    suggestions.push({
      title: "Start with the highest-churn file",
      detail: `${topFile.filePath} has the largest visible patch footprint in this checkpoint and is the best first review target.`
    });
  } else if (checkpoint.filesChanged.length > 0) {
    suggestions.push({
      title: "Use file snapshots first",
      detail: "No parsed inline diff is available, so start by opening the recorded file snapshots for the changed files."
    });
  }

  const uiFiles = checkpoint.filesChanged.filter((file) => /\.(tsx?|jsx?|html|css|scss)$/i.test(file));
  if (uiFiles.length > 0) {
    suggestions.push({
      title: "UI or presentation files changed",
      detail: `Review visible behavior for ${uiFiles.slice(0, 3).join(", ")}${uiFiles.length > 3 ? " and related files" : ""}.`
    });
  }

  const configFiles = checkpoint.filesChanged.filter((file) =>
    file.includes("hook") || file.endsWith(".json") || file.endsWith(".yaml") || file.endsWith(".yml") || file.endsWith(".mjs")
  );
  if (configFiles.length > 0) {
    suggestions.push({
      title: "Config and scripting touched",
      detail: "Config and helper scripts changed, so confirm payload shape, command invocation, and path handling with a realistic replay."
    });
  }

  if (suggestions.length === 0) {
    suggestions.push({
      title: "Review file ordering is simple",
      detail: "Work through the changed files in order and confirm each one maps cleanly back to the checkpoint summary."
    });
  }

  return suggestions;
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

function saveRecentRepositories(items: RepositoryOption[]): void {
  window.localStorage.setItem(RECENT_REPOSITORIES_KEY, JSON.stringify(items.slice(0, 8)));
}

export function App() {
  const diffCardRef = useRef<HTMLElement | null>(null);
  const summaryListRef = useRef<HTMLDivElement | null>(null);
  const summaryCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const [mode, setMode] = useState<SurfaceMode>("review");
  const [checkpointDetailTab, setCheckpointDetailTab] = useState<CheckpointDetailTab>("intent");
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [selectedBranches, setSelectedBranches] = useState<Record<string, boolean>>({});
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
  const [previewText, setPreviewText] = useState<string>("Git commit preview will appear here.");
  const [exportMessage, setExportMessage] = useState<string>("Anvil export");
  const [busy, setBusy] = useState<boolean>(false);
  const [branchBusy, setBranchBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
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
    await loadBranches(response.repositoryRoot);

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
        setPreviewText("Git commit preview will appear here.");
      }

      return latest;
    });
  }

  async function loadBranches(repoOverride?: string) {
    const repo = repoOverride ?? (selectedRepositoryRoot || undefined);
    const response = await fetchBranches(repo);
    setBranches(response.branches);
    setSelectedBranches((current) => {
      const next: Record<string, boolean> = {};
      for (const branch of response.branches) {
        if (current[branch.branch]) {
          next[branch.branch] = true;
        }
      }
      return next;
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
    setPreviewText("Git commit preview will appear here.");
    setDiffText("Loading diff...");

    try {
      await loadTimeline(false, trimmed);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteBranches(branchNames: string[]) {
    if (branchNames.length === 0) {
      return;
    }

    setBranchBusy(true);
    setError(null);
    try {
      const response = await deleteBranches(branchNames, selectedRepositoryRoot || undefined);
      setBranches(response.branches);
      setSelectedBranches((current) => {
        const next = { ...current };
        for (const branch of branchNames) {
          delete next[branch];
        }
        return next;
      });
      await loadTimeline();
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBranchBusy(false);
    }
  }

  async function handleKeepSelectedBranches() {
    const branchNames = Object.entries(selectedBranches)
      .filter(([, selected]) => selected)
      .map(([branch]) => branch);
    if (branchNames.length === 0) {
      return;
    }

    setBranchBusy(true);
    setError(null);
    try {
      const response = await keepBranches(branchNames, selectedRepositoryRoot || undefined);
      setBranches(response.branches);
      setSelectedBranches(Object.fromEntries(branchNames.map((branch) => [branch, true])));
      await loadTimeline();
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBranchBusy(false);
    }
  }

  const selectedBranchNames = Object.entries(selectedBranches)
    .filter(([, selected]) => selected)
    .map(([branch]) => branch);

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
  const checkpointSuggestions = selectedCheckpoint ? buildCheckpointSuggestions(selectedCheckpoint) : [];
  const fileReviewHints = selectedCheckpoint ? buildFileReviewHints(selectedCheckpoint, reviewFiles) : [];

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

  function renderDiffSurface(title: string, actionLabel = "Refresh Diff") {
    return (
      <section className="card mode-panel mode-diff-card" ref={diffCardRef}>
        <div className="section-heading">
          <h2>{title}</h2>
          <button onClick={() => void loadDiff(selectedCheckpointId ?? undefined)} type="button">
            {actionLabel}
          </button>
        </div>
        {diffViewMode === "summary" ? (
          reviewFiles.length > 0 ? (
            <div className="card-scroll summary-file-list" ref={summaryListRef}>
              {reviewFiles.map((file) => renderSummaryCard(file))}
            </div>
          ) : (
            <pre>{diffText || "No net patch is available for this checkpoint versus its parent."}</pre>
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
          <pre>{diffText || "No diff is available for this selection."}</pre>
        )}
      </section>
    );
  }

  function renderReviewMode() {
    return (
      <section className="mode-layout review-layout">
        <section className="card mode-panel mode-side-panel">
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
            <p>No changed files are available for the selected checkpoint yet.</p>
          )}
        </section>

        {renderDiffSurface("Files Review")}

        <section className="card mode-panel action-panel">
          <div className="section-heading">
            <h2>Review Actions</h2>
            <span>{selectedCheckpointId ?? "No checkpoint"}</span>
          </div>
          <div className="detail-grid">
            <div>
              <span className="label">Checkpoint</span>
              <p>{selectedCheckpoint?.checkpointId ?? "No checkpoint selected"}</p>
            </div>
            <div>
              <span className="label">Branch</span>
              <p>{selectedCheckpoint?.gitBranch ?? currentBranch ?? "unknown"}</p>
            </div>
            <div>
              <span className="label">Summary</span>
              <p>{selectedCheckpoint?.summary ?? "Select a checkpoint from History to inspect details."}</p>
            </div>
            <div>
              <span className="label">Shadow Ref</span>
              <p className="mono">{selectedCheckpoint?.shadowRef ?? "unknown"}</p>
            </div>
            <div className="action-stack">
              <button onClick={() => void handleRestore()} type="button" disabled={!selectedCheckpointId || busy}>
                Restore This Checkpoint
              </button>
              <button onClick={() => void handlePreview()} type="button" disabled={busy}>
                {busy ? "Working..." : "Refresh Git Commit Preview"}
              </button>
            </div>
          </div>
          <div className="preview-block">
            <div className="diff-header">
              <span>Git Commit Preview</span>
              <span>What Anvil would export into real Git</span>
            </div>
            <pre>{previewText}</pre>
          </div>
        </section>
      </section>
    );
  }

  function renderHistoryMode() {
    const detailTabs: Array<[CheckpointDetailTab, string]> = [
      ["intent", "Intent"],
      ["files", "Files"],
      ["lineage", "Lineage"],
      ["debug", "Debug"]
    ];

    return (
      <section className="mode-layout history-layout">
        <section className="card mode-panel history-timeline-panel">
          <div className="section-heading">
            <h2>Branch Timeline</h2>
            <span>{timeline.length} checkpoint{timeline.length === 1 ? "" : "s"}</span>
          </div>
          {timeline.length > 0 ? (
            <div className="card-scroll timeline-list history-list">
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
        </section>

        {renderDiffSurface(selectedFile ? `History Diff: ${selectedFile.filePath}` : "History Diff")}

        <section className="card mode-panel history-detail-panel">
          <div className="section-heading">
            <h2>Checkpoint Details</h2>
            <div className="section-actions">
              <span>{selectedCheckpointId ?? "No checkpoint"}</span>
              <button onClick={() => void handleRestore()} type="button" disabled={!selectedCheckpointId || busy}>
                Restore
              </button>
            </div>
          </div>
          {selectedCheckpoint ? (
            <div className="checkpoint-detail-stack">
              <div className="checkpoint-action-strip">
                <div className="checkpoint-chip-row">
                  <span className="detail-chip">{selectedCheckpoint.kind}</span>
                  <span className="detail-chip">{selectedCheckpoint.testStatus}</span>
                  <span className="detail-chip">{selectedCheckpoint.filesChanged.length} files</span>
                </div>
                <div className="checkpoint-action-strip-right">
                  <span className="toolbar-chip">Suggestions ready</span>
                </div>
              </div>

              <nav className="checkpoint-detail-tabs">
                {detailTabs.map(([value, label]) => (
                  <button
                    key={value}
                    className={`checkpoint-detail-tab${checkpointDetailTab === value ? " active" : ""}`}
                    onClick={() => setCheckpointDetailTab(value)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </nav>

              {checkpointDetailTab === "intent" ? (
                <div className="detail-grid checkpoint-detail-grid">
                  <section className="checkpoint-summary-card detail-section-wide">
                    <span className="label">Summary</span>
                    <h3>{selectedCheckpoint.summary}</h3>
                    <p className="checkpoint-summary-meta">
                      {selectedCheckpoint.checkpointId} recorded at {formatTime(selectedCheckpoint.timestamp)}
                    </p>
                    <div className="checkpoint-chip-row checkpoint-summary-tags">
                      <span className="detail-chip">
                        {selectedCheckpoint.origin === "ai" ? `AI${selectedCheckpoint.aiSource ? `: ${selectedCheckpoint.aiSource}` : ""}` : "Manual"}
                      </span>
                    </div>
                  </section>

                  <section className="detail-section detail-section-wide">
                    <h3>AI Rationale</h3>
                    {selectedCheckpoint.rationale ? (
                      <p>{selectedCheckpoint.rationale}</p>
                    ) : (
                      <div className="empty-state">
                        <strong>No recorded rationale for this checkpoint yet.</strong>
                        <p>
                          Rich AI intent has not been stored on this checkpoint. Later, this tab should show recorded
                          rationale first and only offer generated fallback intent explicitly.
                        </p>
                      </div>
                    )}
                  </section>

                  <section className="detail-section detail-section-wide">
                    <h3>Prompt</h3>
                    {selectedCheckpoint.prompt ? (
                      <details className="prompt-disclosure" open>
                        <summary>Show recorded prompt</summary>
                        <pre>{selectedCheckpoint.prompt}</pre>
                      </details>
                    ) : (
                      <div className="empty-state">
                        <strong>No prompt was recorded.</strong>
                        <p>This checkpoint predates prompt capture or was created without AI prompt metadata.</p>
                      </div>
                    )}
                    {selectedCheckpoint.promptHash ? (
                      <div className="detail-pair prompt-hash-row">
                        <span className="label">Prompt Hash</span>
                        <p className="mono">{selectedCheckpoint.promptHash}</p>
                      </div>
                    ) : null}
                  </section>

                  <section className="detail-section detail-section-wide">
                    <h3>Suggestions</h3>
                    <div className="detail-stack">
                      {checkpointSuggestions.map((suggestion) => (
                        <div key={suggestion.title} className="detail-pair">
                          <span className="label">{suggestion.title}</span>
                          <p>{suggestion.detail}</p>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              ) : null}

              {checkpointDetailTab === "files" ? (
                <div className="detail-grid checkpoint-detail-grid">
                  <section className="checkpoint-stat-grid detail-section-wide">
                    <div className="checkpoint-stat-card">
                      <span className="label">Files Changed</span>
                      <strong>{selectedCheckpoint.filesChanged.length}</strong>
                    </div>
                    <div className="checkpoint-stat-card">
                      <span className="label">Diff Context</span>
                      <strong>{selectedFilePath ? `Focused on ${selectedFilePath}` : "All changed files"}</strong>
                    </div>
                  </section>

                  <section className="detail-section detail-section-wide">
                    <h3>Changed Files</h3>
                    {selectedCheckpoint.filesChanged.length > 0 ? (
                      <div className="detail-file-list">
                        {selectedCheckpoint.filesChanged.map((file) => (
                          <button
                            key={file}
                            className={`detail-file-chip detail-file-chip-button${selectedFilePath === file ? " active" : ""}`}
                            onClick={() => jumpToReviewedFile(file)}
                            type="button"
                          >
                            {file}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p>No file list recorded for this checkpoint.</p>
                    )}
                  </section>

                  <section className="detail-section detail-section-wide">
                    <h3>File Review Hints</h3>
                    <div className="detail-stack">
                      {fileReviewHints.map((suggestion) => (
                        <div key={suggestion.title} className="detail-pair">
                          <span className="label">{suggestion.title}</span>
                          <p>{suggestion.detail}</p>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              ) : null}

              {checkpointDetailTab === "lineage" ? (
                <div className="detail-grid checkpoint-detail-grid">
                  <section className="checkpoint-stat-grid detail-section-wide">
                    <div className="checkpoint-stat-card">
                      <span className="label">Parent</span>
                      <strong>{selectedCheckpoint.parentCheckpointId ?? "Root checkpoint"}</strong>
                    </div>
                    <div className="checkpoint-stat-card">
                      <span className="label">Restore Source</span>
                      <strong>{selectedCheckpoint.restoreSourceCheckpointId ?? "None"}</strong>
                    </div>
                  </section>

                  <section className="detail-section">
                    <h3>Parentage</h3>
                    <div className="detail-pair">
                      <span className="label">Parent Checkpoint</span>
                      <p>{selectedCheckpoint.parentCheckpointId ?? "This checkpoint starts the branch timeline."}</p>
                    </div>
                    <div className="detail-pair">
                      <span className="label">Restore Provenance</span>
                      <p>
                        {selectedCheckpoint.restoreSourceCheckpointId
                          ? `Restored from ${selectedCheckpoint.restoreSourceCheckpointId}`
                          : "Recorded directly from workspace state"}
                      </p>
                    </div>
                  </section>

                  <section className="detail-section">
                    <h3>Bootstrap</h3>
                    <div className="detail-pair">
                      <span className="label">Bootstrap Source</span>
                      <p>
                        {selectedCheckpoint.bootstrappedFromBranch
                          ? `${selectedCheckpoint.bootstrappedFromBranch} via ${selectedCheckpoint.bootstrappedFromCheckpointId ?? "unknown checkpoint"}`
                          : "Native branch checkpoint"}
                      </p>
                    </div>
                    <div className="detail-pair">
                      <span className="label">Bootstrapped At</span>
                      <p>{selectedCheckpoint.bootstrappedAt ? formatTime(selectedCheckpoint.bootstrappedAt) : "Not bootstrapped"}</p>
                    </div>
                  </section>
                </div>
              ) : null}

              {checkpointDetailTab === "debug" ? (
                <div className="detail-grid checkpoint-detail-grid">
                  <section className="detail-section">
                    <h3>Copyable Ids</h3>
                    <div className="detail-pair">
                      <span className="label">Shadow Commit</span>
                      <div className="copy-row">
                        <code className="mono">{selectedCheckpoint.shadowCommitSha}</code>
                        <button
                          onClick={() => void navigator.clipboard.writeText(selectedCheckpoint.shadowCommitSha)}
                          type="button"
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                    <div className="detail-pair">
                      <span className="label">Checkpoint Id</span>
                      <div className="copy-row">
                        <code className="mono">{selectedCheckpoint.checkpointId}</code>
                        <button
                          onClick={() => void navigator.clipboard.writeText(selectedCheckpoint.checkpointId)}
                          type="button"
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                    <div className="detail-pair">
                      <span className="label">Shadow Ref</span>
                      <div className="copy-row">
                        <code className="mono">{selectedCheckpoint.shadowRef ?? "unknown"}</code>
                        <button
                          onClick={() => void navigator.clipboard.writeText(selectedCheckpoint.shadowRef ?? "unknown")}
                          type="button"
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                    <div className="detail-pair">
                      <span className="label">Prompt Hash</span>
                      <div className="copy-row">
                        <code className="mono">{selectedCheckpoint.promptHash ?? "Not recorded"}</code>
                        <button
                          onClick={() => void navigator.clipboard.writeText(selectedCheckpoint.promptHash ?? "")}
                          type="button"
                          disabled={!selectedCheckpoint.promptHash}
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                  </section>

                  <section className="detail-section">
                    <h3>Command Tags</h3>
                    {selectedCheckpoint.commandsRun.length > 0 ? (
                      <div className="detail-command-list">
                        {selectedCheckpoint.commandsRun.map((command) => (
                          <code key={command} className="detail-command-chip">
                            {command}
                          </code>
                        ))}
                      </div>
                    ) : (
                      <p>No commands were recorded for this checkpoint.</p>
                    )}
                    <div className="detail-pair debug-note">
                      <span className="label">Command Summary</span>
                      <p>{formatCommandLabel(selectedCheckpoint.commandsRun)}</p>
                    </div>
                  </section>
                </div>
              ) : null}
            </div>
          ) : (
            <p>No checkpoint selected.</p>
          )}
        </section>
      </section>
    );
  }

  function renderManageMode() {
    return (
      <section className="mode-layout manage-layout">
        <section className="card mode-panel manage-branch-panel">
          <div className="section-heading">
            <h2>Shadow Branches</h2>
            <div className="section-actions">
              <span>{branches.length} branch{branches.length === 1 ? "" : "es"}</span>
              <button
                onClick={() => setSelectedBranches(Object.fromEntries(branches.map((branch) => [branch.branch, true])))}
                type="button"
                disabled={branchBusy || branches.length === 0}
              >
                Select All
              </button>
              <button
                onClick={() => setSelectedBranches({})}
                type="button"
                disabled={branchBusy || selectedBranchNames.length === 0}
              >
                Clear
              </button>
              <button
                onClick={() => void handleDeleteBranches(selectedBranchNames)}
                type="button"
                disabled={branchBusy || selectedBranchNames.length === 0}
              >
                Delete Selected
              </button>
              <button
                onClick={() => void handleKeepSelectedBranches()}
                type="button"
                disabled={branchBusy || selectedBranchNames.length === 0}
              >
                Keep Selected
              </button>
            </div>
          </div>
          {branches.length > 0 ? (
            <div className="branch-list">
              {branches.map((branch) => (
                <label key={branch.branch} className="branch-row">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedBranches[branch.branch])}
                    onChange={(event) =>
                      setSelectedBranches((current) => ({
                        ...current,
                        [branch.branch]: event.target.checked
                      }))
                    }
                  />
                  <div className="branch-row-body">
                    <div className="branch-row-top">
                      <strong>{branch.branch}</strong>
                      {branch.branch === currentBranch ? <span className="branch-chip-inline">Current</span> : null}
                    </div>
                    <div className="branch-row-meta">
                      <span>{branch.checkpointCount} checkpoint{branch.checkpointCount === 1 ? "" : "s"}</span>
                      <span>{branch.latestCheckpointId ?? "none"}</span>
                      <span>{branch.latestTimestamp ? formatTime(branch.latestTimestamp) : "No timestamp"}</span>
                    </div>
                    {branch.shadowRef ? <div className="mono branch-row-ref">{branch.shadowRef}</div> : null}
                  </div>
                  <button
                    onClick={(event) => {
                      event.preventDefault();
                      void handleDeleteBranches([branch.branch]);
                    }}
                    type="button"
                    disabled={branchBusy}
                  >
                    Delete
                  </button>
                </label>
              ))}
            </div>
          ) : (
            <p>No Anvil shadow branches exist in this repo yet.</p>
          )}
        </section>

        <section className="card mode-panel manage-info-panel">
          <div className="section-heading">
            <h2>Manage</h2>
            <span>Admin and cleanup surface</span>
          </div>
          <div className="detail-grid">
            <div>
              <span className="label">Current Branch</span>
              <p>{currentBranch ?? "unknown"}</p>
            </div>
            <div>
              <span className="label">Shadow Branches</span>
              <p>{branches.length}</p>
            </div>
            <div>
              <span className="label">Retention</span>
              <p>Use <span className="mono">anvil prune</span> to apply retention settings from <span className="mono">.anvil/config.json</span>.</p>
            </div>
            <div>
              <span className="label">Hooks</span>
              <p>Use <span className="mono">anvil hook status</span> to inspect Copilot/Codex hook readiness and the latest execution log.</p>
            </div>
            <div>
              <span className="label">Danger Zone</span>
              <p>Delete stale shadow branches here, or use <span className="mono">anvil uninstall</span> to remove Anvil from the repo entirely.</p>
            </div>
          </div>
        </section>
      </section>
    );
  }

  return (
    <div className="surface-shell">
      <main className="surface-main">
        <header className="surface-hero">
          <div className="surface-topline">
            <div>
              <div className="eyebrow">Shadow Review</div>
              <h1>Anvil Review Surface</h1>
              <p>Review current branch changes, browse checkpoint history, and manage Anvil state without mixing those jobs together.</p>
            </div>
            <div className="surface-status">
              <div className="repo-chip">{repositoryName}</div>
              <div className="branch-chip">Branch: {currentBranch ?? "unknown"}</div>
              {selectedCheckpoint ? (
                <div className="branch-chip">Checkpoint: {selectedCheckpoint.checkpointId}</div>
              ) : null}
            </div>
          </div>

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
            <div className="hero-repo-card compact-actions">
              <span className="hero-repo-label">Review Actions</span>
              <input
                value={exportMessage}
                onChange={(event) => setExportMessage(event.target.value)}
                placeholder="Export commit message"
              />
              <div className="inline-actions">
                <button onClick={() => void loadTimeline()} type="button">
                  Refresh Timeline
                </button>
                <button onClick={() => void handlePreview()} type="button" disabled={busy}>
                  {busy ? "Working..." : "Refresh Preview"}
                </button>
              </div>
            </div>
          </div>
        </header>

        <nav className="mode-tabs">
          {[
            ["review", "Review"],
            ["history", "History"],
            ["manage", "Manage"]
          ].map(([value, label]) => (
            <button
              key={value}
              className={`mode-tab${mode === value ? " active" : ""}`}
              onClick={() => setMode(value as SurfaceMode)}
              type="button"
            >
              {label}
            </button>
          ))}
        </nav>

        {error ? <div className="error-banner">{error}</div> : null}

        <section className="mode-bar card">
          <div className="mode-title-block">
            <strong>{mode === "review" ? "Review" : mode === "history" ? "History" : "Manage"}</strong>
            <span className="panel-subtitle">
              {mode === "review"
                ? "Focus on current branch changes, file review, restore, and Git export."
                : mode === "history"
                  ? "Browse branch-local checkpoints, inspect diffs, and understand how you got here."
                  : "Manage shadow branches and other Anvil maintenance tasks."}
            </span>
          </div>
          <div className="diff-toolbar">
            <div className="toolbar-chip">{repositoryName}</div>
            <div className="toolbar-chip">Branch {currentBranch ?? "unknown"}</div>
            <div className="toolbar-chip">{reviewFiles.length} changed files</div>
            {mode !== "manage" && diffViewMode !== "summary" ? (
              <button
                onClick={() => {
                  setDiffViewMode("summary");
                  setFileSnapshot(null);
                }}
                type="button"
              >
                Back to Summary
              </button>
            ) : null}
            {mode !== "manage" ? (
              <select value={diffViewMode} onChange={(event) => setDiffViewMode(event.target.value as DiffViewMode)}>
                <option value="summary">Summary view</option>
                <option value="unified">Unified diff</option>
                <option value="side-by-side">Side-by-side</option>
                <option value="snapshot">File snapshot</option>
              </select>
            ) : null}
          </div>
        </section>

        {mode === "review" ? renderReviewMode() : mode === "history" ? renderHistoryMode() : renderManageMode()}
      </main>
    </div>
  );
}
