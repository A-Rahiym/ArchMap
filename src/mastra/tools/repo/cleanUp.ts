import { createTool } from "@mastra/core/tools";
import { rm } from "fs/promises";
import z from "zod";
import path from "node:path";
import { ARC_MAP_WORKSPACE } from "../../lib/constants";

export const cleanUpRepo = createTool({
  id: "cleanup-repo",
  description:
    "Cleans up a cloned repository by removing the temporary directory.",
  inputSchema: z.object({
    repoName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    repoName: z.string()
  }),

  execute: async ({ repoName }) => {
    const repoPath = path.resolve(path.join(ARC_MAP_WORKSPACE, repoName));
    const workspaceResolved = path.resolve(ARC_MAP_WORKSPACE);
    if (
      repoPath !== workspaceResolved &&
      !repoPath.startsWith(workspaceResolved + path.sep)
    ) {
      throw new Error(`Invalid repoName: path escapes workspace`);
    }

    await rm(repoPath, {
      recursive: true,
      force: true,
    });

    return {
      success: true,
      repoName,
    };
  },
});