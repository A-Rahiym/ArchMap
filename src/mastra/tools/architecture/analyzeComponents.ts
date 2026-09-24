import { createTool } from "@mastra/core/tools";
import { readdir, stat, readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ARC_MAP_WORKSPACE } from "../../lib/constants";
import { resolveRepoPath } from "../../lib/workspace";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", ".turbo", ".mastra", "coverage"]);

/** Reports whether file content defines a React component. */
function isComponent(content: string): boolean {
  if (/export\s+default\s+function\s+[A-Z]/.test(content)) return true;
  if (/function\s+[A-Z]\w*\s*\(.*\)\s*\{[^}]*return\s*\(/.test(content)) return true;
  if (/const\s+[A-Z]\w*\s*=\s*\(.*\)\s*=>/.test(content) && content.includes("return")) return true;
  if (/React\.FC|React\.Component/.test(content)) return true;
  if (/<[A-Z]\w*/.test(content) && content.includes("return")) return true;
  // JSX heuristic: contains JSX tags and is a TSX file content
  if (/<[a-z]+\s*[^>]*>/.test(content) && /className|onClick|useState|useEffect/.test(content)) return true;
  return false;
}

/** Extracts the component name from file content. */
function extractComponentName(content: string, relativePath: string): string | null {
  const defaultFn = content.match(/export\s+default\s+function\s+([A-Z]\w*)/);
  if (defaultFn) return defaultFn[1];
  const constComp = content.match(/export\s+(?:const|function)\s+([A-Z]\w*)/);
  if (constComp) return constComp[1];
  const namedConst = content.match(/const\s+([A-Z]\w*)\s*=\s*\(/);
  if (namedConst) return namedConst[1];
  // fallback to file basename
  const base = path.basename(relativePath, path.extname(relativePath));
  if (/^[A-Z]/.test(base)) return base;
  return null;
}

/** Reports whether a file is a page file. */
function isPageFile(relativePath: string): boolean {
  return (
    relativePath.endsWith("/page.tsx") ||
    relativePath.endsWith("/page.ts") ||
    relativePath.endsWith("/page.jsx") ||
    relativePath.endsWith("/page.js") ||
    relativePath.includes("/pages/") ||
    relativePath.endsWith("/layout.tsx") ||
    relativePath.endsWith("/layout.ts")
  );
}

/** Counts hook usage in component. */
function countHooks(content: string): number {
  const hookRegex = /\buse[A-Z]\w*\s*\(/g;
  return (content.match(hookRegex) || []).length;
}

export const analyzeComponents = createTool({
  id: "analyze-components",
  description: "Classifies components and pages, measures consumer potential for blast radius.",
  inputSchema: z.object({
    repoName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  }),
  outputSchema: z.object({
    repoName: z.string(),
    localPath: z.string(),
    workspace: z.string(),
    totalFilesScanned: z.number(),
    componentCount: z.number(),
    pageCount: z.number(),
    components: z.array(
      z.object({
        relativePath: z.string(),
        name: z.string().nullable(),
        isComponent: z.boolean(),
        isPage: z.boolean(),
        hookCount: z.number(),
      })
    ),
    summary: z.object({
      totalComponents: z.number(),
      totalPages: z.number(),
      sharedComponents: z.number(),
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

    // Extract component classification for each file.
    const components: Array<{
      relativePath: string;
      name: string | null;
      isComponent: boolean;
      isPage: boolean;
      hookCount: number;
    }> = [];

    let componentCount = 0;
    let pageCount = 0;

    for (const rel of files) {
      const full = path.join(repoPath, rel);
      try {
        const s = await stat(full);
        if (s.size > 500 * 1024) continue;
        const content = await fsReadFile(full, "utf-8");
        if (content.includes("\0")) continue;
        const comp = isComponent(content);
        const isPage = isPageFile(rel);
        const name = comp || isPage ? extractComponentName(content, rel) : null;
        const hookCount = comp ? countHooks(content) : 0;
        if (comp) componentCount += 1;
        if (isPage) pageCount += 1;
        if (comp || isPage) {
          components.push({ relativePath: rel, name, isComponent: comp, isPage, hookCount });
        }
      } catch {
        warnings.push(`Could not read: ${rel}`);
      }
    }

    // Heuristic for shared components: under domains/ui/components or src/components
    const sharedComponents = components.filter(
      (c) => c.isComponent && (c.relativePath.includes("/ui/components") || c.relativePath.includes("/components/") || c.relativePath.includes("domains/ui"))
    ).length;

    return {
      repoName,
      localPath: repoPath,
      workspace: ARC_MAP_WORKSPACE,
      totalFilesScanned: files.length,
      componentCount,
      pageCount,
      components,
      summary: { totalComponents: componentCount, totalPages: pageCount, sharedComponents },
      warnings,
    };
  },
});
