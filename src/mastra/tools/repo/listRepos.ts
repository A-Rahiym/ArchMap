import { createTool } from "@mastra/core/tools";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ARC_MAP_WORKSPACE } from "../../lib/constants";

export const listRepos = createTool({
  id: "list-repos",
  description: "Lists repositories currently cloned into ArcMap's workspace.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    repos: z.array(
      z.object({
        name: z.string(),
        localPath: z.string(),
      })
    ),
    workspace: z.string(),
  }),
  execute: async () => {
    let entries: string[] = [];
    try {
      entries = await readdir(ARC_MAP_WORKSPACE);
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return { repos: [], workspace: ARC_MAP_WORKSPACE };
      }
      throw err;
    }

    const repos: { name: string; localPath: string }[] = [];
    for (const name of entries) {
      const full = path.join(ARC_MAP_WORKSPACE, name);
      try {
        const s = await stat(full);
        if (s.isDirectory()) {
          repos.push({ name, localPath: full });
        }
      } catch {
        // ignore unreadable entries
      }
    }

    return { repos, workspace: ARC_MAP_WORKSPACE };
  },
});
