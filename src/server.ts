import cors from "cors";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CheckpointStore } from "./store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const repositoryRoot = process.cwd();
const store = new CheckpointStore(repositoryRoot);
const port = Number(process.env.ANVIL_PORT ?? 4312);

app.use(cors());
app.use(express.json());

app.get("/api/timeline", async (_request, response) => {
  const timeline = await store.timeline();
  response.json(timeline);
});

app.get("/api/checkpoints/:id", async (request, response) => {
  const checkpoint = await store.findCheckpoint(request.params.id);
  if (!checkpoint) {
    response.status(404).send("Checkpoint not found.");
    return;
  }

  response.json(checkpoint);
});

app.get("/api/diff", async (request, response) => {
  const from = typeof request.query.from === "string" ? request.query.from : undefined;
  const to = typeof request.query.to === "string" ? request.query.to : undefined;
  const diff = await store.diff(from, to);
  response.json({ diff });
});

app.get("/api/export-preview", async (request, response) => {
  const message = typeof request.query.message === "string" ? request.query.message : "Anvil export";
  const preview = await store.exportToGit(message, true);
  response.json({ preview });
});

app.post("/api/restore", async (request, response) => {
  const checkpointId = request.body?.checkpointId;
  if (typeof checkpointId !== "string" || checkpointId.length === 0) {
    response.status(400).send("checkpointId is required.");
    return;
  }

  const restoreEvent = await store.restore(checkpointId);
  response.json({ message: `Workspace restored via ${restoreEvent.checkpointId}` });
});

app.use(express.static(path.join(repositoryRoot, "web-dist")));

app.use((_request, response) => {
  const webDist = path.join(repositoryRoot, "web-dist");
  response.sendFile(path.join(webDist, "index.html"));
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  response.status(500).send(message);
});

await store.init();

app.listen(port, () => {
  console.log(`Anvil review API listening on http://localhost:${port}`);
  console.log(`Project root: ${repositoryRoot}`);
  console.log(`Server file: ${path.join(__dirname, "server.js")}`);
});
