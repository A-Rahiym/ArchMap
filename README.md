# ArchMap

Design-System & Architecture Drift Detector for frontend repositories.

> ArchMap watches a React/Next.js TypeScript codebase and tells you where it's drifted from its own established patterns — styling that slipped past the design system and architectural shortcuts that break the intended data flow — with evidence tied to specific files and commits.

ArchMap establishes what "normal" looks like in a codebase — architecturally and stylistically — then flags where reality has drifted from it, with evidence.

## What it does

- **Styling drift** — compares actual values in use (spacing, color, typography, radius, shadows, breakpoints) against declared tokens (`tailwind.config`, `tokens.json`, theme) or an inferred baseline of dominant values.
- **Architecture drift** — flags layer bypasses and import shortcuts and scores blast radius (how many pages/components depend on the affected file).
- **Evidence** — every deviation is tied to file/line and the commit that introduced it.

See `guide/guide,md` for the full spec.

## Tool groups

| Group | Tools | Purpose |
|---|---|---|
| `repo/` | `clone-repo`, `cleanup-repo`, `list-repos` | Clone into `.workspace` and manage lifecycle |
| `project/` | `scan-project`, `read-file`, `find-files` | File classification and targeted reads |
| `styling/` | `analyze-styles`, `analyze-responsive`, `analyze-design-tokens`, `compare-baseline` | Extract values in use and run the deviation engine |
| `architecture/` | `analyze-imports`, `analyze-components`, `analyze-routes`, `analyze-data-flow` | Supporting evidence — blast radius and coupling |
| `dependencies/` | `analyze-dependencies` | Internal vs external deps, drift signals |
| `history/` | `git-history` | Map each deviation to the commit that introduced it |

Current progress: `repo/` complete, remaining groups in progress.

## Styling tools

The styling tools analyze a cloned repository identified by `repoName` and use the repository's local files under `.workspace`.

- `analyze-styles` scans supported source and stylesheet files and reports actual color, spacing, typography, radius, shadow, and CSS value usage per file.
- `analyze-responsive` finds Tailwind breakpoint prefixes and CSS media queries, then reports ad-hoc responsive values.
- `analyze-design-tokens` discovers declared values from Tailwind configuration, token files, and theme files. When usable declared tokens are unavailable, it infers a baseline from dominant colors and spacing values.
- `compare-baseline` runs the three analyzers in parallel and compares observed usage against the declared-first, inferred-second baseline. It returns file-level deviations with expected values, source, frequency, severity, and summary counts.

The tools use bounded file scans and heuristic extraction rather than a full JavaScript, Tailwind, or CSS parser. Dynamic class expressions and unsupported configuration syntax may be missed, while arbitrary values are treated as stronger drift signals. Normal named Tailwind color classes are not compared directly to hex tokens unless the project's theme can be resolved.

## Get started

Set your `GOOGLE_GENERATIVE_AI_API_KEY` in `.env` (see `.env.example`), then:

```shell
pnpm install
pnpm run dev
```

Open http://localhost:4111 for Mastra Studio.

Verify the repo tools:

```shell
npx tsx test/clone_repo.ts https://github.com/octocat/Hello-World
npx tsx test/listRepos.ts
npx tsx test/clean_repo.ts Hello-World
```
