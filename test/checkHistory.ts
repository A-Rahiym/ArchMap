import { writeFile } from "node:fs/promises";
import { gitHistory } from "../src/mastra/tools/history/gitHistory";

const rawArgs = process.argv.slice(2);

// Parse flags: --unbounded, --limit=N, --out=path, --sort=asc|desc
let repo = "";
let historyLimit = 100;
let unbounded = false;
let outPath: string | null = null;
let sortOrder: "asc" | "desc" | null = null;
const positionals: string[] = [];

for (const arg of rawArgs) {
  if (arg === "--unbounded") {
    unbounded = true;
  } else if (arg.startsWith("--limit=")) {
    const v = Number(arg.split("=")[1]);
    if (!Number.isNaN(v) && v > 0) historyLimit = v;
  } else if (arg.startsWith("--out=")) {
    outPath = arg.split("=")[1];
  } else if (arg.startsWith("--sort=")) {
    const s = arg.split("=")[1];
    if (s === "asc" || s === "desc") sortOrder = s;
  } else if (arg.startsWith("--")) {
    console.error(`Unknown flag: ${arg}`);
    process.exit(1);
  } else {
    positionals.push(arg);
  }
}

// Positionals: repo [historyLimit] [relativePath] [valueUsed]
// If --limit not used, allow numeric positional as historyLimit for backwards compat
if (positionals.length > 0) repo = positionals[0];
if (positionals.length > 1 && !unbounded) {
  const maybeLimit = Number(positionals[1]);
  if (!Number.isNaN(maybeLimit) && maybeLimit > 0 && !positionals[1].includes("/")) {
    // treat as limit only if we have 2 pos and second is numeric and not a path
    const hasExtraPos = positionals.length > 2;
    // Heuristic: if 2 args total, second is limit; if 3-4 args, second is limit and rest are file/value
    if (positionals.length === 2) {
      historyLimit = maybeLimit;
    } else if (positionals.length >= 3) {
      // check if second looks like limit vs path: if valueUsed present, second is limit
      historyLimit = maybeLimit;
    }
  }
}

const relativePath = (() => {
  if (positionals.length === 2 && !Number.isNaN(Number(positionals[1])) && positionals[1].match(/^\d+$/)) return undefined;
  if (positionals.length === 3) return positionals[1].match(/^\d+$/) ? positionals[2] : positionals[1];
  if (positionals.length >= 4) return positionals[2];
  if (positionals.length === 2 && Number.isNaN(Number(positionals[1]))) return positionals[1];
  return undefined;
})();

const valueUsed = (() => {
  if (positionals.length === 4) return positionals[3];
  if (positionals.length === 3 && !positionals[1].match(/^\d+$/)) return positionals[2];
  return undefined;
})();

if (!repo) {
  console.error("Usage: npx tsx test/checkHistory.ts <repoName> [historyLimit] [relativePath] [valueUsed] [--unbounded] [--limit=N] [--out=path] [--sort=asc|desc]");
  console.error("  Bounded (default): npx tsx test/checkHistory.ts Hello-World 100");
  console.error("  Unbounded:         npx tsx test/checkHistory.ts Hello-World --unbounded");
  console.error("  To file:           npx tsx test/checkHistory.ts Hello-World --unbounded --out=/tmp/history.txt");
  process.exit(1);
}

console.log(`Running git-history for repo="${repo}" ${unbounded ? "(unbounded - full history)" : `limit=${historyLimit}`} ...`);

const Result = await gitHistory.execute({
  repoName: repo,
  historyLimit: unbounded ? 100 : historyLimit, // still required by schema, ignored when unbounded=true
  unbounded,
  deviations: relativePath && valueUsed ? [{ relativePath, valueUsed }] : undefined,
});

// Optionally sort history before printing
let historyToPrint = Result.history;
if (sortOrder) {
  historyToPrint = [...Result.history].sort((a, b) =>
    sortOrder === "asc" ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date)
  );
}

const jsonOut = JSON.stringify({ ...Result, history: historyToPrint }, null, 2);

// Full JSON to stdout (untruncated)
console.log(jsonOut);

// Human-readable summaries (also ensures everything prints line-by-line)
console.log(`\n--- Summary ---`);
console.log(`Repo: ${Result.repoName} | isShallow: ${Result.isShallow} | history: ${Result.history.length} commits ${unbounded ? "(unbounded)" : `(limit ${historyLimit})`} | warnings: ${Result.warnings.length}`);
for (const w of Result.warnings) console.log(`  warning: ${w}`);
console.log(`\n--- History (all ${historyToPrint.length} commits, untruncated) ---`);
for (const h of historyToPrint) {
  console.log(`  ${h.hash} | ${h.date} | ${h.author} | ${h.message} | files: [${h.files.join(", ")}]`);
}
if (Result.attributions) {
  console.log(`\n--- Attributions (${Result.attributions.length}) ---`);
  for (const a of Result.attributions) {
    console.log(`  ${a.relativePath} :: "${a.valueUsed}" -> hash=${a.hash ?? "null"} author=${a.author ?? "null"} date=${a.date ?? "null"} line=${a.line ?? "null"} method=${a.method} confidence=${a.confidence} isArbitrary=${a.isArbitrary}`);
  }
}

if (outPath) {
  await writeFile(outPath, jsonOut + "\n", "utf-8");
  console.log(`\nWrote full JSON to ${outPath}`);
  console.log(`Tip: also via shell redirect: npx tsx test/checkHistory.ts ${repo} ${unbounded ? "--unbounded" : historyLimit} > /tmp/history.txt`);
}
