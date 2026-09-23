import { pathToFileURL } from "node:url";
import { Agent } from "@mastra/core/agent";
import { TaskSignalProvider } from "@mastra/core/signals";
import { askUserTool } from "@mastra/core/tools";
import {
  LocalFilesystem,
  LocalSandbox,
  WORKSPACE_TOOLS,
  Workspace,
} from "@mastra/core/workspace";
import { Memory } from "@mastra/memory";
import { startScheduleTool, stopScheduleTool } from "../tools/scheduleTools";
import { cloneRepo, cleanUpRepo, listRepos } from "../tools/repo";
import { scanProject, findFiles, readFile } from "../tools/project";
import { analyzeStyles, analyzeResponsive, analyzeDesignTokens, compareBaseline } from "../tools/styling";

const workspacePath = "workspace";

const workspace = new Workspace({
  id: "test-agent-workspace",
  name: "Test Agent Workspace",
  filesystem: new LocalFilesystem({
    basePath: workspacePath,
  }),
  sandbox: new LocalSandbox({
    workingDirectory: workspacePath,
  }),
  tools: {
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
      requireReadBeforeWrite: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
      requireApproval: true,
    },
  },
});

export const testAgent = new Agent({
  id: "test-agent",
  name: "Test Agent",
  description:
    "Temporary harness tester for repo/project/styling tools — verifies tool access and evidence flow, not the final drift severity agent.",
  metadata: {
    suggestedPrompts: [
      "Clone https://github.com/octocat/Hello-World and scan the project.",
      "Analyze the styling, responsive breakpoints, and design tokens in Hello-World.",
      "Find styling or architecture drift in my cloned repository and explain the evidence.",
    ],
  },
  instructions: `You are Test Agent — a temporary ArchMap harness tester. Your only job is to exercise repo, project, and styling tools and report tool output verbatim. You are NOT the final drift severity agent.

What you test:
- Clone -> scan -> styling fan-out (analyze-styles, analyze-responsive, analyze-design-tokens, compare-baseline). Optionally find-files and read-file to double-check.
- You do NOT reason about drift severity, blast radius — that belongs to the final agent. You echo evidence, including compare-baseline deviations.

How to test:
1. clone-repo (repoUrl: "https://github.com/org/repo") — gates everything. If it throws "Only GitHub" or "already cloned", surface it and stop.
2. scan-project (repoName: "repo") — shows filesByType, totalFiles. Must run before any styling tool.
3. Parallel: analyze-styles, analyze-responsive, analyze-design-tokens (all with repoName). Report stylingApproach, summary counts, declaredSources or inferredBaseline, declaredBreakpoints vs adHoc.
4. compare-baseline (repoName) — diffs actual usage against declared/inferred tokens. Report deviationCount, byCategory/bySeverity, and per-file deviations (relativePath, category, valueUsed, expectedValue, severity, source).
5. Optionally: find-files (repoName, pattern) and read-file (repoName, filePath) — filePath is ALWAYS repo-root relative (e.g. "client/src/features/dashboard/components/BannerCta.tsx"), never absolute /home/.../.workspace/... — tools guard with "escapes repository/workspace" — surface those errors verbatim.

Rules:
- Facts only from tools. Never invent file names, color values, breakpoints, or commits.
- For drift questions, use compare-baseline deviations as evidence — do not invent deviations.
- Report succinctly per tool: e.g. "scan: X files, types: {...}", "styles: tailwind, colors:12, hex: [#fff...]", "responsive: declared [sm,md...] from tailwind.config.js, adHoc: [...]", "tokens: hasDeclaredTokens false -> inferred dominantHex...", "baseline: deviations 3, byCategory {color:2}".
- For local file changes, end with a plain-text URL using ${pathToFileURL(`${workspacePath}/`).href}; avoid Markdown links, localhost, /workspace, relative paths, and static-file servers.
- When greeted with no task, invite: "Try: Clone https://github.com/octocat/Hello-World then scan-project Hello-World then analyze-styles/responsive/tokens and compare-baseline."
- Ask concise questions when repoName or pattern unclear. Never guess repoName — derive from clone.
`,

  model: "mistral/open-mistral-nemo",
  defaultOptions: {
    maxSteps: 100,
    autoResumeSuspendedTools: true,
  },
  memory: new Memory({
    options: {
      generateTitle: true,
      observationalMemory: {
        model: "mistral/open-mistral-nemo",
      },
    },
  }),
  workspace,
  tools: {
    start_schedule: startScheduleTool,
    stop_schedule: stopScheduleTool,
    clone_repo: cloneRepo,
    cleanup_repo: cleanUpRepo,
    list_repos: listRepos,
    scan_project: scanProject,
    find_files: findFiles,
    read_file: readFile,
    analyze_styles: analyzeStyles,
    analyze_responsive: analyzeResponsive,
    analyze_design_tokens: analyzeDesignTokens,
    compare_baseline: compareBaseline,
  },
  signals: [new TaskSignalProvider()],
});
