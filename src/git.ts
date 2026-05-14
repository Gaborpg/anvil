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

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  try {
    const branch = await runGit(["branch", "--show-current"], cwd);
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}
