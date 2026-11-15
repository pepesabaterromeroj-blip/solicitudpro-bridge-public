import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ParsedStatus {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  clean: boolean;
}

export interface GitState extends ParsedStatus {
  machine: string;
  repoPath: string;
  gitRoot: string;
  branch: string;
  head: string;
  worktrees: Array<{ path: string; head?: string; branch?: string }>;
  remotes: Array<{ name: string; fetch?: string; push?: string }>;
  remoteRefs: Array<{ ref: string; sha: string }>;
}

export function parsePorcelainV1(output: string): ParsedStatus {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (code === "??") {
      untracked.push(file);
      continue;
    }
    if (code[0] && code[0] !== " ") staged.push(file);
    if (code[1] && code[1] !== " ") unstaged.push(file);
  }
  return { staged, unstaged, untracked, clean: staged.length + unstaged.length + untracked.length === 0 };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trimEnd();
}

function parseWorktrees(output: string): GitState["worktrees"] {
  const result: GitState["worktrees"] = [];
  let current: { path: string; head?: string; branch?: string } | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9) };
      result.push(current);
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
  }
  return result;
}

function parseRemotes(output: string): GitState["remotes"] {
  const map = new Map<string, { name: string; fetch?: string; push?: string }>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const entry = map.get(match[1]!) ?? { name: match[1]! };
    entry[match[3] as "fetch" | "push"] = match[2]!;
    map.set(entry.name, entry);
  }
  return [...map.values()];
}

export async function readGitState(repoPath: string): Promise<GitState> {
  const [gitRoot, branch, head, status, worktrees, remotes, refs] = await Promise.all([
    git(repoPath, ["rev-parse", "--show-toplevel"]),
    git(repoPath, ["branch", "--show-current"]),
    git(repoPath, ["rev-parse", "HEAD"]),
    git(repoPath, ["status", "--porcelain=v1", "-uall"]),
    git(repoPath, ["worktree", "list", "--porcelain"]),
    git(repoPath, ["remote", "-v"]),
    git(repoPath, ["for-each-ref", "--format=%(refname:short)|%(objectname)", "refs/remotes"]),
  ]);
  const parsed = parsePorcelainV1(status);
  return {
    machine: os.hostname(),
    repoPath,
    gitRoot,
    branch,
    head,
    ...parsed,
    worktrees: parseWorktrees(worktrees),
    remotes: parseRemotes(remotes),
    remoteRefs: refs.split(/\r?\n/).filter(Boolean).map((line) => {
      const [ref, sha] = line.split("|");
      return { ref: ref ?? "", sha: sha ?? "" };
    }),
  };
}
