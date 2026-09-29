import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const canonicalPath = value => {
  const real = fs.realpathSync(path.resolve(value));
  return process.platform === "win32" ? real.toLowerCase() : real;
};
export function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, timeout: 10000, stdio: "pipe" }).trim();

// Evidence comes from Git, never an isolation flag supplied by the planner.
export function inspectWorkspace(workspace) {
  const root = canonicalPath(workspace);
  try {
    const top = canonicalPath(git(root, "rev-parse", "--show-toplevel"));
    const common = canonicalPath(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    const branch = git(root, "symbolic-ref", "--quiet", "HEAD");
    const head = git(root, "rev-parse", "HEAD");
    const registered = git(root, "worktree", "list", "--porcelain").split(/\r?\n\r?\n/).some(block => {
      const lines = block.split(/\r?\n/);
      const worktree = lines.find(line => line.startsWith("worktree "))?.slice(9);
      return worktree && canonicalPath(worktree) === top && lines.includes(`branch ${branch}`);
    });
    return { workspace: root, top, gitCommonDir: common, branch, head, registered };
  } catch { return { workspace: root, top: root, gitCommonDir: null, branch: null, head: null, registered: false }; }
}

export function verifyWorkspace(projectPath, workspace, lanes, access) {
  const project = inspectWorkspace(projectPath), info = inspectWorkspace(workspace);
  if (!containsPath(project.workspace, info.workspace) && (!project.gitCommonDir || project.gitCommonDir !== info.gitCommonDir)) {
    throw new Error("Workspace is outside the authorized project/repository");
  }
  if (access === "write" && (!info.registered || info.workspace !== info.top || !info.branch || info.gitCommonDir !== project.gitCommonDir)) {
    throw new Error("Writing requires the root of a registered Git worktree on a named branch of this repository");
  }
  for (const lane of lanes.filter(lane => lane.workspace)) {
    const other = inspectWorkspace(lane.workspace);
    if (access !== "write" && lane.access !== "write") continue;
    if (other.top === info.top || (other.gitCommonDir === info.gitCommonDir && other.branch === info.branch)) {
      throw new Error("Parallel chats require different verified Git worktrees and branches");
    }
  }
  return info;
}

// Scratch-folder isolation is intentionally limited to disposable, non-Git
// project trees. It provides separate filesystem roots for small integration
// exercises when native worktrees are unavailable; it is not a sandbox.
export function verifyScratchWorkspace(projectPath, workspace, lanes) {
  const project = inspectWorkspace(projectPath), info = inspectWorkspace(workspace);
  if (project.gitCommonDir || info.gitCommonDir) {
    throw new Error("Scratch-folder mode cannot be used inside a Git checkout; use verified worktrees");
  }
  if (project.workspace === info.workspace || !containsPath(project.workspace, info.workspace)) {
    throw new Error("Each scratch workspace must be a child folder of the authorized project");
  }
  let cursor = info.workspace;
  while (containsPath(project.workspace, cursor)) {
    if (fs.existsSync(path.join(cursor, ".git"))) throw new Error("Scratch folders cannot contain or cross a Git checkout");
    if (cursor === project.workspace) break;
    cursor = path.dirname(cursor);
  }
  for (const lane of lanes.filter(lane => lane.workspace)) {
    const other = canonicalPath(lane.workspace);
    if (containsPath(other, info.workspace) || containsPath(info.workspace, other)) {
      throw new Error("Parallel scratch workspaces must be separate, non-overlapping folders");
    }
  }
  return info;
}
