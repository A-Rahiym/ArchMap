import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

const ARC_MAP_WORKSPACE = path.join(process.cwd(),".workspace");

export const cloneRepo = createTool({
  id: "clone-repo",

  description:
    "Clones a public GitHub repository into ArcMap's temporary workspace and returns its local path.",

  inputSchema: z.object({
    repoUrl: z.string().url(),
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

    const repoName = url.pathname
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/\.git$/, "");

    if (!repoName) {
      throw new Error("Could not determine repository name.");
    }

    // Where this repository will live
    const repoPath = path.join(
      ARC_MAP_WORKSPACE,
      repoName
    );

    // Check if the repository already exists
    try {
      await access(repoPath);
      throw new Error(
        `Repository "${repoName}" is already cloned at ${repoPath}`
      );
    } catch (error) {
      // Ignore "does not exist" errors.
      // Re-throw our own "already cloned" error.
      if (
        error instanceof Error &&
        error.message.startsWith("Repository")
      ) {
        throw error;
      }
    }

    // Clone the repository
    await execFileAsync("git", [
      "clone",
      "--depth",
      "1",
      repoUrl,
      repoPath,
    ]);

    return {
      repoUrl,
      localPath: repoPath,
    };
  },
});