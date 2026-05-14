# anvil

Minimal Node/TypeScript CLI for local Anvil checkpointing backed by a hidden shadow Git repository.

## Commands

```bash
anvil timeline
anvil diff [checkpoint] [checkpoint]
anvil restore <checkpoint>
anvil explain <checkpoint>
anvil assign-branch <checkpoint> [branch]
anvil export [--preview] [--message "message"]
```

## Branch Ownership

Each Anvil checkpoint belongs to exactly one Git branch.

- New checkpoints automatically record the current Git branch.
- Branch-scoped timeline views only show checkpoints assigned to that branch.
- Anvil keeps one shared shadow repo in `.anvil/store.git`, with a separate internal shadow ref per Git branch.
- If Anvil runs on a branch that has no shadow ref yet, it lazily creates one and bootstraps it from the inferred parent branch shadow tip when possible.
- Older legacy checkpoints with no branch must be assigned explicitly:

```bash
anvil assign-branch cp-1 main
```

## Internal record command

The current scaffold includes an internal recording command to simulate AI-driven edits:

```bash
anvil __record --kind after_edit_batch --summary "Updated parser logic" --files src/parser.ts
```

## Development

```bash
npm install
npm run build
npm start -- timeline
```

## Local Review App

Run the backend API:

```bash
npm run build
node ./dist/server.js
```

Then open the local review app in development mode:

```bash
npm run dev:web
```

Or build the frontend and serve the bundled app through the backend:

```bash
npm run build:web
node ./dist/server.js
```
