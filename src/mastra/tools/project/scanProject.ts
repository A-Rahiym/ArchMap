import { createTool } from "@mastra/core/tools";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ARC_MAP_WORKSPACE } from "../../lib/constants";
import { resolveRepoPath } from "../../lib/workspace";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  "build",
  ".turbo",
  ".mastra",
  "coverage",
  ".nyc_output",
]);

const IGNORED_FILES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

type FileType =
  | "component"
  | "page"
  | "route"
  | "style"
  | "config"
  | "test"
  | "source"
  | "asset"
  | "other";

function classifyFile(relativePath: string): FileType {
  const lower = relativePath.toLowerCase();
  const ext = path.extname(lower);

  // test
  if (
    lower.includes("__tests__") ||
    lower.includes("__test__") ||
    lower.endsWith(".test.ts") ||
    lower.endsWith(".test.tsx") ||
    lower.endsWith(".test.js") ||
    lower.endsWith(".test.jsx") ||
    lower.endsWith(".spec.ts") ||
    lower.endsWith(".spec.tsx") ||
    lower.endsWith(".spec.js")
  ) {
    return "test";
  }

  // style
  if (
    [".css", ".scss", ".sass", ".less"].includes(ext) ||
    lower.endsWith("tailwind.config.js") ||
    lower.endsWith("tailwind.config.ts") ||
    lower.endsWith("tailwind.config.cjs") ||
    lower.endsWith("tailwind.config.mjs")
  ) {
    return "style";
  }

  // config
  if (
    [".json", ".config.js", ".config.ts", ".config.cjs", ".config.mjs"].some(
      (s) => lower.endsWith(s)
    ) ||
    lower === "tsconfig.json" ||
    lower === "jsconfig.json" ||
    lower.endsWith(".env") ||
    lower.endsWith(".env.example")
  ) {
    // .json but not source — narrow
    if (ext === ".json" || lower.includes("config")) return "config";
  }

  // route / page
  if (
    lower.includes("app/") &&
    (lower.endsWith("page.tsx") ||
      lower.endsWith("page.ts") ||
      lower.endsWith("page.jsx") ||
      lower.endsWith("page.js") ||
      lower.endsWith("route.ts") ||
      lower.endsWith("route.js"))
  ) {
    return "route";
  }
  if (lower.startsWith("pages/") && [".tsx", ".ts", ".jsx", ".js"].includes(ext)) {
    return "page";
  }

  // component
  if (
    lower.includes("components/") &&
    [".tsx", ".jsx"].includes(ext)
  ) {
    return "component";
  }
  // heuristic: any .tsx/.jsx outside pages/app is likely component
  if ([".tsx", ".jsx"].includes(ext)) {
    return "component";
  }

  // source
  if ([".ts", ".js", ".mjs", ".cjs"].includes(ext)) {
    return "source";
  }

  if ([".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf"].includes(ext)) {
    return "asset";
  }

  return "other";
}

export const scanProject = createTool({
  id: "scan-project",
  description:
    "Scans a cloned repository in the workspace and classifies files by type. Returns counts and file list for downstream analysis.",
  inputSchema: z.object({
    repoName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  }),
  outputSchema: z.object({
    repoName: z.string(),
    localPath: z.string(),
    workspace: z.string(),
    totalFiles: z.number(),
    truncated: z.boolean(),
    filesByType: z.record(z.string(), z.number()),
    files: z.array(
      z.object({
        path: z.string(),
        relativePath: z.string(),
        type: z.string(),
        size: z.number(),
      })
    ),
    warnings: z.array(z.string()),
  }),
  execute: async ({ repoName }) => {
    const repoPath = resolveRepoPath(repoName);
    const workspace = ARC_MAP_WORKSPACE;

    // verify exists
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(repoPath);
    } catch {
      throw new Error(`Repository "${repoName}" not found at ${repoPath}. Clone it first.`);
    }
    if (!s.isDirectory()) {
      throw new Error(`Path ${repoPath} is not a directory`);
    }

    const files: Array<{ path: string; relativePath: string; type: FileType; size: number }> = [];
    const filesByType: Record<string, number> = {};
    const warnings: string[] = [];
    const MAX_FILES = 5000;

    const queue: string[] = [repoPath];

    while (queue.length > 0) {
      const dir = queue.shift()!;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        warnings.push(`Could not read directory: ${path.relative(repoPath, dir)}`);
        continue;
      }

      for (const entry of entries) {
        if (IGNORED_FILES.has(entry)) continue;
        const full = path.join(dir, entry);
        const rel = path.relative(repoPath, full);

        let st: Awaited<ReturnType<typeof stat>>;
        try {
          st = await stat(full);
        } catch {
          warnings.push(`Could not stat: ${rel}`);
          continue;
        }

        if (st.isDirectory()) {
          if (IGNORED_DIRS.has(entry)) continue;
          // skip hidden dirs except .well-known handling — skip all dot dirs except we already handle .git/.next/.mastra
          if (entry.startsWith(".") && entry !== ".well-known") {
            // allow .github but skip
            if (entry === ".github") continue;
            // skip other dot dirs to reduce noise
            continue;
          }
          queue.push(full);
        } else if (st.isFile()) {
          // skip hidden files and lock files already filtered, skip large binaries > 5MB from listing (but count)
          if (entry.startsWith(".") && entry !== ".env" && entry !== ".env.example") continue;
          const type = classifyFile(rel);
          filesByType[type] = (filesByType[type] || 0) + 1;
          if (files.length < MAX_FILES) {
            files.push({
              path: full,
              relativePath: rel,
              type,
              size: st.size,
            });
          }
        }
      }
    }

    const truncated = files.length >= MAX_FILES;
    if (truncated) {
      warnings.push(`File list truncated to ${MAX_FILES} entries`);
    }

    const totalFiles = Object.values(filesByType).reduce((a, b) => a + b, 0);

    return {
      repoName,
      localPath: repoPath,
      workspace,
      totalFiles,
      truncated,
      filesByType,
      files,
      warnings,
    };
  },
});
