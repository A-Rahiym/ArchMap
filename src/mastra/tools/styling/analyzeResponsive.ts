import { createTool } from "@mastra/core/tools";
import { readdir, stat, readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ARC_MAP_WORKSPACE } from "../../lib/constants";
import { resolveRepoPath } from "../../lib/workspace";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", ".turbo", ".mastra", "coverage"]);

export const analyzeResponsive = createTool({
  id: "analyze-responsive",
  description: "Extracts breakpoint usage per file and flags ad-hoc breakpoints not in the declared set.",
  inputSchema: z.object({
    repoName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  }),
  outputSchema: z.object({
    repoName: z.string(),
    localPath: z.string(),
    workspace: z.string(),
    declaredBreakpoints: z.array(z.string()),
    declaredSource: z.string().nullable(),
    usageByFile: z.array(
      z.object({
        relativePath: z.string(),
        tailwindPrefixes: z.array(z.string()),
        mediaQueries: z.array(z.string()),
        adHocValues: z.array(z.string()),
      })
    ),
    summary: z.object({
      totalFilesWithResponsive: z.number(),
      uniqueTailwindPrefixes: z.array(z.string()),
      uniqueMediaQueries: z.array(z.string()),
      adHocBreakpoints: z.array(z.string()),
    }),
    warnings: z.array(z.string()),
  }),
  execute: async ({ repoName }) => {
    const repoPath = resolveRepoPath(repoName);
    try {
      const s = await stat(repoPath);
      if (!s.isDirectory()) throw new Error();
    } catch {
      throw new Error(`Repository "${repoName}" not found at ${repoPath}`);
    }

    // Step 1: try to find declared breakpoints from tailwind config
    let declaredBreakpoints: string[] = [];
    let declaredSource: string | null = null;
    const configCandidates = [
      "tailwind.config.js",
      "tailwind.config.ts",
      "tailwind.config.cjs",
      "tailwind.config.mjs",
    ];

    // BFS to find config files
    const queueFind: string[] = [repoPath];
    const foundConfigs: string[] = [];
    while (queueFind.length > 0) {
      const dir = queueFind.shift()!;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
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
          // limit depth for config search
          if (rel.split(path.sep).length > 3) continue;
          queueFind.push(full);
        } else if (configCandidates.includes(entry)) {
          foundConfigs.push(full);
        }
      }
    }

    if (foundConfigs.length > 0) {
      declaredSource = path.relative(repoPath, foundConfigs[0]);
      try {
        const content = await fsReadFile(foundConfigs[0], "utf-8");
        // naive parse: look for screens: { ... } or theme.screens
        const screensMatch = content.match(/screens\s*:\s*\{([^}]+)\}/s);
        if (screensMatch) {
          const inner = screensMatch[1];
          const keys = [...inner.matchAll(/['"]?(\w+)['"]?\s*:/g)].map((m) => m[1]);
          declaredBreakpoints = keys;
        } else {
          // default tailwind breakpoints if config exists but no custom screens
          declaredBreakpoints = ["sm", "md", "lg", "xl", "2xl"];
        }
        if (declaredBreakpoints.length === 0) {
          declaredBreakpoints = ["sm", "md", "lg", "xl", "2xl"];
        }
      } catch {
        declaredBreakpoints = ["sm", "md", "lg", "xl", "2xl"];
      }
    } else {
      // no config — use default tailwind set as assumed
      declaredBreakpoints = ["sm", "md", "lg", "xl", "2xl"];
    }

    // Step 2: scan files for usage
    const files: string[] = [];
    const queue: string[] = [repoPath];
    const warnings: string[] = [];

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
          if ([".tsx", ".ts", ".jsx", ".js", ".css", ".scss"].includes(ext)) {
            if (files.length < 2000) files.push(path.relative(repoPath, full));
          }
        }
      }
    }

    const tailwindPrefixRegex = /\b(sm|md|lg|xl|2xl|xs|3xl|4xl):[^\s"'`]+/g;
    const mediaQueryRegex = /@media\s*\(.*?(?:min-width|max-width)\s*:\s*([^)]+)\)/g;
    // capture arbitrary breakpoint values like w-[137px] or min-w-[500px]
    const arbitraryValueRegex = /\[(\d+px|\d+rem|\d+em)\]/g;

    const usageByFile: Array<{
      relativePath: string;
      tailwindPrefixes: string[];
      mediaQueries: string[];
      adHocValues: string[];
    }> = [];

    const allPrefixes = new Set<string>();
    const allMedia = new Set<string>();
    const allAdHoc = new Set<string>();

    for (const rel of files) {
      const full = path.join(repoPath, rel);
      let content: string;
      try {
        const s = await stat(full);
        if (s.size > 500 * 1024) continue;
        content = await fsReadFile(full, "utf-8");
        if (content.includes("\0")) continue;
      } catch {
        continue;
      }

      const tailwindPrefixes: string[] = [];
      const mediaQueries: string[] = [];
      const adHocValues: string[] = [];

      let m: RegExpExecArray | null;
      const twRe = new RegExp(tailwindPrefixRegex);
      while ((m = twRe.exec(content)) !== null) {
        const prefix = m[0].split(":")[0];
        tailwindPrefixes.push(m[0]);
        allPrefixes.add(prefix);
        if (!declaredBreakpoints.includes(prefix)) {
          adHocValues.push(m[0]);
          allAdHoc.add(m[0]);
        }
      }

      const mqRe = new RegExp(mediaQueryRegex, "g");
      while ((m = mqRe.exec(content)) !== null) {
        const val = m[0].trim();
        mediaQueries.push(val);
        allMedia.add(val);
        // check if media value matches declared breakpoints numeric values? we only have keys, so treat any media query as ad-hoc if no config source
        // For now, flag media queries with px values not matching typical breakpoints
        const pxMatch = m[1];
        if (pxMatch && !["640px", "768px", "1024px", "1280px", "1536px"].some((v) => pxMatch.includes(v))) {
          // also check if config had custom values — we don't have numeric mapping, so flag as ad-hoc
          adHocValues.push(val);
          allAdHoc.add(val);
        }
      }

      // also catch arbitrary values
      const arbRe = new RegExp(arbitraryValueRegex, "g");
      while ((m = arbRe.exec(content)) !== null) {
        adHocValues.push(m[0]);
        allAdHoc.add(m[0]);
      }

      if (tailwindPrefixes.length || mediaQueries.length || adHocValues.length) {
        usageByFile.push({
          relativePath: rel,
          tailwindPrefixes: [...new Set(tailwindPrefixes)],
          mediaQueries: [...new Set(mediaQueries)],
          adHocValues: [...new Set(adHocValues)],
        });
      }
    }

    return {
      repoName,
      localPath: repoPath,
      workspace: ARC_MAP_WORKSPACE,
      declaredBreakpoints,
      declaredSource,
      usageByFile,
      summary: {
        totalFilesWithResponsive: usageByFile.length,
        uniqueTailwindPrefixes: Array.from(allPrefixes),
        uniqueMediaQueries: Array.from(allMedia),
        adHocBreakpoints: Array.from(allAdHoc),
      },
      warnings,
    };
  },
});
