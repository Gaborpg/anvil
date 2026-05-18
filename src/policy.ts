import process from "node:process";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export type ExecutionGuardDecision = "allow" | "ask" | "deny";

export interface ExecutionGuardPolicy {
  enabled: boolean;
  askAsDeny: boolean;
  allowedTestCommands: string[];
  allowedBuildCommands: string[];
  askCommands: string[];
  denyCommands: string[];
  askPaths: string[];
  denyPaths: string[];
  maxFilesBeforeAsk: number;
}

export interface GuardEvaluationInput {
  toolName: string;
  commandText: string | null;
  filePaths: string[];
}

export interface GuardEvaluationResult {
  decision: ExecutionGuardDecision;
  category:
    | "policy-disabled"
    | "test-run"
    | "build-run"
    | "destructive-git"
    | "destructive-filesystem"
    | "publish-deploy"
    | "secret-exfiltration"
    | "database-destructive"
    | "package-install"
    | "network"
    | "migration"
    | "sensitive-edit"
    | "workflow-edit"
    | "manifest-edit"
    | "broad-file-change"
    | "shell"
    | "tool";
  reason: string;
  nextStep: string;
}

export interface EnsurePolicyTemplateResult {
  filePath: string;
  created: boolean;
}

const POLICY_FILE_NAME = "policy.yaml";
const EXECUTION_GUARD_WRAPPER_FILE_NAME = "anvil-execution-guard.mjs";

// Defaults are intentionally stack-agnostic so the same guard can start safely in most repos.\r\n// watcher smoke marker
const DEFAULT_POLICY: ExecutionGuardPolicy = {
  enabled: false,
  askAsDeny: true,
  allowedTestCommands: [
    "npm test",
    "npm run test",
    "pnpm test",
    "pnpm run test",
    "yarn test",
    "bun test",
    "vitest",
    "jest",
    "ng test",
    "dotnet test",
    "pytest",
    "cargo test",
    "go test"
  ],
  allowedBuildCommands: [
    "npm run build",
    "npm run dev",
    "npm run start",
    "pnpm run build",
    "pnpm run dev",
    "pnpm run start",
    "yarn build",
    "yarn dev",
    "yarn start",
    "vite",
    "ng serve",
    "ng build",
    "dotnet build",
    "dotnet run",
    "next build",
    "next dev",
    "cargo build",
    "cargo run",
    "go build",
    "go run ."
  ],
  askCommands: [
    "npm install",
    "npm add",
    "pnpm install",
    "pnpm add",
    "yarn add",
    "bun add",
    "pip install",
    "poetry add",
    "dotnet add package",
    "cargo add",
    "curl",
    "wget",
    "invoke-webrequest",
    "dotnet ef",
    "prisma migrate",
    "typeorm migration",
    "rails db:migrate"
  ],
  denyCommands: [
    "git reset --hard",
    "git clean -fdx",
    "git push --force",
    "git push -f",
    "git branch -d",
    "git branch -D",
    "rm -rf",
    "remove-item -recurse -force",
    "rmdir /s /q",
    "del /s /q",
    "npm publish",
    "pnpm publish",
    "yarn publish",
    "bun publish",
    "dotnet nuget push",
    "prisma migrate reset",
    "dotnet ef database drop",
    "drop table",
    "drop database",
    "truncate table"
  ],
  askPaths: [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    ".github/workflows/",
    "Dockerfile",
    "docker-compose.yml",
    "*.csproj"
  ],
  denyPaths: [
    ".git/",
    ".anvil/",
    ".codex/",
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.pfx",
    "*.p12"
  ],
  maxFilesBeforeAsk: 20
};

function normalizePathValue(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeCommandValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseBoolean(value: string): boolean | null {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

function parseNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function policyScalarKeys(): Record<string, keyof ExecutionGuardPolicy> {
  return {
    enabled: "enabled",
    askAsDeny: "askAsDeny",
    ask_as_deny: "askAsDeny",
    maxFilesBeforeAsk: "maxFilesBeforeAsk",
    max_files_before_ask: "maxFilesBeforeAsk"
  };
}

function policyArrayKeys(): Record<string, keyof ExecutionGuardPolicy> {
  return {
    allowedTestCommands: "allowedTestCommands",
    allowed_test_commands: "allowedTestCommands",
    allowedBuildCommands: "allowedBuildCommands",
    allowed_build_commands: "allowedBuildCommands",
    askCommands: "askCommands",
    ask_commands: "askCommands",
    denyCommands: "denyCommands",
    deny_commands: "denyCommands",
    askPaths: "askPaths",
    ask_paths: "askPaths",
    denyPaths: "denyPaths",
    deny_paths: "denyPaths"
  };
}

function parsePolicyYaml(content: string): ExecutionGuardPolicy {
  const result: ExecutionGuardPolicy = {
    ...DEFAULT_POLICY,
    allowedTestCommands: [...DEFAULT_POLICY.allowedTestCommands],
    allowedBuildCommands: [...DEFAULT_POLICY.allowedBuildCommands],
    askCommands: [...DEFAULT_POLICY.askCommands],
    denyCommands: [...DEFAULT_POLICY.denyCommands],
    askPaths: [...DEFAULT_POLICY.askPaths],
    denyPaths: [...DEFAULT_POLICY.denyPaths]
  };

  let inExecutionGuard = false;
  let activeArrayKey: keyof ExecutionGuardPolicy | null = null;
  const scalarKeyMap = policyScalarKeys();
  const arrayKeyMap = policyArrayKeys();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (!line.startsWith(" ")) {
      inExecutionGuard = trimmed === "executionGuard:";
      activeArrayKey = null;
      continue;
    }

    if (!inExecutionGuard) {
      continue;
    }

    if (trimmed.startsWith("- ")) {
      if (!activeArrayKey) {
        continue;
      }

      const listValue = trimmed.slice(2).trim().replace(/^['"]|['"]$/g, "");
      if (!listValue) {
        continue;
      }

      const target = result[activeArrayKey];
      if (Array.isArray(target)) {
        target.push(listValue);
      }
      continue;
    }

    activeArrayKey = null;
    const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    const scalarTarget = scalarKeyMap[key];
    if (scalarTarget) {
      const normalizedValue = rawValue.trim().replace(/^['"]|['"]$/g, "");
      if (scalarTarget === "enabled") {
        const parsed = parseBoolean(normalizedValue);
        if (parsed !== null) {
          result.enabled = parsed;
        }
      } else if (scalarTarget === "askAsDeny") {
        const parsed = parseBoolean(normalizedValue);
        if (parsed !== null) {
          result.askAsDeny = parsed;
        }
      } else if (scalarTarget === "maxFilesBeforeAsk") {
        const parsed = parseNumber(normalizedValue);
        if (parsed !== null && parsed >= 1) {
          result.maxFilesBeforeAsk = parsed;
        }
      }
      continue;
    }

    const arrayTarget = arrayKeyMap[key];
    if (!arrayTarget) {
      continue;
    }

    (result[arrayTarget] as string[]) = [];
    activeArrayKey = arrayTarget;

    const normalizedValue = rawValue.trim();
    if (normalizedValue) {
      const inlineValues = normalizedValue
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
      const target = result[arrayTarget];
      if (Array.isArray(target)) {
        target.push(...inlineValues);
      }
    }
  }

  return result;
}

export function policyPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", POLICY_FILE_NAME);
}

export function executionGuardScriptPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", EXECUTION_GUARD_WRAPPER_FILE_NAME);
}

export async function loadExecutionGuardPolicy(repositoryRoot: string): Promise<ExecutionGuardPolicy> {
  const filePath = policyPath(repositoryRoot);
  if (!existsSync(filePath)) {
    return {
      ...DEFAULT_POLICY,
      allowedTestCommands: [...DEFAULT_POLICY.allowedTestCommands],
      allowedBuildCommands: [...DEFAULT_POLICY.allowedBuildCommands],
      askCommands: [...DEFAULT_POLICY.askCommands],
      denyCommands: [...DEFAULT_POLICY.denyCommands],
      askPaths: [...DEFAULT_POLICY.askPaths],
      denyPaths: [...DEFAULT_POLICY.denyPaths]
    };
  }

  const content = await readFile(filePath, "utf8");
  return parsePolicyYaml(content);
}

export async function ensurePolicyTemplate(repositoryRoot: string): Promise<EnsurePolicyTemplateResult> {
  const filePath = policyPath(repositoryRoot);
  if (existsSync(filePath)) {
    return { filePath, created: false };
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  const content = `# Repo-local Anvil execution safety policy
# Keep this disabled until you are ready to gate AI-triggered tool execution.
executionGuard:
  enabled: false
  askAsDeny: true
  maxFilesBeforeAsk: ${DEFAULT_POLICY.maxFilesBeforeAsk}

  # Common test commands Anvil should allow by default.
  allowedTestCommands:
    - npm test
    - npm run test
    - pnpm test
    - yarn test
    - bun test
    - vitest
    - jest
    - ng test
    - dotnet test
    - pytest
    - cargo test

  # Common build/dev commands Anvil should allow by default.
  allowedBuildCommands:
    - npm run build
    - npm run dev
    - pnpm run build
    - pnpm run dev
    - yarn build
    - yarn dev
    - vite
    - ng serve
    - ng build
    - dotnet build
    - dotnet run

  # Medium-risk commands that should require explicit approval.
  askCommands:
    - npm install
    - pnpm install
    - yarn add
    - dotnet add package
    - pip install
    - curl
    - wget
    - dotnet ef

  # High-risk commands Anvil should deny automatically.
  denyCommands:
    - git reset --hard
    - git clean -fdx
    - git push --force
    - rm -rf
    - npm publish
    - dotnet nuget push
    - prisma migrate reset
    - dotnet ef database drop

  # Medium-risk files and directories that should require approval before edits.
  askPaths:
    - package.json
    - package-lock.json
    - pnpm-lock.yaml
    - yarn.lock
    - .github/workflows/
    - Dockerfile
    - "*.csproj"

  # High-risk files and directories Anvil should protect from AI edits.
  denyPaths:
    - .git/
    - .anvil/
    - .codex/
    - .env
    - .env.*
    - "*.pem"
    - "*.key"
`;
  await writeFile(filePath, content, "utf8");
  return { filePath, created: true };
}

export async function ensureExecutionGuardScript(repositoryRoot: string): Promise<string> {
  const filePath = executionGuardScriptPath(repositoryRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  const cliEntrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
  const nodeExecutable = process.execPath;
  const debugPath = path.join(repositoryRoot, ".anvil", "execution-guard-debug.json");
  const content = `import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

  const hostIndex = process.argv.indexOf("--host");
  const host = hostIndex >= 0 && process.argv[hostIndex + 1] ? process.argv[hostIndex + 1] : "codex";
  const rawInput = await readStdin();
  const debugTarget = ${JSON.stringify(debugPath)};
  await mkdir(path.dirname(debugTarget), { recursive: true });
  await writeFile(
    debugTarget,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
        host,
        argv: process.argv.slice(2),
        rawInput
      },
      null,
      2
    ),
    "utf8"
  );
  const modeFlag =
    host === "copilot-cli" || host === "copilot"
      ? "--copilot-cli-hook"
    : host === "copilot-vs"
      ? "--copilot-vs-hook"
      : "--codex-hook";
const extraArgs = process.argv.includes("--permission-request") ? ["--permission-request"] : [];

const result = spawnSync(${JSON.stringify(nodeExecutable)}, [${JSON.stringify(cliEntrypoint)}, "guard", "evaluate", modeFlag, ...extraArgs], {
  cwd: process.cwd(),
  input: rawInput,
  encoding: "utf8",
  shell: false
});

if (result.stdout) {
  process.stdout.write(result.stdout);
}

if (result.stderr) {
  process.stderr.write(result.stderr);
}

process.exit(result.status ?? 0);
`;
  await writeFile(filePath, `${content}\n`, "utf8");
  return filePath;
}

function matchesCommandPrefix(command: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeCommandValue(candidate);
    if (normalizedCandidate && (command === normalizedCandidate || command.startsWith(`${normalizedCandidate} `))) {
      return candidate;
    }
  }

  return null;
}

function commandSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\r?\n)/)
    .map((segment) => normalizeCommandValue(segment))
    .filter(Boolean);
}

function matchCommandAcrossSegments(command: string, candidates: string[]): string | null {
  const normalizedCommand = normalizeCommandValue(command);
  const directMatch = matchesCommandPrefix(normalizedCommand, candidates);
  if (directMatch) {
    return directMatch;
  }

  for (const segment of commandSegments(normalizedCommand)) {
    const segmentMatch = matchesCommandPrefix(segment, candidates);
    if (segmentMatch) {
      return segmentMatch;
    }
  }

  return null;
}

function globFragmentToRegex(fragment: string): RegExp {
  let regex = "^";

  for (const character of fragment) {
    if (character === "*") {
      regex += ".*";
      continue;
    }

    if (character === "?") {
      regex += ".";
      continue;
    }

    regex += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }

  regex += "$";
  return new RegExp(regex, "i");
}

function matchesPathRule(filePath: string, rule: string): boolean {
  const normalizedPath = normalizePathValue(filePath);
  const normalizedRule = normalizePathValue(rule);
  if (!normalizedRule) {
    return false;
  }

  if (normalizedRule.endsWith("/")) {
    const prefix = normalizedRule.slice(0, -1);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }

  if (normalizedRule.includes("/")) {
    return globFragmentToRegex(normalizedRule).test(normalizedPath);
  }

  const basename = path.posix.basename(normalizedPath);
  return globFragmentToRegex(normalizedRule).test(basename);
}

function findMatchingPath(filePaths: string[], rules: string[]): { filePath: string; rule: string } | null {
  for (const filePath of filePaths) {
    for (const rule of rules) {
      if (matchesPathRule(filePath, rule)) {
        return { filePath, rule };
      }
    }
  }

  return null;
}

function uniquePaths(filePaths: string[]): string[] {
  return [...new Set(filePaths.map((item) => normalizePathValue(item)).filter(Boolean))];
}

const EDIT_TOOL_NAMES = new Set([
  "apply_patch",
  "edit",
  "write",
  "multiedit",
  "editfiles",
  "createfile",
  "movefile",
  "deletefile",
  "replacestringinfile",
  "create_file",
  "move_file",
  "delete_file",
  "replace_string_in_file"
]);

const SHELL_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "runterminalcommand",
  "terminal",
  "executecommand",
  "run_command"
]);

function classifyShellCommand(command: string, policy: ExecutionGuardPolicy): GuardEvaluationResult {
  const normalizedCommand = normalizeCommandValue(command);
  if (!normalizedCommand) {
    return {
      decision: "allow",
      category: "shell",
      reason: "Empty shell command payload.",
      nextStep: "Proceed."
    };
  }

  const denyMatch = matchCommandAcrossSegments(normalizedCommand, policy.denyCommands);
  if (denyMatch) {
    let category: GuardEvaluationResult["category"] = "destructive-filesystem";
    if (normalizeCommandValue(denyMatch).startsWith("git ")) {
      category = "destructive-git";
    } else if (normalizeCommandValue(denyMatch).includes("publish") || normalizeCommandValue(denyMatch).includes("nuget push")) {
      category = "publish-deploy";
    } else if (
      normalizeCommandValue(denyMatch).includes("drop") ||
      normalizeCommandValue(denyMatch).includes("truncate") ||
      normalizeCommandValue(denyMatch).includes("migrate reset")
    ) {
      category = "database-destructive";
    }

    return {
      decision: "deny",
      category,
      reason: `${denyMatch} is blocked by Anvil execution policy.`,
      nextStep: "Use a safer alternative or run it manually with explicit human approval."
    };
  }

  if (
    normalizedCommand.includes(".env") ||
    normalizedCommand.includes(".pem") ||
    normalizedCommand.includes(".key") ||
    normalizedCommand.includes("id_rsa")
  ) {
    if (
      normalizedCommand.includes("curl") ||
      normalizedCommand.includes("wget") ||
      normalizedCommand.includes("invoke-webrequest") ||
      normalizedCommand.includes("scp ") ||
      normalizedCommand.includes("upload")
    ) {
      return {
        decision: "deny",
        category: "secret-exfiltration",
        reason: "Command appears to move or expose secret-bearing files.",
        nextStep: "Remove the secret file access or handle it manually."
      };
    }
  }

  const testMatch = matchCommandAcrossSegments(normalizedCommand, policy.allowedTestCommands);
  if (testMatch) {
    return {
      decision: "allow",
      category: "test-run",
      reason: `${testMatch} is an approved test command.`,
      nextStep: "Proceed."
    };
  }

  const buildMatch = matchCommandAcrossSegments(normalizedCommand, policy.allowedBuildCommands);
  if (buildMatch) {
    return {
      decision: "allow",
      category: "build-run",
      reason: `${buildMatch} is an approved build or dev command.`,
      nextStep: "Proceed."
    };
  }

  const askMatch = matchCommandAcrossSegments(normalizedCommand, policy.askCommands);
  if (askMatch) {
    let category: GuardEvaluationResult["category"] = "shell";
    if (
      normalizeCommandValue(askMatch).includes("install") ||
      normalizeCommandValue(askMatch).includes("add package") ||
      normalizeCommandValue(askMatch).includes("cargo add") ||
      normalizeCommandValue(askMatch).includes("add ")
    ) {
      category = "package-install";
    } else if (
      normalizeCommandValue(askMatch).includes("curl") ||
      normalizeCommandValue(askMatch).includes("wget") ||
      normalizeCommandValue(askMatch).includes("invoke-webrequest")
    ) {
      category = "network";
    } else if (
      normalizeCommandValue(askMatch).includes("migrate") ||
      normalizeCommandValue(askMatch).includes("dotnet ef") ||
      normalizeCommandValue(askMatch).includes("db:migrate")
    ) {
      category = "migration";
    }

    return {
      decision: "ask",
      category,
      reason: `${askMatch} requires explicit approval in this repo.`,
      nextStep: "Approve it explicitly, add an allow rule in .anvil/policy.yaml, or run it manually."
    };
  }

  return {
    decision: "allow",
    category: "shell",
    reason: "Command does not match a guarded risk pattern.",
    nextStep: "Proceed."
  };
}

function classifyEditOperation(filePaths: string[], policy: ExecutionGuardPolicy): GuardEvaluationResult {
  const normalizedPaths = uniquePaths(filePaths);
  const denyMatch = findMatchingPath(normalizedPaths, policy.denyPaths);
  if (denyMatch) {
    return {
      decision: "deny",
      category: "sensitive-edit",
      reason: `Editing ${denyMatch.filePath} is blocked by Anvil policy (${denyMatch.rule}).`,
      nextStep: "Move the change to a safer file or handle the control-surface edit manually."
    };
  }

  const askMatch = findMatchingPath(normalizedPaths, policy.askPaths);
  if (askMatch) {
    let category: GuardEvaluationResult["category"] = "sensitive-edit";
    if (askMatch.rule.startsWith(".github/workflows/")) {
      category = "workflow-edit";
    } else if (
      askMatch.rule.includes("package") ||
      askMatch.rule.includes("lock") ||
      askMatch.rule.includes(".csproj")
    ) {
      category = "manifest-edit";
    }

    return {
      decision: "ask",
      category,
      reason: `Editing ${askMatch.filePath} requires explicit approval in this repo.`,
      nextStep: "Approve it explicitly, add an allow override later, or make the change manually."
    };
  }

  if (normalizedPaths.length > policy.maxFilesBeforeAsk) {
    return {
      decision: "ask",
      category: "broad-file-change",
      reason: `This tool call touches ${normalizedPaths.length} files, above the repo threshold of ${policy.maxFilesBeforeAsk}.`,
      nextStep: "Review the scope and approve it explicitly if the broad rewrite is intentional."
    };
  }

  return {
    decision: "allow",
    category: "tool",
    reason: "Target files are ordinary workspace files.",
    nextStep: "Proceed."
  };
}

export function evaluateExecutionGuard(
  policy: ExecutionGuardPolicy,
  input: GuardEvaluationInput
): GuardEvaluationResult {
  if (!policy.enabled) {
    return {
      decision: "allow",
      category: "policy-disabled",
      reason: "executionGuard.enabled is false.",
      nextStep: "Enable it in .anvil/policy.yaml to enforce Anvil execution safety."
    };
  }

  const toolName = input.toolName.trim().toLowerCase();
  if (SHELL_TOOL_NAMES.has(toolName)) {
    return classifyShellCommand(input.commandText ?? "", policy);
  }

  if (EDIT_TOOL_NAMES.has(toolName)) {
    return classifyEditOperation(input.filePaths, policy);
  }

  if (input.filePaths.length > 0) {
    return classifyEditOperation(input.filePaths, policy);
  }

  if (input.commandText) {
    return classifyShellCommand(input.commandText, policy);
  }

  return {
    decision: "allow",
    category: "tool",
    reason: "Tool does not match a guarded category yet.",
    nextStep: "Proceed."
  };
}

