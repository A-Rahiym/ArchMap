import { createTool } from "@mastra/core/tools";
import { readdir, stat, readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ARC_MAP_WORKSPACE } from "../../lib/constants";
import { resolveRepoPath } from "../../lib/workspace";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", ".turbo", ".mastra", "coverage"]);

/** Extracts data-flow signals from file content. */
function extractDataSignals(content: string): {
  hasFetch: boolean;
  hasSupabase: boolean;
  hasPrisma: boolean;
  hasQuery: boolean;
  hasMutation: boolean;
  hasContext: boolean;
  hasDirectDb: boolean;
} {
  return {
    hasFetch: /\bfetch\s*\(/.test(content) || /useQuery|useMutation/.test(content),
    hasSupabase: /supabase|createClient/.test(content),
    hasPrisma: /prisma\./.test(content),
    hasQuery: /query|Query/.test(content) && /select|findMany|findOne/.test(content),
    hasMutation: /mutation|insert|update|delete/.test(content),
    hasContext: /createContext|useContext/.test(content),
    hasDirectDb: /prisma\.|supabase\.from\(/.test(content),
  };
}

/** Classifies data-flow layer of a file. */
function classifyDataLayer(relativePath: string, signals: ReturnType<typeof extractDataSignals>): string {
  const lower = relativePath.toLowerCase();
  if (lower.includes("/repository/")) return "repository";
  if (lower.includes("/service/")) return "service";
  if (lower.includes("/api/") || lower.includes("route.ts")) return "api";
  if (lower.includes("/query/") || lower.includes("/mutation/")) return "query";
  if (lower.includes("/store/") || lower.includes("/context/")) return "state";
  if (signals.hasDirectDb) return "direct-db-access";
  if (signals.hasFetch) return "fetch";
  return "none";
}

/** Detects if file bypasses service layer. */
function isBypass(relativePath: string, signals: ReturnType<typeof extractDataSignals>): boolean {
  const lower = relativePath.toLowerCase();
  const isUiOrPage =
    lower.includes("/components/") ||
    lower.includes("/ui/") ||
    lower.endsWith("/page.tsx") ||
    lower.endsWith("/page.ts") ||
    lower.includes("/app/");
  if (isUiOrPage && signals.hasDirectDb) return true;
  if (isUiOrPage && signals.hasPrisma) return true;
  return false;
}

export const analyzeDataFlow = createTool({
  id: "analyze-data-flow",
  description: "Analyzes data-flow patterns and flags direct DB/API bypasses.",
  inputSchema: z.object({
    repoName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  }),
  outputSchema: z.object({
    repoName: z.string(),
    localPath: z.string(),
    workspace: z.string(),
    totalFilesScanned: z.number(),
    bypassCount: z.number(),
    flows: z.array(
      z.object({
        relativePath: z.string(),
        layer: z.string(),
        signals: z.object({
          hasFetch: z.boolean(),
          hasSupabase: z.boolean(),
          hasPrisma: z.boolean(),
          hasDirectDb: z.boolean(),
        }),
        isBypass: z.boolean(),
      })
    ),
    summary: z.object({
      byLayer: z.record(z.string(), z.number()),
      bypassCount: z.number(),
    }),
    warnings: z.array(z.string()),
  }),
  execute: async ({ repoName }) => {
    // Validate the repository before scanning.
    const repoPath = resolveRepoPath(repoName);
    try {
      const s = await stat(repoPath);
      if (!s.isDirectory()) throw new Error();
    } catch {
      throw new Error(`Repository "${repoName}" not found at ${repoPath}`);
    }

    const warnings: string[] = [];

    // Discover source files within bounded search depth.
    const files: string[] = [];
    const queue: string[] = [repoPath];
    while (queue.length > 0) {
      const dir = queue.shift()!;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        warnings.push(`Could not read dir: ${path.relative(repoPath, dir)}`);
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry);
        const rel = path.relative(repoPath, full);
        let st: Awaited<ReturnType<typeof stat>>;
        try {
          st = await stat(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          if (IGNORED_DIRS.has(entry) || entry.startsWith(".")) continue;
          queue.push(full);
        } else if (st.isFile()) {
          const ext = path.extname(entry).toLowerCase();
          if ([".tsx", ".ts", ".jsx", ".js"].includes(ext)) {
            if (files.length < 2000) files.push(rel);
          }
        }
      }
    }

    // Extract data-flow signals per file.
    const flows: Array<{
      relativePath: string;
      layer: string;
      signals: { hasFetch: boolean; hasSupabase: boolean; hasPrisma: boolean; hasDirectDb: boolean };
      isBypass: boolean;
    }> = [];
    const byLayer: Record<string, number> = {};
    let bypassCount = 0;

    for (const rel of files) {
      const full = path.join(repoPath, rel);
      try {
        const s = await stat(full);
        if (s.size > 500 * 1024) continue;
        const content = await fsReadFile(full, "utf-8");
        if (content.includes("\0")) continue;
        const signals = extractDataSignals(content);
        const layer = classifyDataLayer(rel, signals);
        const bypass = isBypass(rel, signals);
        if (bypass) bypassCount += 1;
        byLayer[layer] = (byLayer[layer] || 0) + 1;
        // Only include files with any data signal or relevant layer
        if (signals.hasFetch || signals.hasSupabase || signals.hasPrisma || signals.hasDirectDb || layer !== "none") {
          flows.push({
            relativePath: rel,
            layer,
            signals: {
              hasFetch: signals.hasFetch,
              hasSupabase: signals.hasSupabase,
              hasPrisma: signals.hasPrisma,
              hasDirectDb: signals.hasDirectDb,
            },
            isBypass: bypass,
          });
        }
      } catch {
        warnings.push(`Could not read: ${rel}`);
      }
    }

    return {
      repoName,
      localPath: repoPath,
      workspace: ARC_MAP_WORKSPACE,
      totalFilesScanned: files.length,
      bypassCount,
      flows,
      summary: { byLayer, bypassCount },
      warnings,
    };
  },
});