# anvil

Anvil is a local checkpointing and review tool for AI-driven code changes.

It keeps a private, branch-aware shadow history in `.anvil/` so you can:
- checkpoint AI work without polluting normal Git history
- review file changes in a local web UI
- restore a previous checkpoint
- export the final state into real Git only when you want to

## Mental Model

Anvil has two layers:

- Real Git
  Your normal repository, branches, commits, pushes, PRs.
- Shadow Anvil history
  Private checkpoints stored in `.anvil/store.git` plus metadata in `.anvil/metadata.jsonl`.

This means:
- AI can make lots of local edits
- Anvil can snapshot and review them privately
- your real Git history stays clean until you explicitly export

## What Anvil Stores

Inside any repo that uses Anvil:

```text
.anvil/
  config.json
  hooks.yaml
  metadata.jsonl
  store.git/
```

- `store.git` is the hidden shadow Git repository
- `metadata.jsonl` is the append-only checkpoint log
- `hooks.yaml` is the optional repo-local hook config
- checkpoints are branch-aware
- each Git branch maps to an internal shadow ref like `refs/anvil/main`

## Install From Git Clone

Clone the Anvil repo:

```bash
git clone https://github.com/Gaborpg/anvil.git
cd anvil
```

Install dependencies:

```bash
npm install
```

Build the CLI and review app:

```bash
npm run build:all
```

Install the CLI globally on your machine:

```bash
npm link
```

After that, `anvil` should work from any Git repository on your machine.

## Short Global Install And Uninstall

If Anvil is already available locally from source, you can use the built-in shortcuts:

```bash
anvil install -g
anvil uninstall -g
```

What they do:
- `anvil install -g`
  runs `npm install`, `npm run build:all`, and `npm link`
- `anvil uninstall -g`
  removes the global Anvil CLI whether it was installed with `npm install -g` or `npm link`

Important first-time note:
- if Anvil is not available yet, you still need an initial bootstrap path such as:
  ```bash
  npm install
  npm run dev -- install -g
  ```
- after that, future upgrades can use:
  ```bash
  anvil install -g
  ```

Check it:

```bash
anvil --help
```

If you want the manual uninstall path instead of the shortcut:

```bash
npm uninstall -g anvil
```

If it was installed with `npm link`, the fallback is:

```bash
npm unlink -g anvil
```

To see where `anvil` is currently coming from on Windows:

```bash
where anvil
```

## Use Anvil In Another Repo

Go to any normal Git repo:

```bash
cd C:\path\to\your\repo
```

Initialize Anvil explicitly:

```bash
anvil init
```

`anvil init` now bootstraps all the basic repo-local Anvil wiring:
- `.anvil/config.json`
- `.anvil/metadata.jsonl`
- `.anvil/store.git`
- `.anvil/hooks.yaml`
- `.github/hooks/anvil-copilot.json`
- `.codex/hooks.json`

The Copilot and Codex hooks are installed, but auto-checkpointing stays disabled until you set `autoCheckpoint: true` in `.anvil/hooks.yaml`.

Or skip that and just use any normal Anvil command. Most commands auto-initialize `.anvil/` on first use.

## Start The Review App

From the repo you want to inspect:

```bash
anvil review
```

By default it serves the local review UI at:

```text
http://localhost:4312/
```

Use another port if needed:

```bash
anvil review --port 4313
```

## Core Commands

```bash
anvil init
anvil install-codex-hook
anvil install-copilot-hook
anvil review [--port 4312]
anvil checkpoint --summary "Updated parser logic"
anvil hook codex-after-edit
anvil hook copilot-after-edit
anvil hook status
anvil timeline
anvil diff [checkpoint] [checkpoint]
anvil restore <checkpoint>
anvil explain <checkpoint>
anvil assign-branch <checkpoint> [branch]
anvil export [--preview] [--message "message"]
anvil compact --mode keep-last|squash
anvil uninstall
```

## Typical Workflow

1. Ask your AI tool to make file changes.
2. Save those changes into Anvil:

```bash
anvil checkpoint --summary "Refactor parser validation"
```

3. Open the review UI:

```bash
anvil review
```

4. Review:
   - Changed Files
   - Files Review
   - Checkpoint Details
   - Git Commit Preview

5. If the change is bad:

```bash
anvil restore cp-3
```

6. If the change is good, preview the Git handoff:

```bash
anvil export --preview --message "Refactor parser validation"
```

7. If you want the real Git commit:

```bash
anvil export --message "Refactor parser validation"
```

## Checkpoints

Create a checkpoint:

```bash
anvil checkpoint --summary "Updated parser logic"
```

Create a scoped checkpoint for only specific files:

```bash
anvil checkpoint --summary "Updated parser logic" --only src/parser.ts,src/tokenizer.ts
```

Checkpoint after tests:

```bash
anvil checkpoint \
  --summary "Ran parser tests" \
  --kind after_test_run \
  --command "npm test" \
  --test-status passed
```

If there are no workspace changes, Anvil will tell you and skip creating an empty checkpoint.

When you use `--only`, Anvil creates a partial checkpoint scoped to those paths instead of bundling every dirty file in the repo into one checkpoint.

By default, Anvil also ignores a few of its own common temp/log files so they do not pollute checkpoints:
- `anvil-server.err.log`
- `anvil-server.out.log`
- `anvil-restore-smoke.txt`

You can add your own Anvil-specific ignore rules in:

```text
.anvilignore
```

Example:

```text
# Ignore local temp files for Anvil only
*.tmp
coverage/
dist/
my-local-note.txt
src/generated/**
!src/generated/keep.ts
```

This affects:
- normal checkpoints
- hook checkpoints
- full snapshot staging

It does not change your normal Git ignore rules.

`.anvilignore` now supports:
- `*`, `**`, and `?` globs
- basename rules like `*.tmp`
- path rules like `src/generated/**`
- directory rules like `coverage/`
- negation rules like `!src/generated/keep.ts`

Important:
- rules are evaluated in order, so later rules can override earlier ones
- Anvil's own built-in internal files are still always ignored

## Copilot Auto-Checkpoint Hook

VS Code Copilot hooks use workspace JSON files under:

```text
.github/hooks/
```

Install or refresh Anvil's VS Code Copilot hook file into the current repo:

```bash
anvil install-copilot-hook
```

`anvil init` already does this automatically, so you usually only need `install-copilot-hook` if you want to recreate or refresh the hook files later.

That creates:

```text
.github/hooks/anvil-copilot.json
```

The installed hook calls:

```bash
anvil hook copilot-after-edit --vscode-hook
```

Anvil still keeps the actual auto-checkpoint behavior disabled by default. To opt in, enable the repo-local Anvil hook config:

```yaml
copilot:
  autoCheckpoint: true
  summary: "Copilot file changes"
  kind: after_edit_batch
  command: copilot
  testStatus: unknown
```

Save that as:

```text
.anvil/hooks.yaml
```

Then have your Copilot post-edit hook call:

```bash
anvil hook copilot-after-edit
```

You can still override the defaults from the command line:

```bash
anvil hook copilot-after-edit --summary "Copilot refactor" --command "copilot" --test-status unknown
```

Important:
- VS Code discovers the workspace hook from `.github/hooks/anvil-copilot.json`
- this hook is disabled unless `.anvil/hooks.yaml` explicitly enables it
- if there are no file changes, Anvil will skip the checkpoint
- this creates an Anvil checkpoint, not a real Git commit
- the hook is safe to keep repo-local because it lives under `.anvil/`

## Codex Auto-Checkpoint Hook

Codex uses repo-local hook config in:

```text
.codex/hooks.json
```

Install or refresh Anvil's Codex hook file into the current repo:

```bash
anvil install-codex-hook
```

`anvil init` already does this automatically, so you usually only need `install-codex-hook` if you want to recreate or refresh the hook later.

That creates:

```text
.codex/hooks.json
```

The installed hook listens for Codex `PostToolUse` on `apply_patch` edits and calls:

```bash
anvil hook codex-after-edit --codex-hook
```

To enable it, turn on the repo-local Anvil hook config:

```yaml
codex:
  autoCheckpoint: true
  summary: "Codex file changes"
  kind: after_edit_batch
  command: codex
  testStatus: unknown
```

Important:
- Codex discovers the hook from `.codex/hooks.json`
- this hook is disabled unless `.anvil/hooks.yaml` explicitly enables it
- it targets `PostToolUse` for `apply_patch`, `Edit`, and `Write`
- it creates an Anvil checkpoint, not a real Git commit

## Hook Status

If you want to quickly check whether your repo is wired correctly for hook-based auto-checkpointing:

```bash
anvil hook status
```

or:

```bash
anvil hook doctor
```

This reports:
- resolved repo root
- launched-from folder if different
- current branch
- whether `.anvil/hooks.yaml` exists
- whether Copilot and Codex auto-checkpointing are enabled
- whether `.github/hooks/anvil-copilot.json` exists
- whether `.codex/hooks.json` exists
- whether `.anvilignore` exists
- the last recorded hook execution, including whether it was ignored, disabled, had no changes, or created a checkpoint
- which currently dirty Git paths are being ignored by Anvil

This is the fastest way to debug “why didn’t the hook run?” before chasing editor-specific behavior.

## Timeline

See the current branch timeline:

```bash
anvil timeline
```

Anvil timelines are branch-scoped:
- each checkpoint belongs to exactly one Git branch
- switching Git branches changes which timeline is shown
- restore/export validate branch context

## Diff

Show the latest checkpoint diff:

```bash
anvil diff cp-4
```

Compare two checkpoints:

```bash
anvil diff cp-2 cp-5
```

## Explain

Show metadata for a checkpoint:

```bash
anvil explain cp-4
```

This includes:
- branch
- shadow ref
- summary
- files changed
- test status
- shadow commit SHA
- restore source
- bootstrap lineage when relevant

## Restore

Restore workspace files to a checkpoint:

```bash
anvil restore cp-4
```

Important:
- restore is branch-aware
- Anvil records restore events in its own history
- new checkpoints use full workspace snapshots for reliable file restore

## Export To Real Git

Preview what would go into a real Git commit:

```bash
anvil export --preview --message "Add parser validation"
```

Create the real Git commit:

```bash
anvil export --message "Add parser validation"
```

This is the boundary between:
- private Anvil history
- canonical Git history

## Compact Anvil History

Keep only the latest checkpoint on the current branch:

```bash
anvil compact --mode keep-last
```

Squash the current branch's Anvil history into one retained checkpoint:

```bash
anvil compact --mode squash
```

These affect only `.anvil/`, not your real Git commit history.

## Remove Anvil From A Repo

Delete all Anvil state from the current repo:

```bash
anvil uninstall
```

This removes:
- `.anvil/config.json`
- `.anvil/metadata.jsonl`
- `.anvil/store.git`

It does not delete your real Git history.

## Branch Model

Anvil is branch-aware by design:

- each checkpoint belongs to exactly one Git branch
- shadow refs are separated per branch
- a new branch lazily gets a matching shadow ref when Anvil first runs on it
- the shadow branch can bootstrap from the inferred parent branch tip

Examples:

- real Git branch: `main`
- shadow ref: `refs/anvil/main`

- real Git branch: `feature/login`
- shadow ref: `refs/anvil/feature/login`

## Review UI

The local review UI is designed around:
- Changed Files
- Files Review
- Checkpoint Details
- Git Commit Preview

It also supports:
- summary file review cards
- file snapshots
- unified diff
- side-by-side diff
- collapsible panels
- repository switching

## Development

Run the CLI directly from source:

```bash
npm run dev -- timeline
```

Run the API server from source:

```bash
npm run dev:server
```

Run the frontend in Vite dev mode:

```bash
npm run dev:web
```

Build everything:

```bash
npm run build:all
```

Serve the built review app:

```bash
node ./dist/server.js
```

## Troubleshooting

If `anvil` is not found:

```bash
npm link
```

If the browser is blank or stale:
- restart `anvil review`
- refresh the page
- verify the server is actually serving the current build

If a repo has no Anvil history:
- run `anvil checkpoint --summary "..."` after making file changes
- then refresh `anvil review`

If you want to reset everything for a repo:

```bash
anvil uninstall
anvil init
```

## Current Status

Anvil is already useful, but still evolving.

Strong today:
- branch-aware shadow checkpoints
- local review UI
- checkpoint restore
- global CLI workflow
- repo cleanup and history compaction

Still improving:
- richer file tree behavior
- more polished diff rendering
- deeper UI actions for compact/uninstall/export flows
