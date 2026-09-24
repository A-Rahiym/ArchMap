import { createTool } from "@mastra/core/tools";
import { readdir, stat, readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ARC_MAP_WORKSPACE } from "../../lib/constants";
import { resolveRepoPath } from "../../lib/workspace";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", ".turbo", ".mastra", "coverage"]);

/** Extracts static and dynamic import sources from file content. */
function extractImports(content: string): string[] {
  const imports: string[] = [];
  const staticRegex = /(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  let m: RegExpExecArray | null;
  while ((m = staticRegex.exec(content)) !== null) {
    const src = m[1] ?? m[2] ?? m[3];
    if (src) imports.push(src);
  }
  // export ... from "..."
  const exportRegex = /export\s+(?:.*?\s+from\s+['"]([^'"]+)['"])/g;
  while ((m = exportRegex.exec(content)) !== null) {
    if (m[1]) imports.push(m[1]);
  }
  return [...new Set(imports)];
}

/** Classifies a file path into an architecture layer. */
function classifyLayer(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.includes("/api/") || lower.includes("route.ts") || lower.includes("route.js")) return "api";
  if (lower.includes("/repository/") || lower.includes("/repositories/")) return "repository";
  if (lower.includes("/service/") || lower.includes("/services/")) return "service";
  if (lower.includes("/components/") || lower.includes("/ui/")) return "ui";
  if (lower.includes("/hooks/")) return "hook";
  if (lower.includes("/lib/") || lower.includes("/utils/") || lower.includes("/helpers/")) return "lib";
  if (lower.includes("/store/") || lower.includes("/stores/") || lower.includes("/state/")) return "state";
  if (lower.includes("/domains/")) {
    if (lower.includes("/components/")) return "ui";
    if (lower.includes("/service/")) return "service";
    if (lower.includes("/repository/")) return "repository";
  }
  if (lower.includes("/app/") && (lower.endsWith("/page.tsx") || lower.endsWith("/page.ts") || lower.endsWith("/layout.tsx"))) return "page";
  return "unknown";
}

/** Returns true if an import is a relative/internal path. */
function isInternalImport(source: string): boolean {
  return source.startsWith(".") || source.startsWith("@/") || source.startsWith("~/") || source.startsWith("#");
}

/** Detects whether an import represents a layer bypass. */
function isLayerBypass(fromLayer: string, toLayer: string): boolean {
  // ui should not directly import repository; page should not directly import repository bypassing service
  if (fromLayer === "ui" && toLayer === "repository") return true;
  if (fromLayer === "page" && toLayer === "repository") return true;
  if (fromLayer === "ui" && toLayer === "api") return true;
  if (fromLayer === "hook" && toLayer === "repository") return true;
  return false;
}

export const analyzeImports = createTool({
  id: "analyze-imports",
  description: "Builds import graph and flags layer bypasses for blast-radius context.",
  inputSchema: z.object({
    repoName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  }),
  outputSchema: z.object({
    repoName: z.string(),
    localPath: z.string(),
    workspace: z.string(),
    totalFilesScanned: z.number(),
    totalImports: z.number(),
    graph: z.array(
      z.object({
        relativePath: z.string(),
        layer: z.string(),
        imports: z.array(z.string()),
        internalImports: z.array(z.string()),
        externalImports: z.array(z.string()),
      })
    ),
    bypasses: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        fromLayer: z.string(),
        toLayer: z.string(),
        source: z.string(),
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

    // Extract imports from each file.
    const graph: Array<{
      relativePath: string;
      layer: string;
      imports: string[];
      internalImports: string[];
      externalImports: string[];
    }> = [];
    const byLayer: Record<string, number> = {};
    let totalImports = 0;

    const fileContents = new Map<string, string>();
    for (const rel of files) {
      const full = path.join(repoPath, rel);
      try {
        const s = await stat(full);
        if (s.size > 500 * 1024) continue;
        const content = await fsReadFile(full, "utf-8");
        if (content.includes("\0")) continue;
        fileContents.set(rel, content);
      } catch {
        warnings.push(`Could not read: ${rel}`);
      }
    }

    // Build layer map for bypass detection
    const layerByFile = new Map<string, string>();
    for (const rel of fileContents.keys()) {
      layerByFile.set(rel, classifyLayer(rel));
    }

    const bypasses: Array<{ from: string; to: string; fromLayer: string; toLayer: string; source: string }> = [];

    for (const [rel, content] of fileContents) {
      const imports = extractImports(content);
      const internalImports = imports.filter(isInternalImport);
      const externalImports = imports.filter((s) => !isInternalImport(s));
      const layer = layerByFile.get(rel) ?? "unknown";
      byLayer[layer] = (byLayer[layer] || 0) + 1;
      totalImports += imports.length;
      graph.push({ relativePath: rel, layer, imports, internalImports, externalImports });

      // Detect bypasses for internal imports that resolve to known layers
      // Heuristic: match imported path substring against known file paths
      for (const src of internalImports) {
        // Try to find target file by suffix match
        let targetLayer: string | null = null;
        let targetFile: string | null = null;
        for (const [candidateRel, candidateLayer] of layerByFile) {
          const base = path.basename(candidateRel, path.extname(candidateRel));
          const withoutExt = candidateRel.replace(/\.[^/.]+$/, "");
          if (src.endsWith(base) || src.endsWith(withoutExt) || candidateRel.includes(src.replace(/^@\//, "").replace(/^\.\//, ""))) {
            // approximate match - first hit
            if (!targetLayer) {
              targetLayer = candidateLayer;
              targetFile = candidateRel;
            }
          }
        }
        if (targetLayer && isLayerBypass(layer, targetLayer) && targetFile) {
          bypasses.push({ from: rel, to: targetFile, fromLayer: layer, toLayer: targetLayer, source: src });
        }
      }
    }

    return {
      repoName,
      localPath: repoPath,
      workspace: ARC_MAP_WORKSPACE,
      totalFilesScanned: fileContents.size,
      totalImports,
      graph,
      bypasses,
      summary: { byLayer, bypassCount: bypasses.length },
      warnings,
    };
  },
});
