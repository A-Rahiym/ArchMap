import { createTool } from "@mastra/core/tools";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { ARC_MAP_WORKSPACE } from "../../lib/constants";
import { resolveRepoPath } from "../../lib/workspace";
import { isArbitraryValue } from "../../lib/deviations";

const execFileAsync = promisify(execFile);

type HistoryEntry = {
  hash: string;
  author: string;
  date: string;
  message: string;
  files: string[];
};

type CommitEvidence = {
  hash: string;
  author: string;
  date: string;
};

type Attribution = CommitEvidence & {
  line: number | null;
  method: "git-search" | "none";
  confidence: "confirmed" | "approximate" | "unavailable";
};

/** Parses record- and NUL-delimited git log output without relying on message characters. */
function parseGitLog(raw: string): HistoryEntry[] {
  return raw
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const fields = record.split("\x00");
      const [hash = "", author = "", date = "", message = "", ...fileFields] = fields;
      return {
        hash: hash.trim(),
        author: author.trim(),
        date: date.trim(),
        message: message.trim(),
        files: fileFields.join("\x00").split("\n").map((file) => file.trim()).filter(Boolean),
      };
    })
    .filter((entry) => entry.hash.length > 0);
}

/** Checks whether the repository has limited history from a shallow clone. */
async function isShallowRepo(repoPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-shallow-repository'], { cwd: repoPath });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** Retrieves commit history and file lists for the history report. Bounded by default, unbounded when historyLimit is null. */
async function readHistory(repoPath: string, historyLimit: number | null): Promise<string> {
  const args = historyLimit === null
    ? ["log", "--pretty=format:%x1e%H%x00%an%x00%aI%x00%s%x00", "--name-only"]
    : ["log", `--max-count=${historyLimit}`, "--pretty=format:%x1e%H%x00%an%x00%aI%x00%s%x00", "--name-only"];
  const { stdout } = await execFileAsync("git", args, { cwd: repoPath });
  return stdout;
}

/** Searches commit history for the first exact occurrence-count change of a value in a file. */
async function findValueCommit(
  repoPath: string,
  relativePath: string,
  value: string,
  historyLimit: number | null
): Promise<CommitEvidence | null> {
  try {
    const args = [
      "log",
      "--follow",
      "--reverse",
      ...(historyLimit === null ? [] : [`--max-count=${historyLimit}`]),
      "--format=%H%x00%an%x00%aI%x00",
      `-S${value}`,
      "--",
      relativePath,
    ];
    const { stdout } = await execFileAsync("git", args, { cwd: repoPath });
    const [hash = "", author = "", date = ""] = stdout.trim().split("\x00");
    if (!hash) return null;
    return { hash, author, date };
  } catch {
    return null;
  }
}

/** Confirms whether the candidate commit added the value and returns its resulting line number. */
async function inspectCommitAddition(
  repoPath: string,
  hash: string,
  relativePath: string,
  value: string
): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["show", "--format=", "--no-renames", "--unified=0", hash, "--", relativePath],
      { cwd: repoPath }
    );
    let nextLine = 0;
    for (const line of stdout.split("\n")) {
      const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        nextLine = Number(hunk[1]);
        continue;
      }
      if (line.startsWith("+") && !line.startsWith("+++") && line.slice(1).includes(value)) {
        return nextLine;
      }
      if (!line.startsWith("-")) nextLine += 1;
    }
  } catch {
    return null;
  }
  return null;
}

/** Runs one cached pickaxe search and labels its evidence strength. */
async function attributeValue(
  repoPath: string,
  relativePath: string,
  value: string,
  historyLimit: number | null
): Promise<Attribution> {
  const evidence = await findValueCommit(repoPath, relativePath, value, historyLimit);
  if (!evidence) {
    return {
      hash: "",
      author: "",
      date: "",
      line: null,
      method: "none",
      confidence: "unavailable",
    };
  }

  const line = await inspectCommitAddition(repoPath, evidence.hash, relativePath, value);
  return {
    ...evidence,
    line,
    method: "git-search",
    confidence: line === null ? "approximate" : "confirmed",
  };
}

export const gitHistory = createTool({
  id: "git-history",
  description:
    "Gets git history (bounded by default) and optionally attributes deviations using cached git log -S evidence. Pass historyLimit for bounded scans or set unbounded:true for full history. It does not infer introductions from blame or the latest file modification.",
  inputSchema: z.object({
    repoName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
    historyLimit: z.number().int().positive().max(10000).default(100),
    unbounded: z.boolean().optional().default(false),
    deviations: z
      .array(
        z.object({
          relativePath: z.string(),
          valueUsed: z.string(),
          category: z.string().optional(),
        })
      )
      .optional(),
  }),
  outputSchema: z.object({
    repoName: z.string(),
    localPath: z.string(),
    workspace: z.string(),
    isShallow: z.boolean(),
    history: z.array(
      z.object({
        hash: z.string(),
        author: z.string(),
        date: z.string(),
        message: z.string(),
        files: z.array(z.string()),
      })
    ),
    attributions: z
      .array(
        z.object({
          relativePath: z.string(),
          valueUsed: z.string(),
          hash: z.string().nullable(),
          author: z.string().nullable(),
          date: z.string().nullable(),
          isArbitrary: z.boolean(),
          line: z.number().int().positive().nullable(),
          method: z.enum(["git-search", "none"]),
          confidence: z.enum(["confirmed", "approximate", "unavailable"]),
        })
      )
      .optional(),
    warnings: z.array(z.string()),
  }),
  execute: async ({ repoName, historyLimit, unbounded, deviations }) => {
    // Validate the repository before running any Git operation.
    const repoPath = resolveRepoPath(repoName);
    try {
      const s = await stat(repoPath);
      if (!s.isDirectory()) throw new Error();
    } catch {
      throw new Error(`Repository "${repoName}" not found at ${repoPath}`);
    }

    const warnings: string[] = [];
    const isShallow = await isShallowRepo(repoPath);
    if (isShallow) {
      warnings.push("Shallow clone — history limited to available commits. Run git fetch --unshallow for full history.");
    }

    // Resolve effective history limit: null means unbounded (no --max-count).
    const effectiveLimit = unbounded ? null : historyLimit;

    // Read the history report (bounded by default, unbounded when requested).
    let history: HistoryEntry[] = [];
    try {
      history = parseGitLog(await readHistory(repoPath, effectiveLimit));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Could not read git log: ${msg}`);
    }

    // Cache searches so repeated deviations do not repeat Git operations.
    let attributions: Array<{
      relativePath: string;
      valueUsed: string;
      hash: string | null;
      author: string | null;
      date: string | null;
      isArbitrary: boolean;
      line: number | null;
      method: "git-search" | "none";
      confidence: "confirmed" | "approximate" | "unavailable";
    }> | undefined;

    if (deviations?.length) {
      attributions = [];
      const cache = new Map<string, Attribution>();
      for (const deviation of deviations) {
        const key = `${deviation.relativePath}\x00${deviation.valueUsed}`;
        let attribution = cache.get(key);
        if (!attribution) {
          attribution = await attributeValue(repoPath, deviation.relativePath, deviation.valueUsed, effectiveLimit);
          cache.set(key, attribution);
        }
        attributions.push({
          relativePath: deviation.relativePath,
          valueUsed: deviation.valueUsed,
          hash: attribution.method === "none" ? null : attribution.hash,
          author: attribution.method === "none" ? null : attribution.author,
          date: attribution.method === "none" ? null : attribution.date,
          isArbitrary: isArbitraryValue(deviation.valueUsed),
          line: attribution.line,
          method: attribution.method,
          confidence: attribution.confidence,
        });
      }
    }

    return {
      repoName,
      localPath: repoPath,
      workspace: ARC_MAP_WORKSPACE,
      isShallow,
      history,
      attributions,
      warnings,
    };
  },
});
