import { createTool } from "@mastra/core/tools";
import { readdir, stat, readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ARC_MAP_WORKSPACE } from "../../lib/constants";
import { resolveRepoPath } from "../../lib/workspace";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "build", ".turbo", ".mastra", "coverage"]);

type StylingApproach = "tailwind" | "css-modules" | "styled-components" | "mixed" | "unknown";

function detectApproach(fileContents: Map<string, string>, fileList: string[]): StylingApproach {
  let hasTailwind = false;
  let hasCssModules = false;
  let hasStyled = false;

  for (const rel of fileList) {
    if (rel.includes("tailwind.config")) hasTailwind = true;
    if (rel.endsWith(".module.css") || rel.endsWith(".module.scss")) hasCssModules = true;
  }
  for (const content of fileContents.values()) {
    if (content.includes("tailwind") || /\b(bg-|text-|p-|m-|flex|grid)\b/.test(content)) {
      // heuristic: tailwind class strings
      if (/className=.*\b(bg-|text-|p-|m-|rounded|shadow)\b/.test(content)) hasTailwind = true;
    }
    if (content.includes("styled-components") || content.includes("styled(") || content.includes("css`")) hasStyled = true;
  }

  const count = [hasTailwind, hasCssModules, hasStyled].filter(Boolean).length;
  if (count > 1) return "mixed";
  if (hasTailwind) return "tailwind";
  if (hasCssModules) return "css-modules";
  if (hasStyled) return "styled-components";
  return "unknown";
}

function extractTailwindClasses(content: string): string[] {
  const classRegex = /className\s*=\s*["'`]([^"'`]+)["'`]/g;
  const classes: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = classRegex.exec(content)) !== null) {
    const parts = m[1].split(/\s+/).filter(Boolean);
    classes.push(...parts);
  }
  // also class="..." for html
  const classHtmlRegex = /class\s*=\s*["'`]([^"'`]+)["'`]/g;
  while ((m = classHtmlRegex.exec(content)) !== null) {
    const parts = m[1].split(/\s+/).filter(Boolean);
    classes.push(...parts);
  }
  return classes;
}

function categorizeTailwindClass(cls: string): { category: string; value: string } | null {
  // strip responsive prefix e.g. md:bg-red-500 -> bg-red-500
  const base = cls.includes(":") ? cls.split(":").pop()! : cls;

  if (/^(bg|text|border|from|to|via)-/.test(base)) return { category: "color", value: cls };
  if (/^(p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|space-x|space-y)-/.test(base)) return { category: "spacing", value: cls };
  if (/^text-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|\[.*\])/.test(base) || /^font-/.test(base) || /^leading-/.test(base) || /^tracking-/.test(base)) return { category: "typography", value: cls };
  if (/^rounded/.test(base)) return { category: "radius", value: cls };
  if (/^shadow/.test(base)) return { category: "shadow", value: cls };
  // arbitrary values like p-[13px] or bg-[#ff0000]
  if (/^\w+-\[.*\]$/.test(base)) {
    if (base.startsWith("bg-") || base.startsWith("text-") || base.startsWith("border-")) return { category: "color", value: cls };
    if (base.startsWith("p-") || base.startsWith("m-") || base.startsWith("gap-")) return { category: "spacing", value: cls };
    return { category: "other", value: cls };
  }
  return null;
}

export const analyzeStyles = createTool({
  id: "analyze-styles",
  description: "Detects styling approach and extracts actual style values (color, spacing, typography, radius, shadow) per file.",
  inputSchema: z.object({
    repoName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  }),
  outputSchema: z.object({
    repoName: z.string(),
    localPath: z.string(),
    workspace: z.string(),
    stylingApproach: z.string(),
    totalFilesScanned: z.number(),
    valuesByFile: z.array(
      z.object({
        relativePath: z.string(),
        colors: z.array(z.string()),
        spacing: z.array(z.string()),
        typography: z.array(z.string()),
        radius: z.array(z.string()),
        shadow: z.array(z.string()),
        hexColors: z.array(z.string()),
        rawClasses: z.array(z.string()),
      })
    ),
    summary: z.object({
      totalColors: z.number(),
      totalSpacing: z.number(),
      totalTypography: z.number(),
      totalRadius: z.number(),
      totalShadow: z.number(),
      uniqueHexColors: z.array(z.string()),
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
          if ([".tsx", ".ts", ".jsx", ".js", ".css", ".scss", ".sass", ".less"].includes(ext)) {
            if (files.length < 2000) files.push(rel);
          }
        }
      }
    }

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

    const stylingApproach: StylingApproach = detectApproach(fileContents, files);

    const valuesByFile: Array<{
      relativePath: string;
      colors: string[];
      spacing: string[];
      typography: string[];
      radius: string[];
      shadow: string[];
      hexColors: string[];
      rawClasses: string[];
    }> = [];

    const allHex = new Set<string>();
    let totalColors = 0, totalSpacing = 0, totalTypography = 0, totalRadius = 0, totalShadow = 0;

    const hexRegex = /#([0-9a-fA-F]{3,8})\b/g;
    const rgbRegex = /rgba?\(\s*[^)]+\)/g;
    const hslRegex = /hsla?\(\s*[^)]+\)/g;

    for (const [rel, content] of fileContents) {
      const rawClasses = extractTailwindClasses(content);
      const colors: string[] = [];
      const spacing: string[] = [];
      const typography: string[] = [];
      const radius: string[] = [];
      const shadow: string[] = [];
      const hexColors: string[] = [];

      for (const cls of rawClasses) {
        const cat = categorizeTailwindClass(cls);
        if (!cat) continue;
        if (cat.category === "color") colors.push(cat.value);
        else if (cat.category === "spacing") spacing.push(cat.value);
        else if (cat.category === "typography") typography.push(cat.value);
        else if (cat.category === "radius") radius.push(cat.value);
        else if (cat.category === "shadow") shadow.push(cat.value);
      }

      // also extract raw CSS color values
      let m: RegExpExecArray | null;
      const hexRe = new RegExp(hexRegex);
      while ((m = hexRe.exec(content)) !== null) {
        const hex = m[0].toLowerCase();
        hexColors.push(hex);
        allHex.add(hex);
      }
      const rgbRe = new RegExp(rgbRegex, "g");
      while ((m = rgbRe.exec(content)) !== null) {
        hexColors.push(m[0]);
      }
      const hslRe = new RegExp(hslRegex, "g");
      while ((m = hslRe.exec(content)) !== null) {
        hexColors.push(m[0]);
      }

      // CSS property extraction for non-tailwind
      const spacingCssRegex = /(padding|margin|gap)\s*:\s*([^;]+);/g;
      while ((m = spacingCssRegex.exec(content)) !== null) {
        spacing.push(m[0].trim());
      }
      const radiusCssRegex = /border-radius\s*:\s*([^;]+);/g;
      while ((m = radiusCssRegex.exec(content)) !== null) {
        radius.push(m[0].trim());
      }
      const shadowCssRegex = /box-shadow\s*:\s*([^;]+);/g;
      while ((m = shadowCssRegex.exec(content)) !== null) {
        shadow.push(m[0].trim());
      }

      totalColors += colors.length;
      totalSpacing += spacing.length;
      totalTypography += typography.length;
      totalRadius += radius.length;
      totalShadow += shadow.length;

      if (colors.length || spacing.length || typography.length || radius.length || shadow.length || hexColors.length || rawClasses.length) {
        valuesByFile.push({
          relativePath: rel,
          colors,
          spacing,
          typography,
          radius,
          shadow,
          hexColors,
          rawClasses,
        });
      }
    }

    return {
      repoName,
      localPath: repoPath,
      workspace: ARC_MAP_WORKSPACE,
      stylingApproach,
      totalFilesScanned: fileContents.size,
      valuesByFile,
      summary: {
        totalColors,
        totalSpacing,
        totalTypography,
        totalRadius,
        totalShadow,
        uniqueHexColors: Array.from(allHex),
      },
      warnings,
    };
  },
});
