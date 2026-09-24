import { createTool } from "@mastra/core/tools";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ARC_MAP_WORKSPACE } from "../../lib/constants";
import { resolveRepoPath } from "../../lib/workspace";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", ".turbo", ".mastra", "coverage"]);

/** Converts a file path to a Next.js route path. */
function fileToRoute(relativePath: string): string | null {
  // App router: app/[locale]/board/page.tsx -> /[locale]/board, app/page.tsx -> /
  if (relativePath.includes("/page.tsx") || relativePath.includes("/page.ts") || relativePath.includes("/page.jsx") || relativePath.includes("/page.js")) {
    let route = relativePath;
    // Strip up to app/ prefix
    const appIdx = route.indexOf("app/");
    if (appIdx !== -1) route = route.slice(appIdx + 4);
    else {
      const pagesIdx = route.indexOf("pages/");
      if (pagesIdx !== -1) route = route.slice(pagesIdx + 6);
      else return null;
    }
    route = route.replace(/\/page\.(tsx|ts|jsx|js)$/, "");
    // Handle route groups (parentheses) and remove them
    route = route.replace(/\/\([^)]+\)/g, "");
    if (route === "" || route === "/") return "/";
    // Normalize
    if (!route.startsWith("/")) route = "/" + route;
    // Remove trailing segments like /index
    route = route.replace(/\/index$/, "");
    if (route === "") return "/";
    return route;
  }
  // Pages router: pages/api/..., pages/index.tsx
  if (relativePath.includes("pages/")) {
    let route = relativePath.slice(relativePath.indexOf("pages/") + 6);
    route = route.replace(/\.(tsx|ts|jsx|js)$/, "");
    if (route === "index") return "/";
    if (route.endsWith("/index")) route = route.slice(0, -6);
    if (!route.startsWith("/")) route = "/" + route;
    return route;
  }
  return null;
}

/** Extracts dynamic segment info from route. */
function getRouteType(route: string): string {
  if (route.includes("[")) return "dynamic";
  return "static";
}

export const analyzeRoutes = createTool({
  id: "analyze-routes",
  description: "Maps file-system routes to components for route-aware blast radius.",
  inputSchema: z.object({
    repoName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  }),
  outputSchema: z.object({
    repoName: z.string(),
    localPath: z.string(),
    workspace: z.string(),
    totalFilesScanned: z.number(),
    routeCount: z.number(),
    routes: z.array(
      z.object({
        route: z.string(),
        relativePath: z.string(),
        type: z.string(),
      })
    ),
    summary: z.object({
      totalRoutes: z.number(),
      dynamicRoutes: z.number(),
      staticRoutes: z.number(),
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

    // Extract routes from file list.
    const routes: Array<{ route: string; relativePath: string; type: string }> = [];
    for (const rel of files) {
      const route = fileToRoute(rel);
      if (route) {
        routes.push({ route, relativePath: rel, type: getRouteType(route) });
      }
    }

    const dynamicRoutes = routes.filter((r) => r.type === "dynamic").length;
    const staticRoutes = routes.filter((r) => r.type === "static").length;

    return {
      repoName,
      localPath: repoPath,
      workspace: ARC_MAP_WORKSPACE,
      totalFilesScanned: files.length,
      routeCount: routes.length,
      routes,
      summary: { totalRoutes: routes.length, dynamicRoutes, staticRoutes },
      warnings,
    };
  },
});
