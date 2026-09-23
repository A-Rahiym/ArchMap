import { createTool } from "@mastra/core/tools";
import { readdir, stat, readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ARC_MAP_WORKSPACE } from "../../lib/constants";
import { resolveRepoPath } from "../../lib/workspace";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", ".turbo", ".mastra", "coverage"]);

/** Narrows an unknown value to a non-array object for token traversal. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively collects primitive leaf values from a nested token group. */
function collectLeafValues(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number") {
    return [String(value)];
  }
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(collectLeafValues);
}

/** Recursively collects keys from nested token groups for named token categories. */
function collectObjectKeys(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...collectObjectKeys(child),
  ]);
}

/** Adds token categories found in a parsed JSON token document to the accumulators. */
function addJsonTokens(
  json: unknown,
  declaredColors: string[],
  declaredSpacing: string[],
  declaredTypography: string[],
  declaredRadius: string[],
  declaredBreakpoints: string[]
): void {
  if (!isRecord(json)) return;

  const colors = json.colors ?? json.color;
  const spacing = json.spacing;
  const typography = json.typography ?? json.fontSize ?? json.fonts;
  const radius = json.radius ?? json.borderRadius;
  const breakpoints = json.breakpoints ?? json.screens;

  declaredColors.push(...collectLeafValues(colors));
  declaredSpacing.push(...collectObjectKeys(spacing));
  declaredTypography.push(...collectObjectKeys(typography));
  declaredRadius.push(...collectObjectKeys(radius));
  declaredBreakpoints.push(...collectObjectKeys(breakpoints));
}

/** Extracts and classifies CSS custom properties from a stylesheet. */
function extractCssTokens(content: string): {
  colors: string[];
  spacing: string[];
  typography: string[];
  radius: string[];
  breakpoints: string[];
} {
  const tokens = {
    colors: [] as string[],
    spacing: [] as string[],
    typography: [] as string[],
    radius: [] as string[],
    breakpoints: [] as string[],
  };
  const customPropertyRegex = /(--[\w-]+)\s*:\s*([^;{}]+)(?:;|$)/g;
  const colorValueRegex = /^(?:#(?:[\da-f]{3,8})\b|rgba?\([^)]*\)|hsla?\([^)]*\))/i;

  for (const match of content.matchAll(customPropertyRegex)) {
    const name = match[1].toLowerCase();
    const value = match[2].trim();

    if (colorValueRegex.test(value)) {
      tokens.colors.push(value.toLowerCase());
    }
    if (/(?:font|type|line-height|letter-spacing)/.test(name)) {
      tokens.typography.push(name);
    }
    if (/(?:spacing|space|pad|margin|gap|width|height|size)/.test(name)) {
      tokens.spacing.push(name);
    }
    if (/radius/.test(name)) {
      tokens.radius.push(name);
    }
    if (/(?:breakpoint|screen|\bbp\b)/.test(name)) {
      tokens.breakpoints.push(name);
    }
  }

  return tokens;
}

function isStylesheetTokenCandidate(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return [".css", ".scss", ".sass", ".less"].some((extension) => lower.endsWith(extension));
}

export const analyzeDesignTokens = createTool({
  id: "analyze-design-tokens",
  description:
    "Extracts declared design tokens (tailwind config, tokens.json, theme file) or falls back to inferred baseline. Reports where tokens are declared.",
  inputSchema: z.object({
    repoName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  }),
  outputSchema: z.object({
    repoName: z.string(),
    localPath: z.string(),
    workspace: z.string(),
    hasDeclaredTokens: z.boolean(),
    declaredSources: z.array(
      z.object({
        relativePath: z.string(),
        type: z.string(),
      })
    ),
    declaredTokens: z.object({
      colors: z.array(z.string()),
      spacing: z.array(z.string()),
      typography: z.array(z.string()),
      radius: z.array(z.string()),
      breakpoints: z.array(z.string()),
    }),
    inferredBaseline: z.object({
      dominantHexColors: z.array(z.string()),
      dominantSpacing: z.array(z.string()),
      note: z.string(),
    }).nullable(),
    warnings: z.array(z.string()),
  }),
  execute: async ({ repoName }) => {
    // Validate the repository before searching for declared token sources.
    const repoPath = resolveRepoPath(repoName);
    try {
      const s = await stat(repoPath);
      if (!s.isDirectory()) throw new Error();
    } catch {
      throw new Error(`Repository "${repoName}" not found at ${repoPath}`);
    }

    const warnings: string[] = [];
    const declaredSources: Array<{ relativePath: string; type: string }> = [];
    const declaredColors: string[] = [];
    const declaredSpacing: string[] = [];
    const declaredTypography: string[] = [];
    const declaredRadius: string[] = [];
    const declaredBreakpoints: string[] = [];

    // Find likely token and theme files within the bounded search depth.
    const queue: string[] = [repoPath];
    const candidateFiles: Array<{ full: string; rel: string }> = [];

    while (queue.length > 0) {
      const dir = queue.shift()!;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry);
        const rel = path.relative(repoPath, full);
        if (rel.split(path.sep).length > 4) continue; // limit depth for token search
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
          const lower = entry.toLowerCase();
          if (
            lower === "tailwind.config.js" ||
            lower === "tailwind.config.ts" ||
            lower === "tailwind.config.cjs" ||
            lower === "tailwind.config.mjs" ||
            lower === "tokens.json" ||
            lower === "design-tokens.json" ||
            lower === "theme.json" ||
            lower.endsWith("theme.ts") ||
            lower.endsWith("theme.js") ||
            lower === "tokens.ts"
            || isStylesheetTokenCandidate(lower)
          ) {
            candidateFiles.push({ full, rel });
          }
        }
      }
    }

    // Extract declared values from each candidate source.
    for (const { full, rel } of candidateFiles) {
      try {
        const content = await fsReadFile(full, "utf-8");
        if (content.includes("\0")) continue;

        let type = "unknown";
        const lower = path.basename(rel).toLowerCase();
        if (lower.startsWith("tailwind.config")) type = "tailwind-config";
        else if (lower.includes("tokens")) type = "tokens";
        else if (lower.includes("theme")) type = "theme";

        const stylesheetTokens = isStylesheetTokenCandidate(lower)
          ? extractCssTokens(content)
          : null;

        if (stylesheetTokens) {
          declaredColors.push(...stylesheetTokens.colors);
          declaredSpacing.push(...stylesheetTokens.spacing);
          declaredTypography.push(...stylesheetTokens.typography);
          declaredRadius.push(...stylesheetTokens.radius);
          declaredBreakpoints.push(...stylesheetTokens.breakpoints);
          if (
            stylesheetTokens.colors.length ||
            stylesheetTokens.spacing.length ||
            stylesheetTokens.typography.length ||
            stylesheetTokens.radius.length ||
            stylesheetTokens.breakpoints.length
          ) {
            declaredSources.push({ relativePath: rel, type: "css-custom-properties" });
          }
          continue;
        }

        declaredSources.push({ relativePath: rel, type });

        // naive extraction: look for colors, spacing, etc.
        // colors: extract hex and quoted color names in theme
        const hexRegex = /#([0-9a-fA-F]{3,8})\b/g;
        let m: RegExpExecArray | null;
        const hexRe = new RegExp(hexRegex);
        while ((m = hexRe.exec(content)) !== null) {
          declaredColors.push(m[0].toLowerCase());
        }

        // try to parse spacing keys if tailwind config has spacing/theme
        const spacingMatch = content.match(/spacing\s*:\s*\{([^}]+)\}/s);
        if (spacingMatch) {
          const keys = [...spacingMatch[1].matchAll(/['"]?([\w.-]+)['"]?\s*:/g)].map((x) => x[1]);
          declaredSpacing.push(...keys);
        }

        // typography
        const fontSizeMatch = content.match(/fontSize\s*:\s*\{([^}]+)\}/s);
        if (fontSizeMatch) {
          const keys = [...fontSizeMatch[1].matchAll(/['"]?([\w.-]+)['"]?\s*:/g)].map((x) => x[1]);
          declaredTypography.push(...keys);
        }

        // radius
        const radiusMatch = content.match(/borderRadius\s*:\s*\{([^}]+)\}/s);
        if (radiusMatch) {
          const keys = [...radiusMatch[1].matchAll(/['"]?([\w.-]+)['"]?\s*:/g)].map((x) => x[1]);
          declaredRadius.push(...keys);
        }

        // breakpoints
        const screensMatch = content.match(/screens\s*:\s*\{([^}]+)\}/s);
        if (screensMatch) {
          const keys = [...screensMatch[1].matchAll(/['"]?(\w+)['"]?\s*:/g)].map((x) => x[1]);
          declaredBreakpoints.push(...keys);
        }

        // If JSON, parse nested token groups structurally.
        if (rel.toLowerCase().endsWith(".json")) {
          try {
            const json = JSON.parse(content);
            addJsonTokens(
              json,
              declaredColors,
              declaredSpacing,
              declaredTypography,
              declaredRadius,
              declaredBreakpoints
            );
          } catch {
            warnings.push(`Could not parse token JSON: ${rel}`);
          }
        }
      } catch {
        warnings.push(`Could not read token file: ${rel}`);
      }
    }

    // A source file counts as declared only when it yielded usable token values.
    const hasDeclaredTokens =
      declaredColors.length > 0 ||
      declaredSpacing.length > 0 ||
      declaredTypography.length > 0 ||
      declaredRadius.length > 0 ||
      declaredBreakpoints.length > 0;

    let inferredBaseline: { dominantHexColors: string[]; dominantSpacing: string[]; note: string } | null = null;

    // Infer a baseline from dominant usage when no declared values are available.
    if (!hasDeclaredTokens) {
      // compute inferred baseline by scanning repo for dominant values
      // reuse similar walk as analyzeStyles but just for hex and spacing classes
      const files: string[] = [];
      const q: string[] = [repoPath];
      while (q.length > 0) {
        const dir = q.shift()!;
        let entries: string[];
        try {
          entries = await readdir(dir);
        } catch {
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
            q.push(full);
          } else if (st.isFile()) {
            const ext = path.extname(entry).toLowerCase();
            if ([".tsx", ".ts", ".jsx", ".js", ".css", ".scss"].includes(ext)) {
              if (files.length < 1000) files.push(path.relative(repoPath, full));
            }
          }
        }
      }

      const hexCount = new Map<string, number>();
      const spacingCount = new Map<string, number>();
      const hexRegex = /#([0-9a-fA-F]{3,8})\b/g;
      const spacingClassRegex = /\b(p|m|px|py|gap)-([0-9]+|(?:\[[^\]]+\]))\b/g;

      for (const rel of files) {
        const full = path.join(repoPath, rel);
        try {
          const s = await stat(full);
          if (s.size > 500 * 1024) continue;
          const content = await fsReadFile(full, "utf-8");
          if (content.includes("\0")) continue;

          let m: RegExpExecArray | null;
          const hexRe = new RegExp(hexRegex, "g");
          while ((m = hexRe.exec(content)) !== null) {
            const hex = m[0].toLowerCase();
            hexCount.set(hex, (hexCount.get(hex) || 0) + 1);
          }
          const spRe = new RegExp(spacingClassRegex, "g");
          while ((m = spRe.exec(content)) !== null) {
            const cls = m[0];
            spacingCount.set(cls, (spacingCount.get(cls) || 0) + 1);
          }
        } catch {
          continue;
        }
      }

      const dominantHexColors = [...hexCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([k]) => k);

      const dominantSpacing = [...spacingCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([k]) => k);

      inferredBaseline = {
        dominantHexColors,
        dominantSpacing,
        note: "No declared tokens found; baseline inferred from most common values in codebase (frequency).",
      };
    }

    return {
      repoName,
      localPath: repoPath,
      workspace: ARC_MAP_WORKSPACE,
      hasDeclaredTokens,
      declaredSources,
      declaredTokens: {
        colors: [...new Set(declaredColors)],
        spacing: [...new Set(declaredSpacing)],
        typography: [...new Set(declaredTypography)],
        radius: [...new Set(declaredRadius)],
        breakpoints: [...new Set(declaredBreakpoints)],
      },
      inferredBaseline,
      warnings,
    };
  },
});
