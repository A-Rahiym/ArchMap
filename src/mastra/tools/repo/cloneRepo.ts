import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { ARC_MAP_WORKSPACE } from "../../lib/constants";

const execFileAsync = promisify(execFile);

export const cloneRepo = createTool({
  id: "clone-repo",

  description:
    "Clones a public GitHub repository into ArcMap's temporary workspace and returns its local path.",

  inputSchema: z.object({
    repoUrl: z.url(),
  }),

  outputSchema: z.object({
    repoUrl: z.string(),
    localPath: z.string(),
  }),

  execute: async ({ repoUrl }) => {
    // Get the repository name from the URL
    const url = new URL(repoUrl);

    if (url.hostname !== "github.com") {
      throw new Error("Only GitHub repositories are supported.");
    }

    const rawName = url.pathname.split("/").filter(Boolean).pop() ?? "";
    const repoName = rawName.replace(/\.git$/, "").trim();

    if (!repoName) {
      throw new Error("Could not determine repository name.");
    }

    // Where this repository will live
    const repoPath = path.join(ARC_MAP_WORKSPACE, repoName);

    // Ensure workspace exists
    await mkdir(ARC_MAP_WORKSPACE, { recursive: true });

    // Check if the repository already exists
    try {
      const s = await stat(repoPath);
      if (s.isDirectory()) {
        throw new Error(
          `Repository "${repoName}" is already cloned at ${repoPath}`
        );
      }
    } catch (error) {
      // Ignore "does not exist" errors.
      // Re-throw our own "already cloned" error.
      if (
        error instanceof Error &&
        error.message.startsWith("Repository")
      ) {
        throw error;
      }
      // ENOENT means not exists — continue; other errors should surface via access fallback
      if (error instanceof Error && "code" in error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code && code !== "ENOENT") {
          // For non-ENOENT filesystem errors, still check via access to be safe
          try {
            await access(repoPath);
            throw new Error(
              `Repository "${repoName}" is already cloned at ${repoPath}`
            );
          } catch {}
        }
      }
    }

    // Clone the repository
    try {
      await execFileAsync("git", [
        "clone",
        "--depth",
        "1",
        repoUrl,
        repoPath,
      ]);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err);
      // Include stderr if available
      const stderr =
        err && typeof err === "object" && "stderr" in err
          ? String((err as { stderr: unknown }).stderr)
          : "";
      throw new Error(
        `git clone failed for ${repoUrl}: ${msg}${stderr ? ` — ${stderr}` : ""}`
      );
    }

    return {
      repoUrl,
      localPath: repoPath,
    };
  },
});