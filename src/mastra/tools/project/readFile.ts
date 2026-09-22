import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { readFile as fsReadFile, stat } from "node:fs/promises";
import { ARC_MAP_WORKSPACE } from "../../lib/constants";
import { assertInsideRepo, resolveRepoPath } from "../../lib/workspace";

const MAX_SIZE = 500 * 1024; // 500KB
const MAX_LINES = 2000;

export const readFile = createTool({
  id: "read-file",
  description:
    "Reads a file from a cloned repository with safety checks (path traversal, size cap, binary detection).",
  inputSchema: z.object({
    repoName: z.string().regex(/^[a-zA-Z0-9._-]+$/),
    filePath: z.string().min(1).max(500),
  }),
  outputSchema: z.object({
    repoName: z.string(),
    filePath: z.string(),
    relativePath: z.string(),
    absolutePath: z.string(),
    size: z.number(),
    truncated: z.boolean(),
    content: z.string(),
    workspace: z.string(),
  }),
  execute: async ({ repoName, filePath }) => {
    if (filePath.includes("\0")) {
      throw new Error("Invalid filePath");
    }

    const repoPath = resolveRepoPath(repoName);

    try {
      const s = await stat(repoPath);
      if (!s.isDirectory()) throw new Error();
    } catch {
      throw new Error(`Repository "${repoName}" not found at ${repoPath}`);
    }

    const absolutePath = assertInsideRepo(repoPath, filePath);

    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(absolutePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    if (!s.isFile()) {
      throw new Error(`Not a file: ${filePath}`);
    }

    if (s.size > 1024 * 1024) {
      throw new Error(`File too large (${s.size} bytes), max 1MB`);
    }

    let content: string;
    try {
      content = await fsReadFile(absolutePath, "utf-8");
    } catch {
      throw new Error(`Could not read file: ${filePath} (binary or unreadable)`);
    }

    // binary check: contains null byte
    if (content.includes("\0")) {
      throw new Error(`Refusing to return binary file: ${filePath}`);
    }

    let truncated = false;
    if (content.length > MAX_SIZE) {
      content = content.slice(0, MAX_SIZE);
      truncated = true;
    }

    const lines = content.split("\n");
    if (lines.length > MAX_LINES) {
      content = lines.slice(0, MAX_LINES).join("\n");
      truncated = true;
    }

    return {
      repoName,
      filePath,
      relativePath: filePath,
      absolutePath,
      size: s.size,
      truncated,
      content,
      workspace: ARC_MAP_WORKSPACE,
    };
  },
});
