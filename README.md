# codex-handoff

A structured handoff system that lets Claude Code architect a project and OpenAI Codex build it.

Claude Code designs. Codex codes. Claude Code verifies.

---

## The Problem

AI coding agents are great at following instructions but bad at architecture. Meanwhile, Claude Code excels at design, integration, and big-picture thinking but shouldn't spend time on routine implementation.

**codex-handoff** bridges the gap: Claude Code generates structured task files that Codex can execute without ambiguity.

## How It Works

```
┌─────────────┐     ┌──────────────┐     ┌───────────┐     ┌─────────────┐
│ Claude Code  │────▶│ codex-handoff │────▶│   Codex    │────▶│ Claude Code  │
│  (Architect) │     │  (Formatter)  │     │ (Builder)  │     │  (Reviewer)  │
└─────────────┘     └──────────────┘     └───────────┘     └─────────────┘
   designs              generates           codes             verifies
   the spec             AGENTS.md +         from task         output with
                        task files          files             verify command
```

### What Gets Generated

| File | Purpose |
|------|---------|
| `AGENTS.md` | Codex instruction file (read before every task) |
| `.codex/tasks/NNN-slug.md` | Individual task files with explicit instructions |
| `.codex/plan.md` | PLANS.md-format milestone overview |
| `.codex/verification.md` | Review checklist for the verifying AI |
| `.codex/handoff-meta.json` | Metadata and task status tracking |
| Scaffold files | Boilerplate with `TODO(NNN)` markers linking to tasks |

## Requirements

- [Bun](https://bun.sh) runtime
- [GitHub CLI](https://cli.github.com) (`gh`) for creating issues

## Usage

### 1. Generate handoff files from a spec

```bash
# From a spec file
bun run codex-handoff.ts generate ./my-project --spec spec.json

# From stdin (Claude Code pipes the spec)
cat spec.json | bun run codex-handoff.ts generate ./my-project --stdin
```

### 2. Create GitHub issues for Codex

```bash
bun run codex-handoff.ts issues ./my-project --repo owner/repo-name
```

This creates one GitHub issue per task with a `codex` label. Tag `@codex` on each issue to start work.

### 3. Verify Codex's output

```bash
bun run codex-handoff.ts verify ./my-project
```

Checks for:
- Unresolved `TODO()` markers
- Placeholder values left in code
- Test pass/fail
- Build pass/fail
- Files changed outside task scope

### 4. Check task status

```bash
bun run codex-handoff.ts status ./my-project
```

## Spec Format

The input is a JSON object describing the full project. Claude Code generates this during the design phase.

```json
{
  "project": {
    "name": "my-api",
    "description": "A REST API for managing widgets.",
    "repo": "owner/my-api",
    "language": "TypeScript",
    "runtime": "bun",
    "packageManager": "bun"
  },
  "conventions": {
    "codeStyle": ["Use camelCase", "No default exports"],
    "testing": "bun test",
    "linting": "bunx biome check",
    "buildCommand": "bun run build",
    "testCommand": "bun test"
  },
  "structure": {
    "directories": ["src", "src/routes", "src/lib", "tests"],
    "entryPoint": "src/index.ts"
  },
  "constraints": [
    "Do not use Express — use Bun.serve() directly",
    "All responses must be JSON"
  ],
  "tasks": [
    {
      "id": "001",
      "title": "Project Setup",
      "description": "Initialize the project with package.json and entry point...",
      "files": ["package.json", "tsconfig.json", "src/index.ts"],
      "acceptance": [
        "`bun install` completes without errors",
        "`bun run src/index.ts` starts server on port 3000"
      ],
      "hints": ["Use type: module in package.json"],
      "dependencies": [],
      "testCommand": "bun test"
    }
  ],
  "scaffoldFiles": [
    {
      "path": "src/lib/store.ts",
      "content": "// TODO(002): Implement the data store\nexport interface Item {}\n",
      "purpose": "In-memory data store"
    }
  ],
  "reviewChecklist": [
    "All routes return proper Content-Type headers",
    "Input validation rejects malformed requests"
  ]
}
```

### Spec Fields

| Field | Required | Description |
|-------|----------|-------------|
| `project.name` | Yes | Project name |
| `project.description` | Yes | One-paragraph description |
| `project.repo` | No | GitHub `owner/name` |
| `project.language` | Yes | Primary language |
| `project.runtime` | Yes | Runtime (bun, node, python3) |
| `project.packageManager` | Yes | Package manager |
| `conventions.codeStyle` | Yes | Array of style rules |
| `conventions.testCommand` | Yes | How to run tests |
| `conventions.buildCommand` | No | How to build |
| `conventions.linting` | No | Lint command |
| `structure.directories` | Yes | Folder structure |
| `structure.entryPoint` | Yes | Main file |
| `constraints` | No | Things Codex must NOT do |
| `tasks` | Yes | Ordered task list (see below) |
| `scaffoldFiles` | No | Pre-written boilerplate with TODOs |
| `reviewChecklist` | No | Extra items for verification |

### Task Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Task ID (e.g., "001") |
| `title` | Yes | Short title |
| `description` | Yes | Detailed, explicit prose |
| `files` | Yes | Exact files to create/modify |
| `acceptance` | Yes | Verifiable criteria |
| `dependencies` | No | Task IDs this depends on |
| `hints` | No | Implementation guidance |
| `testCommand` | No | Task-specific test command |

## Design Principles

1. **Claude Code is the brain, the script is the hands.** The script does zero thinking. It takes a fully formed spec and formats it into files.

2. **Tasks are overly explicit.** Codex's weakness is ambiguity. Every task specifies exact files, exact steps, exact acceptance criteria. This is intentional.

3. **TODO(NNN) markers link scaffolds to tasks.** Codex can grep for `TODO(003)` to find all implementation points for task 003.

4. **AGENTS.md stays under 32 KiB.** Codex enforces this limit. Task details go in separate files, referenced from AGENTS.md.

5. **Verification is automated where possible.** grep + test/build commands handle 80% of review. The verifying AI handles the rest by reading the actual code.

## Workflow Example

```
You:          "Build me a REST API for tracking inventory"
Claude Code:   Designs architecture, builds spec JSON
Claude Code:   Runs codex-handoff generate
Claude Code:   Pushes to GitHub
Claude Code:   Runs codex-handoff issues --repo you/inventory-api
You:           Tags @codex on each issue
Codex:         Creates branches, writes code, opens PRs
Claude Code:   Runs codex-handoff verify
Claude Code:   Reviews PRs, fixes issues or creates follow-up tasks
```

## License

MIT
