// src/mastra/tools/clone-repo.ts

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);


export const cloneRepo = createTool({
  id: "clone-repo",
  description:
    "Clones a public GitHub repository into a temporary directory and returns its local path.",

  inputSchema: z.object({
    repoUrl: z.string().url(),
  }),

  outputSchema: z.object({
    repoUrl: z.string(),
    localPath: z.string(),
  }),

  execute: async ({ repoUrl }) => {
    // Create a temporary workspace
    const tempDir = await mkdtemp(
      path.join(os.tmpdir(), "arcmap-")
    );
    const repoPath = path.join(tempDir, "repo");
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