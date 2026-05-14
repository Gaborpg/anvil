# anvil

Minimal Node/TypeScript CLI for local Anvil checkpointing backed by a hidden shadow Git repository.

## Commands

```bash
anvil init
anvil review
anvil checkpoint --summary "Updated parser logic"
anvil timeline
anvil diff [checkpoint] [checkpoint]
anvil restore <checkpoint>
anvil explain <checkpoint>
anvil assign-branch <checkpoint> [branch]
anvil export [--preview] [--message "message"]
```

## Install Globally

From the Anvil project itself:

```bash
npm install
npm run build:all
npm link
```

Then in any Git repository:

```bash
anvil init
anvil review
```

`anvil init` creates `.anvil/` if the repo has never been Anvil-enabled before. Most Anvil commands also auto-initialize the repo on first use, so you can usually go straight to `anvil review` or `anvil checkpoint`.

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

## Create a checkpoint

```bash
anvil checkpoint --summary "Updated parser logic"
anvil checkpoint --summary "Ran tests after parser update" --kind after_test_run --command "npm test" --test-status passed
```

## Development

```bash
npm install
npm run build
npm start -- timeline
```

## Local Review App

Run the review app directly from any Git repo:

```bash
anvil review
```

Or manually run the backend API:

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
