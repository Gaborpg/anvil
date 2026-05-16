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
  policy.yaml
  extensions.yaml
  metadata.jsonl
  generated-insights.jsonl
  store.git/
```

- `store.git` is the hidden shadow Git repository
- `metadata.jsonl` is the append-only checkpoint log
- `hooks.yaml` is the optional repo-local hook config
- `policy.yaml` is the optional repo-local execution safety policy
- `extensions.yaml` registers post-checkpoint analysis apps
- `generated-insights.jsonl` stores structured derived outputs keyed by checkpoint
- `config.json` also stores retention settings for prune
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
- `.anvil/generated-insights.jsonl`
- `.anvil/store.git`
- `.anvil/hooks.yaml`
- `.anvil/policy.yaml`
- `.anvil/extensions.yaml`
- `.anvilignore`
- `.github/hooks/anvil-copilot.json`
- `.anvil/anvil-execution-guard.mjs`
- `.codex/anvil-codex-after-edit.mjs`
- `.codex/hooks.json`

The Copilot and Codex hooks are installed, but auto-checkpointing stays disabled until you set `autoCheckpoint: true` in `.anvil/hooks.yaml`.
The shared execution guard is also installed, but it stays inactive until you set `executionGuard.enabled: true` in `.anvil/policy.yaml`.
Anvil also creates `.anvil/extensions.yaml`, which is where declared post-checkpoint analysis apps are registered.
If `.gitignore` exists, `anvil init` copies it into `.anvilignore` as a starting point so you can customize Anvil-specific ignores from there.

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
anvil guard evaluate [--vscode-hook|--codex-hook]
anvil repair-baseline
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
anvil prune [--dry-run] [--max-checkpoints-per-branch 50] [--max-hook-logs 500]
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

and a repo-local wrapper:

```text
.codex/anvil-codex-after-edit.mjs
```

The installed hook listens for Codex `PostToolUse` on `apply_patch` edits and calls the wrapper:

```bash
node .codex/anvil-codex-after-edit.mjs
```

What the wrapper is for:
- Codex hook payloads can describe edited files in different shapes
- the wrapper normalizes those payloads into a small file-scoped patch summary
- then it forwards that normalized payload into:
  ```bash
  anvil hook codex-after-edit --codex-hook
  ```
- that keeps Codex hook checkpoints focused on the files Codex actually edited instead of every dirty file in the repo

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

## Fallback Watcher

If your editor or agent does not reliably fire `PostToolUse`, you can run a local fallback watcher instead:

```bash
anvil watch
```

Useful options:

```bash
anvil watch --interval-ms 1500 --debounce-ms 2000 --summary "Watcher file changes"
```

What it does:
- polls Git-visible dirty files on an interval
- waits for them to stay stable for the debounce window
- records an Anvil checkpoint without relying on host hooks

Important:
- the watcher checkpoints the current dirty workspace state
- if multiple files are already dirty, they will be grouped into the same watcher checkpoint
- stop it with `Ctrl+C`

## Verification

Anvil can also run named verification commands against the latest checkpoint on the current branch.

Examples:

```bash
anvil verify build
anvil verify test
anvil verify lint
anvil verify --command "npm run build" --name build
```

What it does:
- resolves the named profile from `.anvil/extensions.yaml`
- runs the command in the repo
- attaches the result to the latest checkpoint as derived verification data
- writes the full stdout/stderr log under `.anvil/verification-logs`

Verification config lives in:

```text
.anvil/extensions.yaml
```

Example:

```yaml
verifications:
  enabled: false
  profiles:
    build:
      command: npm run build
      autoRun: false
    test:
      command: npm test -- --watch=false
      autoRun: false
    lint:
      command: npm run lint
      autoRun: false
```

Current behavior:
- manual `anvil verify ...` is implemented
- full logs are stored as separate files under `.anvil/verification-logs/<checkpointId>/`
- verification results are stored as derived records, not as new checkpoints
- auto-run policy fields are reserved for the next step

## Execution Safety Guard

Anvil can also install a repo-local pre-execution safety layer for AI-triggered tool calls.

What it is:
- one shared repo-local guard script:
  ```text
  .anvil/anvil-execution-guard.mjs
  ```
- one repo-local policy file:
  ```text
  .anvil/policy.yaml
  ```
- Codex and Copilot pre-tool hooks both call the same guard

The guard is installed by:
- `anvil init`
- `anvil install-codex-hook`
- `anvil install-copilot-hook`

But it is disabled by default. To enable it:

```yaml
executionGuard:
  enabled: true
```

### Default Model

The first version is:
- allow by default
- deny clearly destructive operations
- ask for medium-risk operations

Built-in deny examples:
- `git reset --hard`
- `git clean -fdx`
- `git push --force`
- `rm -rf`
- `npm publish`
- `dotnet nuget push`
- destructive database reset/drop commands
- AI edits to `.git/`, `.anvil/`, `.codex/`, `.env`, keys, and similar sensitive files

Built-in ask examples:
- package installs like `npm install`, `pnpm add`, `dotnet add package`
- migrations like `dotnet ef`, `prisma migrate`, `rails db:migrate`
- outbound fetch commands like `curl`, `wget`, `Invoke-WebRequest`
- edits to `package.json`, lockfiles, workflow files, `Dockerfile`, and `*.csproj`
- broad rewrites touching more than the configured file threshold

Built-in allow examples:
- common test commands like `npm test`, `vitest`, `dotnet test`, `pytest`
- common build/dev commands like `npm run build`, `vite`, `ng serve`, `dotnet build`, `dotnet run`

### Policy File

Starter policy created by `anvil init` looks like:

```yaml
executionGuard:
  enabled: false
  maxFilesBeforeAsk: 20

  allowedTestCommands:
    - npm test
    - dotnet test

  allowedBuildCommands:
    - npm run build
    - dotnet build

  askCommands:
    - npm install
    - dotnet ef

  denyCommands:
    - git reset --hard
    - npm publish

  askPaths:
    - package.json
    - .github/workflows/

  denyPaths:
    - .git/
    - .anvil/
    - .codex/
    - .env
```

### Guard Behavior

When the guard sees a tool call, it returns one of:
- `allow`
- `ask`
- `deny`

Each result includes:
- a category
- a reason
- a suggested next step

Examples:
- `DENY destructive-git: git reset --hard is blocked by Anvil execution policy.`
- `ASK package-install: pnpm add requires explicit approval in this repo.`

This layer is for AI-triggered tool execution only in v1. It is not a full shell sandbox for all human terminal commands.

## Post-Checkpoint Extension Apps

Anvil can also run declared review/analysis apps after a checkpoint is already committed.

This is separate from the execution guard:
- `policy.yaml` controls pre-execution safety
- `extensions.yaml` registers post-checkpoint apps

### How It Works

1. Anvil records a checkpoint.
2. The checkpoint id is queued internally.
3. Anvil launches enabled extension apps in best-effort background mode.
4. Extension apps receive normalized checkpoint JSON on stdin.
5. They return structured insight JSON on stdout.
6. Anvil stores those results in:
   ```text
   .anvil/generated-insights.jsonl
   ```

This keeps checkpoint history authoritative while allowing derived outputs like:
- review hints
- risk reports
- file-priority suggestions
- branch health summaries

### Extension Registration

`anvil init` creates:

```text
.anvil/extensions.yaml
```

Starter example:

```yaml
extensions:
  reviewHints:
    enabled: false
    command: node .anvil/apps/review-hints.mjs
    description: "Generate structured checkpoint review hints"
```

### Extension Contract

An extension receives stdin like:

```json
{
  "version": 1,
  "repositoryRoot": "C:/path/to/repo",
  "checkpoint": {
    "checkpointId": "cp-12",
    "summary": "Refactor parser",
    "filesChanged": ["src/parser.ts"]
  }
}
```

It should return stdout like:

```json
{
  "insights": [
    {
      "type": "review-hint",
      "title": "Review parser.ts first",
      "body": "The checkpoint touched parsing logic and may affect downstream validation.",
      "files": ["src/parser.ts"]
    }
  ]
}
```

Important:
- extensions are best-effort
- they do not block checkpoint creation
- they are intended for review/analysis outputs, not arbitrary execution control

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

## Prune And Retention

Anvil now keeps retention settings in:

```text
.anvil/config.json
```

Default config created by `anvil init` includes:

```json
{
  "retention": {
    "maxCheckpointsPerBranch": 50,
    "maxHookLogs": 500
  }
}
```

Run prune using the config values:

```bash
anvil prune
```

Preview what prune would do without changing anything:

```bash
anvil prune --dry-run
```

Override the config for a run:

```bash
anvil prune --max-checkpoints-per-branch 25 --max-hook-logs 200
```

What prune does:
- keeps only the newest configured number of checkpoints per branch
- trims old hook execution log entries
- updates `.anvil/config.json` when you provide override values
- runs shadow Git garbage collection after rewriting retained history

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

If an older repo still shows a full-project diff on its first checkpoint after upgrading Anvil:

```bash
anvil repair-baseline
```

This recreates the current branch's hidden Anvil baseline from the current Git `HEAD` tree and re-anchors the first checkpoint on that branch to it.

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
