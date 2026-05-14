import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CheckpointStore } from "./store.js";

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

app.get("/api/timeline", async (request, response) => {
  const store = storeForRequest(request);
  const timeline = await store.timeline();
  response.json(timeline);
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
