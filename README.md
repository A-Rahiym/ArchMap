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
