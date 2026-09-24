import { createTool } from "@mastra/core/tools";
import { stat, readFile as fsReadFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ARC_MAP_WORKSPACE } from "../../lib/constants";
import { resolveRepoPath } from "../../lib/workspace";

/** Classifies a dependency as internal or external. */
function classifyDep(name: string): "internal" | "external" {
  if (name.startsWith("@/") || name.startsWith("~/") || name.startsWith("#") || name.startsWith(".")) return "internal";
  return "external";
}

export const analyzeDependencies = createTool({
  id: "analyze-dependencies",
  description: "Classifies internal vs external dependencies and flags drift signals like dual styling.",
  inputSchema: z.object({
    repoName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  }),
  outputSchema: z.object({
    repoName: z.string(),
    localPath: z.string(),
    workspace: z.string(),
    hasPackageJson: z.boolean(),
    totalDeps: z.number(),
    internalDeps: z.array(z.string()),
    externalDeps: z.array(z.string()),
    devDeps: z.array(z.string()),
    driftSignals: z.array(z.string()),
    summary: z.object({
      total: z.number(),
      internal: z.number(),
      external: z.number(),
      hasDualStyling: z.boolean(),
    }),
    warnings: z.array(z.string()),
  }),
  execute: async ({ repoName }) => {
    // Validate the repository before reading package.json.
    const repoPath = resolveRepoPath(repoName);
    try {
      const s = await stat(repoPath);
      if (!s.isDirectory()) throw new Error();
    } catch {
      throw new Error(`Repository "${repoName}" not found at ${repoPath}`);
    }

    const warnings: string[] = [];
    const pkgPath = path.join(repoPath, "package.json");

    let hasPackageJson = false;
    let totalDeps = 0;
    const internalDeps: string[] = [];
    const externalDeps: string[] = [];
    const devDeps: string[] = [];
    const driftSignals: string[] = [];

    // Read and parse package.json within size limit.
    try {
      const s = await stat(pkgPath);
      if (s.size > 1024 * 1024) {
        warnings.push("package.json too large, skipping");
      } else {
        const content = await fsReadFile(pkgPath, "utf-8");
        hasPackageJson = true;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(content);
        } catch {
          warnings.push("Could not parse package.json");
          json = {};
        }

        const deps = (json.dependencies as Record<string, string>) ?? {};
        const dev = (json.devDependencies as Record<string, string>) ?? {};

        for (const name of Object.keys(deps)) {
          totalDeps += 1;
          if (classifyDep(name) === "internal") internalDeps.push(name);
          else externalDeps.push(name);
        }
        for (const name of Object.keys(dev)) {
          devDeps.push(name);
        }

        // Detect drift signals
        const allDeps = new Set([...Object.keys(deps), ...Object.keys(dev)]);
        const hasTailwind = allDeps.has("tailwindcss");
        const hasStyled = allDeps.has("styled-components");
        const hasEmotion = allDeps.has("@emotion/react") || allDeps.has("@emotion/styled");
        if (hasTailwind && (hasStyled || hasEmotion)) {
          driftSignals.push("Dual styling: tailwind + styled-components/emotion installed");
        }
        if (allDeps.has("prisma") && allDeps.has("drizzle-orm")) {
          driftSignals.push("Dual ORM: prisma + drizzle-orm");
        }
        if (allDeps.has("next") && externalDeps.length > 50) {
          driftSignals.push("High external dependency count (>50) — potential coupling drift");
        }
      }
    } catch {
      warnings.push("No package.json found");
    }

    const hasDualStyling = driftSignals.some((s) => s.includes("Dual styling"));

    return {
      repoName,
      localPath: repoPath,
      workspace: ARC_MAP_WORKSPACE,
      hasPackageJson,
      totalDeps,
      internalDeps,
      externalDeps,
      devDeps,
      driftSignals,
      summary: { total: totalDeps, internal: internalDeps.length, external: externalDeps.length, hasDualStyling },
      warnings,
    };
  },
});
