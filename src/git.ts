import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runGit(args: string[], cwd: string, gitDir?: string): Promise<string> {
  const effectiveArgs = gitDir ? [`--git-dir=${gitDir}`, "--work-tree=.", ...args] : args;
  const { stdout, stderr } = await execFileAsync("git", effectiveArgs, {
    cwd,
    windowsHide: true
  });

  if (stderr && stderr.trim().length > 0 && !stdout.trim().length) {
    return stderr.trim();
  }

  return stdout.trim();
}

export async function runGitRaw(args: string[], cwd: string, gitDir?: string): Promise<string> {
  const effectiveArgs = gitDir ? [`--git-dir=${gitDir}`, "--work-tree=.", ...args] : args;
  const { stdout } = await execFileAsync("git", effectiveArgs, {
    cwd,
    windowsHide: true
  });

  return stdout;
}

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const branch = await runGit(["branch", "--show-current"], cwd);
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

export async function getHeadReflogMessages(cwd: string, limit = 20): Promise<string[]> {
  try {
    const output = await runGit(["reflog", "--format=%gs", `-n`, String(limit)], cwd);
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function getOriginUrl(cwd: string): Promise<string | null> {
  try {
    const remote = await runGit(["remote", "get-url", "origin"], cwd);
    return remote.length > 0 ? remote : null;
  } catch {
    return null;
  }
}
