import { createTool } from "@mastra/core/tools";
import { rm } from "fs/promises";
import z from "zod";
import path from "node:path";

const ARC_MAP_WORKSPACE = path.join(process.cwd(), ".workspace");

export const cleanUpRepo = createTool({
  id: "cleanup-repo",
  description:
    "Cleans up a cloned repository by removing the temporary directory.",
  inputSchema: z.object({
    repoName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  }),

  outputSchema: z.object({
    success: z.boolean(),0
    repoName: z.string()
  }),

  execute: async ({ repoName }) => {
    const repoPath = path.join(ARC_MAP_WORKSPACE, repoName);

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
