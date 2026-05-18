# anvil

Anvil is a local checkpointing and review tool for AI-driven code changes.

It keeps a private, branch-aware shadow history in `.anvil/` so you can:
- checkpoint AI work without polluting normal Git history
- review file changes in a local web UI
- restore a previous checkpoint
- export the final state into real Git only when you want to

## What Anvil Can Do Today

Today Anvil already covers five big jobs:

- branch-aware local checkpointing in a private shadow Git history
- review and restore of AI edits without polluting real Git commits
- hook-based and watcher-based capture of editor or agent file changes
- pre-execution safety policy for AI-triggered commands and edits
- post-checkpoint profile runs and derived insight generation

The important boundary is:

- Anvil is the private working-and-review layer
- Git is still the final source of truth when you export

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
  orchestration.yaml
  metadata.jsonl
  generated-insights.jsonl
  store.git/
```

- `store.git` is the hidden shadow Git repository
- `metadata.jsonl` is the append-only checkpoint log
- `hooks.yaml` is the optional repo-local hook config
- `policy.yaml` is the optional repo-local execution safety policy
- `orchestration.yaml` controls post-hook and post-checkpoint automation
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

Or install only the hook family you actually want:

```bash
anvil init --hooks codex
anvil init --hooks copilot-cli
anvil init --hooks copilot-vs,codex
```

You can also use explicit flags:

```bash
anvil init --codex
anvil init --copilot-cli
anvil init --copilot-vs
```

`anvil init` now bootstraps all the basic repo-local Anvil wiring:
- `.anvil/config.json`
- `.anvil/metadata.jsonl`
- `.anvil/generated-insights.jsonl`
- `.anvil/store.git`
- `.anvil/hooks.yaml`
- `.anvil/policy.yaml`
- `.anvil/orchestration.yaml`
- `.anvilignore`
- `.anvil/anvil-execution-guard.mjs`
- selected hook files only:
  - `.github/hooks/anvil-copilot-vs.json`
  - `.github/hooks/anvil-copilot-cli.json`
  - `.codex/anvil-codex-after-edit.mjs`
  - `.codex/hooks.json`

By default, `anvil init` installs all supported hook families.
If you pass `--hooks` or one of the explicit hook flags, Anvil only installs the selected hook files so you do not end up with repo files you do not need.

Any installed hook family still keeps auto-checkpointing disabled until you set `autoCheckpoint: true` in `.anvil/hooks.yaml`.
The shared execution guard is also installed, but it stays inactive until you set `executionGuard.enabled: true` in `.anvil/policy.yaml`.
Anvil also creates `.anvil/orchestration.yaml`, which is where Anvil-owned post-hook and post-checkpoint automation is configured.
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
anvil install-copilot-hook
anvil install-copilot-vs-hook
anvil install-copilot-cli-hook
anvil install-codex-hook
anvil guard evaluate [--copilot-vs-hook|--copilot-cli-hook|--copilot-hook|--vscode-hook|--codex-hook]
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
anvil watch [--interval-ms 1500] [--debounce-ms 2000]
anvil run <profile>
anvil run --command "npm run build" --name build
anvil verify <profile>
anvil verify --command "npm run build" --name build
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

## Copilot VS Auto-Checkpoint Hook

The legacy VS-compatible Copilot setup uses:

```text
.github/hooks/anvil-copilot-vs.json
```

Install or refresh it with:

```bash
anvil install-copilot-vs-hook
```

`anvil install-copilot-hook` is kept as a compatibility alias and currently refreshes this Copilot VS setup.

Enable it in `.anvil/hooks.yaml` with:

```yaml
copilotVs:
  autoCheckpoint: true
  summary: "Copilot VS file changes"
  kind: after_edit_batch
  command: copilot-vs
  testStatus: unknown
```

It calls:

```bash
anvil hook copilot-after-edit --copilot-vs-hook
```

## Copilot CLI Auto-Checkpoint Hook

Copilot CLI discovers repo-local JSON hook files under:

```text
.github/hooks/
```

Install or refresh Anvil's Copilot CLI hook file into the current repo:

```bash
anvil install-copilot-hook
```

`anvil init` already does this automatically, so you usually only need `install-copilot-hook` if you want to recreate or refresh the hook files later.

That creates:

```text
.github/hooks/anvil-copilot-cli.json
```

The installed hook file is a Copilot CLI `version: 1` hook config that registers:

- `PreToolUse`
- `PermissionRequest`
- `UserPromptSubmit`
- `PostToolUse`

and points them at Anvil's repo-local wrappers and guard scripts with explicit `powershell`, `bash`, `cwd`, and `timeoutSec` fields.

The repo-local pieces it installs are:

- `.anvil/anvil-execution-guard.mjs`
- `.anvil/anvil-copilot-cli-prompt-submit.mjs`
- `.anvil/anvil-copilot-cli-after-edit.mjs`

The after-edit wrapper is important. It normalizes Copilot CLI `postToolUse` edit payloads before forwarding them into Anvil's checkpoint path, which keeps Copilot CLI checkpoint recording much closer to the Codex flow.

The post-edit hook calls:

```bash
node .anvil/anvil-copilot-cli-after-edit.mjs
```

Anvil still keeps the actual auto-checkpoint behavior disabled by default. To opt in, enable the repo-local Anvil hook config:

```yaml
copilotCli:
  autoCheckpoint: true
  summary: "Copilot file changes"
  kind: after_edit_batch
  command: copilot-cli
  testStatus: unknown
```

Save that as:

```text
.anvil/hooks.yaml
```

Then have your Copilot CLI post-edit hook call:

```bash
anvil hook copilot-after-edit
```

You can still override the defaults from the command line:

```bash
anvil hook copilot-after-edit --summary "Copilot refactor" --command "copilot" --test-status unknown
```

Important:
- Copilot CLI discovers the repo hook from `.github/hooks/anvil-copilot-cli.json`
- on Windows, Copilot CLI hooks require PowerShell 7+ (`pwsh`) to be available on `PATH`
- `anvil init`, `anvil install-copilot-cli-hook`, and `anvil hook status` will warn if `pwsh` is missing
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
- whether Copilot VS, Copilot CLI, and Codex auto-checkpointing are enabled
- whether Copilot CLI prerequisites like `pwsh` are available
- whether `.github/hooks/anvil-copilot-vs.json` exists
- whether `.github/hooks/anvil-copilot-cli.json` exists
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

## Profiles And Runs

Anvil can run named profiles against the latest checkpoint on the current branch.

Examples:

```bash
anvil run build
anvil run test
anvil run lint
anvil run --command "npm run build" --name build
```

What it does:
- resolves the named profile from `.anvil/orchestration.yaml`
- runs the command in the repo
- attaches the result to the latest checkpoint as derived profile-run data
- writes the full stdout/stderr log under `.anvil/verification-logs`

This means a profile run is:

- tied to a checkpoint
- rerunnable without creating a new checkpoint
- stored as derived data, not as core checkpoint history

So if you run:

```bash
anvil run build
```

Anvil does not create a new checkpoint.
It takes the latest checkpoint on the current branch, runs the configured command, stores the pass/fail result for that checkpoint, and writes the full log to disk.

Profile config lives in:

```text
.anvil/orchestration.yaml
```

Example:

```yaml
profiles:
  build:
    command: npm run build
  test:
    command: npm test -- --watch=false
  lint:
    command: npm run lint

lifecycle:
  aiHooks:
    copilotVs:
      rules: {}
    copilotCli:
      rules: {}
    codex:
      rules: {}
  beforeCheckpoint:
    rules: {}
  afterCheckpoint:
    rules: {}
```

Current behavior:
- manual `anvil run ...` is implemented
- full logs are stored as separate files under `.anvil/verification-logs/<checkpointId>/`
- profile-run results are stored as derived records, not as new checkpoints
- reusable profile commands are resolved from the top-level `profiles` section

### How Run Fits Into A Larger Orchestrator

`run` is one part of a bigger project-orchestrator idea, but it is not the whole orchestrator by itself.

Right now the flow is:

1. a hook, watcher, or manual checkpoint records file state
2. `anvil run ...` runs build, test, or lint against that checkpoint context
3. Anvil stores the result and the full log as derived output

So today Anvil already has the building blocks for orchestration:

- checkpoint capture
- profiles
- generated insights
- execution safety policy

The missing piece is a higher-level orchestration command that would deliberately chain those steps together for a repo workflow.

You can think of the current split like this:

- `checkpoint`
  save file state
- `run`
  run build/test/lint against a checkpoint
- `orchestration`
  coordinate post-hook and post-checkpoint analysis or validation
- future `orchestrator`
  coordinate those steps as one repo workflow

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
- Codex, Copilot VS, and Copilot CLI pre-tool hooks all call the same guard

The guard is installed by:
- `anvil init`
- `anvil install-codex-hook`
- `anvil install-copilot-vs-hook`
- `anvil install-copilot-cli-hook`

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

### Codex And Copilot Ask Behavior

Copilot VS, Copilot CLI, and Codex do not currently behave the same here.

- Copilot VS can use host-native `ask`
- Copilot CLI can use host-native `ask`
- Codex `PreToolUse` `ask` is not reliable enough, so strict mode maps ask-level rules to `deny`

That is why `anvil hook status` now reports enforcement mode explicitly, for example:

```text
executionGuard.enforcementMode: codex: strict (ask -> deny), copilotVs: host-ask, copilotCli: host-ask
```

So the mental model is:

- Anvil still classifies actions internally as `allow`, `ask`, or `deny`
- Copilot VS can receive real `ask`
- Copilot CLI can receive real `ask`
- Codex may still receive `deny` for ask-level rules when strict mode is enabled

## Orchestration

Anvil can run declared automation after selected hook events or after a checkpoint is already committed.

This is separate from the execution guard:
- `policy.yaml` controls pre-execution safety
- `orchestration.yaml` registers Anvil-owned post-hook and post-checkpoint automation

### How It Works

1. A hook event or checkpoint event occurs.
2. Anvil matches any relevant orchestration rule for that phase.
3. In the current runtime, checkpoint events can launch enabled extension apps in best-effort background mode.
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

### Orchestration Registration

`anvil init` creates:

```text
.anvil/orchestration.yaml
```

Starter example:

```yaml
profiles:
  build:
    command: npm run build

lifecycle:
  aiHooks:
    copilotVs:
      rules: {}
    copilotCli:
      rules:
        packageScripts:
          enabled: false
          mode: background
          event: PostToolUse
          includePaths:
            - package.json
          actions:
            - type: runCommand
              command: npm run build
    codex:
      rules: {}

  beforeCheckpoint:
    rules: {}

  afterCheckpoint:
    rules:
      appTsBuild:
        enabled: false
        mode: background
        includePaths:
          - src/app.ts
        excludePaths:
          - src/app.spec.ts
        actions:
          - type: runProfile
            profile: build
```

Important:
- `extensions.yaml` is now considered legacy
- if an older repo still has `.anvil/extensions.yaml` and no `.anvil/orchestration.yaml`, Anvil migrates that config forward when it creates the new orchestration file
- lifecycle is now the primary control plane:
  - `lifecycle.aiHooks.<agent>.rules`
  - `lifecycle.beforeCheckpoint.rules`
  - `lifecycle.afterCheckpoint.rules`
- `lifecycle.aiHooks.<agent>.rules` can match:
  - `event`
  - `includePaths`
  - `excludePaths`
- `lifecycle.beforeCheckpoint.rules` and `lifecycle.afterCheckpoint.rules` can match:
  - `includePaths`
  - `excludePaths`
  - and the checkpoint's `filesChanged` list
- current lifecycle actions support:
  - `runCommand`
  - `runProfile`
- `mode: blocking` waits for a rule to finish
- `mode: background` queues it in best-effort mode
- blocking `beforeCheckpoint` failures prevent checkpoint creation
- actions run in order and stop on the first failure for that rule
- hook-triggered and checkpoint-triggered background runs are best-effort and do not block persistence

### Profiles And Actions

`profiles`
- reusable named commands
- mainly for build, test, lint, or other validation commands
- used by:
  ```yaml
  - type: runProfile
    profile: build
  ```

Example:

```yaml
profiles:
  build:
    command: npm run build
  test:
    command: npm test -- --watch=false
```

`runCommand`
- runs a trusted command directly
- good for simple repo automation

Example:

```yaml
- type: runCommand
  command: npm run lint
```

`runProfile`
- runs one of the named `profiles`
- stores pass/fail and full logs as profile-run output

Example:

```yaml
- type: runProfile
  profile: build
```

## Project Orchestrator Direction

If you want Anvil to become a repo-level orchestrator, the current architecture already points the right way.

An orchestrator in Anvil should sit above the existing layers:

- hooks or watcher detect work
- checkpoints record state
- profiles run build/test/lint
- policy controls what AI is allowed to execute

So the likely orchestrator job is not "replace run."
It is "coordinate checkpoint, run profiles, and derived analysis for a project workflow."

In other words:

- `run` answers:
  "Did this checkpoint build, test, or lint cleanly?"
- an orchestrator would answer:
  "Given this repo and this checkpoint, what sequence of validation and follow-up work should run?"

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
- Logs

It also supports:
- summary file review cards
- file snapshots
- unified diff
- side-by-side diff
- collapsible panels
- repository switching
- full profile-run log viewing from saved `.anvil/verification-logs` artifacts
- orchestration run history as its own log surface

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
