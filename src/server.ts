import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CheckpointStore } from "./store.js";
import type { GeneratedInsightRecord } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const workspaceRoot = process.cwd();
const packageRoot = path.resolve(__dirname, "..");
const webRoot = path.join(packageRoot, "web-dist");
const port = Number(process.env.ANVIL_PORT ?? 4312);

app.use(cors());
app.use(express.json());

function resolveRepositoryRoot(input: unknown): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    return workspaceRoot;
  }

  const candidate = path.resolve(input.trim());
  if (!existsSync(path.join(candidate, ".git"))) {
    throw new Error(`Repository not found or not initialized with Git: ${candidate}`);
  }

  return candidate;
}

function storeForRequest(request: express.Request): CheckpointStore {
  const requestedRoot =
    request.method === "GET"
      ? request.query.repo
      : (request.body as { repo?: unknown } | undefined)?.repo;

  return new CheckpointStore(resolveRepositoryRoot(requestedRoot));
}

function normalizeVerificationLogRecord(record: GeneratedInsightRecord) {
  const metadata = (record.metadata ?? {}) as Record<string, unknown>;
  const logFilePath = typeof metadata.logFilePath === "string" ? metadata.logFilePath : null;
  return {
    checkpointId: record.checkpointId,
    extensionId: record.extensionId,
    title: record.title,
    body: record.body,
    createdAt: record.createdAt,
    profile:
      typeof metadata.profile === "string"
        ? metadata.profile
        : record.extensionId.replace(/^verification:/, "").replace(/^profile:/, ""),
    command: typeof metadata.command === "string" ? metadata.command : "",
    status: typeof metadata.status === "string" ? metadata.status : "unknown",
    exitCode: typeof metadata.exitCode === "number" ? metadata.exitCode : null,
    durationMs: typeof metadata.durationMs === "number" ? metadata.durationMs : null,
    logFilePath
  };
}

function normalizeOrchestrationRunRecord(record: GeneratedInsightRecord) {
  const metadata = (record.metadata ?? {}) as Record<string, unknown>;
  const logFilePath = typeof metadata.logFilePath === "string" ? metadata.logFilePath : null;
  return {
    checkpointId: record.checkpointId,
    extensionId: record.extensionId,
    title: record.title,
    body: record.body,
    createdAt: record.createdAt,
    actionId: typeof metadata.actionId === "string" ? metadata.actionId : record.extensionId.replace(/^orchestration:/, ""),
    actionType: typeof metadata.actionType === "string" ? metadata.actionType : "unknown",
    triggerPhase: typeof metadata.triggerPhase === "string" ? metadata.triggerPhase : "unknown",
    status: typeof metadata.status === "string" ? metadata.status : "unknown",
    command: typeof metadata.command === "string" ? metadata.command : "",
    durationMs: typeof metadata.durationMs === "number" ? metadata.durationMs : null,
    logFilePath,
    error: typeof metadata.error === "string" ? metadata.error : null,
    metadata
  };
}

app.get("/api/timeline", async (request, response) => {
  const store = storeForRequest(request);
  const timeline = await store.timeline();
  response.json(timeline);
});

app.get("/api/branches", async (request, response) => {
  const store = storeForRequest(request);
  const branches = await store.listBranches();
  response.json(branches);
});

app.get("/api/checkpoints/:id", async (request, response) => {
  const store = storeForRequest(request);
  const checkpoint = await store.findCheckpoint(request.params.id);
  if (!checkpoint) {
    response.status(404).send("Checkpoint not found.");
    return;
  }

  response.json(checkpoint);
});

app.get("/api/checkpoints/:id/insights", async (request, response) => {
  const store = storeForRequest(request);
  const insights = await store.generatedInsights(request.params.id);
  response.json({ insights });
});

app.get("/api/checkpoints/:id/verification-logs", async (request, response) => {
  const store = storeForRequest(request);
  const insights = await store.generatedInsights(request.params.id);
  const logs = insights
    .filter((item) => item.insightType === "verification" || item.insightType === "profile-run")
    .map(normalizeVerificationLogRecord)
    .filter((item) => Boolean(item.logFilePath))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  response.json({ logs });
});

app.get("/api/orchestration-runs", async (request, response) => {
  const store = storeForRequest(request);
  const insights = await store.generatedInsights();
  const runs = insights
    .filter((item) => item.insightType === "orchestration-run")
    .map(normalizeOrchestrationRunRecord)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  response.json({ runs });
});

app.get("/api/checkpoints/:id/verification-logs/content", async (request, response) => {
  const store = storeForRequest(request);
  const logFilePath = typeof request.query.path === "string" ? request.query.path : "";
  if (!logFilePath) {
    response.status(400).send("path is required.");
    return;
  }

  const insights = await store.generatedInsights(request.params.id);
  const allowedPaths = new Set(
    insights
      .filter((item) => item.insightType === "verification" || item.insightType === "profile-run")
      .map(normalizeVerificationLogRecord)
      .map((item) => item.logFilePath)
      .filter((item): item is string => Boolean(item))
  );

  if (!allowedPaths.has(logFilePath)) {
    response.status(404).send("Verification log not found for this checkpoint.");
    return;
  }

  const resolved = path.resolve(logFilePath);
  const logsRoot = path.resolve(store.baseDir, "verification-logs");
  if (!resolved.startsWith(logsRoot)) {
    response.status(400).send("Verification log path is outside the repo log store.");
    return;
  }

  const content = await readFile(resolved, "utf8");
  response.json({ logFilePath: resolved, content });
});

app.get("/api/orchestration-runs/content", async (request, response) => {
  const store = storeForRequest(request);
  const logFilePath = typeof request.query.path === "string" ? request.query.path : "";
  if (!logFilePath) {
    response.status(400).send("path is required.");
    return;
  }

  const insights = await store.generatedInsights();
  const allowedPaths = new Set(
    insights
      .filter((item) => item.insightType === "orchestration-run")
      .map(normalizeOrchestrationRunRecord)
      .map((item) => item.logFilePath)
      .filter((item): item is string => Boolean(item))
  );

  if (!allowedPaths.has(logFilePath)) {
    response.status(404).send("Orchestration log not found for this checkpoint.");
    return;
  }

  const resolved = path.resolve(logFilePath);
  const logsRoot = path.resolve(store.baseDir, "verification-logs");
  if (!resolved.startsWith(logsRoot)) {
    response.status(400).send("Orchestration log path is outside the repo log store.");
    return;
  }

  const content = await readFile(resolved, "utf8");
  response.json({ logFilePath: resolved, content });
});

app.get("/api/checkpoints/:id/file", async (request, response) => {
  const store = storeForRequest(request);
  const filePath = typeof request.query.path === "string" ? request.query.path : "";
  if (!filePath) {
    response.status(400).send("path is required.");
    return;
  }

  const snapshot = await store.fileSnapshot(request.params.id, filePath);
  response.json(snapshot);
});

app.get("/api/diff", async (request, response) => {
  const store = storeForRequest(request);
  const from = typeof request.query.from === "string" ? request.query.from : undefined;
  const to = typeof request.query.to === "string" ? request.query.to : undefined;
  const diff = await store.diff(from, to);
  response.json({ diff });
});

app.get("/api/export-preview", async (request, response) => {
  const store = storeForRequest(request);
  const message = typeof request.query.message === "string" ? request.query.message : "Anvil export";
  const preview = await store.exportToGit(message, true);
  response.json({ preview });
});

app.post("/api/restore", async (request, response) => {
  const store = storeForRequest(request);
  const checkpointId = request.body?.checkpointId;
  if (typeof checkpointId !== "string" || checkpointId.length === 0) {
    response.status(400).send("checkpointId is required.");
    return;
  }

  const restoreEvent = await store.restore(checkpointId);
  response.json({ message: `Workspace restored via ${restoreEvent.checkpointId}` });
});

app.post("/api/branches/delete", async (request, response) => {
  const store = storeForRequest(request);
  const branches = request.body?.branches;
  if (!Array.isArray(branches)) {
    response.status(400).send("branches is required.");
    return;
  }

  const result = await store.deleteBranches(
    branches.filter((branch): branch is string => typeof branch === "string" && branch.trim().length > 0)
  );
  response.json(result);
});

app.post("/api/branches/keep", async (request, response) => {
  const store = storeForRequest(request);
  const branches = request.body?.branches;
  if (!Array.isArray(branches)) {
    response.status(400).send("branches is required.");
    return;
  }

  const result = await store.keepOnlyBranches(
    branches.filter((branch): branch is string => typeof branch === "string" && branch.trim().length > 0)
  );
  response.json(result);
});

app.use(express.static(webRoot));

app.use((_request, response) => {
  response.sendFile(path.join(webRoot, "index.html"));
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  response.status(500).send(message);
});

await new CheckpointStore(workspaceRoot).init();

app.listen(port, () => {
  console.log(`Anvil review API listening on http://localhost:${port}`);
  console.log(`Workspace root: ${workspaceRoot}`);
  console.log(`Package root: ${packageRoot}`);
  console.log(`Server file: ${path.join(__dirname, "server.js")}`);
});
