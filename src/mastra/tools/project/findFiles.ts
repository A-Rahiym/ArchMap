import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { ARC_MAP_WORKSPACE } from "../../lib/constants";
import { resolveRepoPath } from "../../lib/workspace";

function globToRegExp(pattern: string): RegExp {
  // very small glob impl: * => [^/]*, ** => .*, ? => .
  // escape regex special chars except *? /
  let p = pattern;
  // handle ** first
  p = p.replace(/\*\*/g, "__DOUBLESTAR__");
  p = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  p = p.replace(/__DOUBLESTAR__/g, ".*");
  p = p.replace(/\*/g, "[^/]*");
  p = p.replace(/\?/g, "[^/]");
  return new RegExp("^" + p + "$", "i");
}

export const findFiles = createTool({
  id: "find-files",
  description:
    "Searches for files in a cloned repository that match a glob-like pattern or substring. Returns relative paths.",
  inputSchema: z.object({
    repoName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
    pattern: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  outputSchema: z.object({
    repoName: z.string(),
    pattern: z.string(),
    matches: z.array(
      z.object({
        path: z.string(),
        relativePath: z.string(),
      })
    ),
    truncated: z.boolean(),
    workspace: z.string(),
  }),
  execute: async ({ repoName, pattern, limit }) => {
    if (pattern.includes("..")) {
      throw new Error("Invalid pattern: must not contain '..'");
    }

    const repoPath = resolveRepoPath(repoName);

    try {
      const s = await stat(repoPath);
      if (!s.isDirectory()) throw new Error();
    } catch {
      throw new Error(`Repository "${repoName}" not found at ${repoPath}`);
    }

    const isGlob = pattern.includes("*") || pattern.includes("?");
    const re = isGlob ? globToRegExp(pattern) : null;
    const lowerPattern = pattern.toLowerCase();

    const matches: Array<{ path: string; relativePath: string }> = [];
    const queue: string[] = [repoPath];

    const IGNORED = new Set(["node_modules", ".git", "dist", ".next", ".turbo", ".mastra"]);

    while (queue.length > 0 && matches.length < limit) {
      const dir = queue.shift()!;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (matches.length >= limit) break;
        const full = path.join(dir, entry);
        const rel = path.relative(repoPath, full);

        let s: Awaited<ReturnType<typeof stat>>;
        try {
          s = await stat(full);
        } catch {
          continue;
        }

        if (s.isDirectory()) {
          if (IGNORED.has(entry) || entry.startsWith(".")) continue;
          queue.push(full);
        } else if (s.isFile()) {
          const hit = isGlob ? re!.test(rel) : rel.toLowerCase().includes(lowerPattern);
          if (hit) {
            matches.push({ path: full, relativePath: rel });
          }
        }
      }
    }

    // check if more would match (truncated)
    const truncated = matches.length >= limit;

    return {
      repoName,
      pattern,
      matches,
      truncated,
      workspace: ARC_MAP_WORKSPACE,
    };
  },
});
