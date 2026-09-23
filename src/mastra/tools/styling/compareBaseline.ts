import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { ARC_MAP_WORKSPACE } from "../../lib/constants";
import { resolveRepoPath } from "../../lib/workspace";
import { analyzeStyles } from "./analyzeStyles";
import { analyzeResponsive } from "./analyzeResponsive";
import { analyzeDesignTokens } from "./analyzeDesignTokens";
import { stat } from "node:fs/promises";

type Deviation = {
  relativePath: string;
  category: "color" | "spacing" | "typography" | "radius" | "shadow" | "breakpoint";
  valueUsed: string;
  expectedValue: string | null;
  expectedSource: "declared" | "inferred";
  frequency: number;
  severity: "low" | "medium" | "high";
  source: string | null;
};

type StylesResult = {
  valuesByFile: Array<{
    relativePath: string;
    colors: string[];
    spacing: string[];
    typography: string[];
    radius: string[];
    shadow: string[];
    hexColors: string[];
  }>;
  totalFilesScanned: number;
  warnings: string[];
};

type ResponsiveResult = {
  declaredBreakpoints: string[];
  declaredSource: string | null;
  usageByFile: Array<{
    relativePath: string;
    adHocValues: string[];
  }>;
  warnings: string[];
};

type TokensResult = {
  hasDeclaredTokens: boolean;
  declaredSources: Array<{ relativePath: string }>;
  declaredTokens: {
    colors: string[];
    spacing: string[];
    typography: string[];
    radius: string[];
  };
  inferredBaseline: {
    dominantHexColors: string[];
    dominantSpacing: string[];
  } | null;
  warnings: string[];
};

/** Checks whether a Tailwind value uses arbitrary syntax such as `p-[13px]`. */
function isArbitraryValue(value: string): boolean {
  return value.includes("[") && value.includes("]");
}

/** Executes a child Mastra tool with the current input and a minimal context object. */
async function executeAnalyzer<T>(execute: unknown, repoName: string): Promise<T> {
  if (typeof execute !== "function") {
    throw new Error("Styling analyzer has no execute function");
  }
  const run = execute as (
    input: { repoName: string },
    context: Record<string, never>
  ) => Promise<T>;
  return run({ repoName }, {});
}

export const compareBaseline = createTool({
  id: "compare-baseline",
  description:
    "Compares actual style/breakpoint usage against declared or inferred baseline and returns deviations with severity.",
  inputSchema: z.object({
    repoName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  }),
  outputSchema: z.object({
    repoName: z.string(),
    localPath: z.string(),
    workspace: z.string(),
    hasDeclaredTokens: z.boolean(),
    totalFilesScanned: z.number(),
    deviationCount: z.number(),
    deviations: z.array(
      z.object({
        relativePath: z.string(),
        category: z.enum(["color", "spacing", "typography", "radius", "shadow", "breakpoint"]),
        valueUsed: z.string(),
        expectedValue: z.string().nullable(),
        expectedSource: z.enum(["declared", "inferred"]),
        frequency: z.number(),
        severity: z.enum(["low", "medium", "high"]),
        source: z.string().nullable(),
      })
    ),
    summary: z.object({
      byCategory: z.record(z.string(), z.number()),
      bySeverity: z.record(z.string(), z.number()),
      uniqueValuesFlagged: z.number(),
    }),
    warnings: z.array(z.string()),
  }),
  execute: async ({ repoName }) => {
    // Validate the repository before coordinating child analyzers.
    const repoPath = resolveRepoPath(repoName);
    try {
      const s = await stat(repoPath);
      if (!s.isDirectory()) throw new Error();
    } catch {
      throw new Error(`Repository "${repoName}" not found at ${repoPath}`);
    }

    const warnings: string[] = [];

    // Gather style usage, responsive usage, and baseline evidence in parallel.
    const [stylesRes, responsiveRes, tokensRes] = await Promise.all([
      executeAnalyzer<StylesResult>(analyzeStyles.execute, repoName),
      executeAnalyzer<ResponsiveResult>(analyzeResponsive.execute, repoName),
      executeAnalyzer<TokensResult>(analyzeDesignTokens.execute, repoName),
    ]);

    const hasDeclaredTokens = tokensRes.hasDeclaredTokens;
    const declaredSource = tokensRes.declaredSources[0]?.relativePath ?? responsiveRes.declaredSource ?? null;
    warnings.push(...stylesRes.warnings, ...responsiveRes.warnings, ...tokensRes.warnings);

    // Build declared-first expected sets with inferred fallback values.
    const declaredColors = new Set(tokensRes.declaredTokens.colors.map((c) => c.toLowerCase()));
    const declaredSpacing = new Set(tokensRes.declaredTokens.spacing);
    const declaredTypography = new Set(tokensRes.declaredTokens.typography);
    const declaredRadius = new Set(tokensRes.declaredTokens.radius);
    const declaredBreakpoints = responsiveRes.declaredBreakpoints;

    const inferredHex = new Set((tokensRes.inferredBaseline?.dominantHexColors ?? []).map((c) => c.toLowerCase()));
    const inferredSpacing = new Set(tokensRes.inferredBaseline?.dominantSpacing ?? []);

    // Count values across files so deviation severity reflects repeated usage.
    const hexFreq = new Map<string, number>();
    const spacingFreq = new Map<string, number>();
    const colorFreq = new Map<string, number>();

    for (const f of stylesRes.valuesByFile) {
      for (const h of f.hexColors) {
        const key = h.toLowerCase();
        hexFreq.set(key, (hexFreq.get(key) || 0) + 1);
      }
      for (const c of f.colors) {
        colorFreq.set(c, (colorFreq.get(c) || 0) + 1);
      }
      for (const s of f.spacing) {
        spacingFreq.set(s, (spacingFreq.get(s) || 0) + 1);
      }
    }

    const deviations: Deviation[] = [];

    // Avoid reporting drift when a tiny repository has no usable baseline.
    const hasAnyBaseline =
      hasDeclaredTokens ||
      (tokensRes.inferredBaseline &&
        (tokensRes.inferredBaseline.dominantHexColors.length > 0 ||
          tokensRes.inferredBaseline.dominantSpacing.length > 0)) ||
      declaredColors.size > 0 ||
      declaredSpacing.size > 0 ||
      declaredBreakpoints.length > 0;

    if (!hasAnyBaseline && stylesRes.valuesByFile.length <= 1) {
      warnings.push("No baseline to compare — too few values (tiny repo)");
      return {
        repoName,
        localPath: repoPath,
        workspace: ARC_MAP_WORKSPACE,
        hasDeclaredTokens,
        totalFilesScanned: stylesRes.totalFilesScanned,
        deviationCount: 0,
        deviations: [],
        summary: { byCategory: {}, bySeverity: {}, uniqueValuesFlagged: 0 },
        warnings,
      };
    }

    /** Reports whether a category has declared token values available for comparison. */
    const isDeclaredCategory = (cat: "color" | "spacing" | "typography" | "radius" | "shadow") => {
      if (cat === "color") return declaredColors.size > 0;
      if (cat === "spacing") return declaredSpacing.size > 0;
      if (cat === "typography") return declaredTypography.size > 0;
      if (cat === "radius") return declaredRadius.size > 0;
      return false;
    };

    // Compare each extracted style category against its expected values.
    for (const file of stylesRes.valuesByFile) {
      const rel = file.relativePath;

      // Colors: hex
      for (const hex of file.hexColors) {
        const key = hex.toLowerCase();
        const declared = declaredColors.has(key);
        const inferred = inferredHex.has(key);
        if (declared || inferred) continue; // not deviation

        // Determine expected
        const expectedSource: "declared" | "inferred" = hasDeclaredTokens && declaredColors.size > 0 ? "declared" : "inferred";
        const expectedValue =
          expectedSource === "declared"
            ? Array.from(declaredColors)[0] ?? null
            : inferredHex.size > 0
              ? Array.from(inferredHex)[0]
              : null;

        const freq = hexFreq.get(key) || 1;
        // severity: arbitrary hex not in dominant/inferred + high if freq high or is arbitrary bright?
        // For inferred baseline, single-occurrence hex is high if not dominant, else low
        let severity: "low" | "medium" | "high" = "medium";
        if (expectedSource === "inferred") {
          severity = freq === 1 ? "medium" : "low";
          if (hexFreq.size > 10) severity = "medium";
        } else {
          severity = freq > 3 ? "high" : freq > 1 ? "medium" : "high"; // declared missing is serious
        }
        // low if near dominant? keep medium for now

        deviations.push({
          relativePath: rel,
          category: "color",
          valueUsed: hex,
          expectedValue,
          expectedSource,
          frequency: freq,
          severity,
          source: declaredSource,
        });
      }

      // Colors: tailwind color classes
      for (const cls of file.colors) {
        const isArbitrary = isArbitraryValue(cls);
        // Named Tailwind classes cannot be mapped reliably to declared hex values
        // without resolving the project's Tailwind theme. Only arbitrary values
        // are actionable until that mapping exists.
        if (!isArbitrary) continue;

        const expectedSource: "declared" | "inferred" = declaredColors.size > 0 ? "declared" : "inferred";
        const expectedValue = expectedSource === "declared"
          ? Array.from(declaredColors)[0] ?? null
          : inferredHex.size > 0
            ? Array.from(inferredHex)[0]
            : null;
        deviations.push({
          relativePath: rel,
          category: "color",
          valueUsed: cls,
          expectedValue,
          expectedSource,
          frequency: colorFreq.get(cls) || 1,
          severity: "high",
          source: declaredSource,
        });
      }

      // Spacing
      for (const sp of file.spacing) {
        const isArbitrary = isArbitraryValue(sp);
        const freq = spacingFreq.get(sp) || 1;

        let isExpected = false;
        if (isDeclaredCategory("spacing")) {
          // declared spacing keys are like "4", "8" — check if sp ends with -<key>
          for (const k of declaredSpacing) {
            if (sp.endsWith(`-${k}`) || sp === k) {
              isExpected = true;
              break;
            }
          }
        } else {
          isExpected = inferredSpacing.has(sp);
        }

        if (isExpected && !isArbitrary) continue;

        const expectedSource: "declared" | "inferred" = isDeclaredCategory("spacing") ? "declared" : "inferred";
        const expectedValue =
          expectedSource === "declared"
            ? declaredSpacing.size > 0
              ? `p-${Array.from(declaredSpacing)[0]}`
              : null
            : inferredSpacing.size > 0
              ? Array.from(inferredSpacing)[0]
              : null;

        const severity: "low" | "medium" | "high" = isArbitrary ? "high" : expectedSource === "declared" ? "medium" : freq === 1 ? "medium" : "low";

        deviations.push({
          relativePath: rel,
          category: "spacing",
          valueUsed: sp,
          expectedValue,
          expectedSource,
          frequency: freq,
          severity,
          source: declaredSource,
        });
      }

      // Typography, radius, shadow - similar, flag arbitrary or declared-missing
      for (const t of file.typography) {
        const isArbitrary = isArbitraryValue(t);
        if (!isDeclaredCategory("typography") && !isArbitrary) continue;
        if (isDeclaredCategory("typography")) {
          let ok = false;
          for (const k of declaredTypography) if (t.includes(k)) { ok = true; break; }
          if (ok && !isArbitrary) continue;
        }
        deviations.push({
          relativePath: rel,
          category: "typography",
          valueUsed: t,
          expectedValue: declaredTypography.size > 0 ? Array.from(declaredTypography)[0] : null,
          expectedSource: isDeclaredCategory("typography") ? "declared" : "inferred",
          frequency: 1,
          severity: isArbitrary ? "high" : "medium",
          source: declaredSource,
        });
      }

      for (const r of file.radius) {
        const isArbitrary = isArbitraryValue(r);
        if (!isDeclaredCategory("radius") && !isArbitrary) continue;
        if (isDeclaredCategory("radius")) {
          let ok = false;
          for (const k of declaredRadius) if (r.includes(k)) { ok = true; break; }
          if (ok && !isArbitrary) continue;
        }
        deviations.push({
          relativePath: rel,
          category: "radius",
          valueUsed: r,
          expectedValue: declaredRadius.size > 0 ? Array.from(declaredRadius)[0] : null,
          expectedSource: isDeclaredCategory("radius") ? "declared" : "inferred",
          frequency: 1,
          severity: isArbitrary ? "high" : "medium",
          source: declaredSource,
        });
      }

      for (const s of file.shadow) {
        const isArbitrary = isArbitraryValue(s);
        // shadow rarely has declared tokens; flag arbitrary only for inferred
        if (!isArbitrary) continue;
        deviations.push({
          relativePath: rel,
          category: "shadow",
          valueUsed: s,
          expectedValue: null,
          expectedSource: "inferred",
          frequency: 1,
          severity: "medium",
          source: declaredSource,
        });
      }
    }

    // Add responsive deviations reported by the breakpoint analyzer.
    for (const bf of responsiveRes.usageByFile) {
      for (const adHoc of bf.adHocValues) {
        deviations.push({
          relativePath: bf.relativePath,
          category: "breakpoint",
          valueUsed: adHoc,
          expectedValue: declaredBreakpoints.join(", "),
          expectedSource: responsiveRes.declaredSource ? "declared" : "inferred",
          frequency: 1,
          severity: "medium",
          source: responsiveRes.declaredSource,
        });
      }
    }

    // Aggregate category, severity, and unique-value summaries.
    const byCategory: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    const uniq = new Set<string>();
    for (const d of deviations) {
      byCategory[d.category] = (byCategory[d.category] || 0) + 1;
      bySeverity[d.severity] = (bySeverity[d.severity] || 0) + 1;
      uniq.add(`${d.category}:${d.valueUsed}`);
    }

    return {
      repoName,
      localPath: repoPath,
      workspace: ARC_MAP_WORKSPACE,
      hasDeclaredTokens,
      totalFilesScanned: stylesRes.totalFilesScanned,
      deviationCount: deviations.length,
      deviations,
      summary: {
        byCategory,
        bySeverity,
        uniqueValuesFlagged: uniq.size,
      },
      warnings,
    };
  },
});
