import path from "node:path";
import { ARC_MAP_WORKSPACE } from "./constants";

/**
 * Resolve a repo name to an absolute path inside the workspace.
 * Throws if repoName would escape the workspace.
 */
export function resolveRepoPath(repoName: string): string {
  const repoPath = path.resolve(path.join(ARC_MAP_WORKSPACE, repoName));
  const workspaceResolved = path.resolve(ARC_MAP_WORKSPACE);
  if (
    repoPath === workspaceResolved ||
    !repoPath.startsWith(workspaceResolved + path.sep)
  ) {
    if (repoPath === workspaceResolved) {
      throw new Error(`Invalid repoName: must be a child of workspace`);
    }
    if (!repoPath.startsWith(workspaceResolved + path.sep)) {
      throw new Error(`Invalid repoName: path escapes workspace`);
    }
  }
  return repoPath;
}

export function assertInsideRepo(repoPath: string, filePath: string): string {
  const resolved = path.resolve(path.join(repoPath, filePath));
  if (
    resolved !== repoPath &&
    !resolved.startsWith(repoPath + path.sep)
  ) {
    throw new Error(`Invalid filePath: escapes repository`);
  }
  return resolved;
}
