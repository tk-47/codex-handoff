# codex-handoff

A structured handoff system that lets Claude Code architect a project and OpenAI Codex build it.

Claude Code designs. Codex codes. Claude Code verifies.

---

## The Problem

AI coding agents are great at following instructions but bad at architecture. Meanwhile, Claude Code excels at design, integration, and big-picture thinking but shouldn't spend time on routine implementation.

**codex-handoff** bridges the gap: Claude Code generates structured task files that Codex can execute without ambiguity.

## How It Works

```
┌─────────────┐   ┌──────────────┐   ┌──────────────┐   ┌───────────┐   ┌─────────────┐
│ Claude Code  │──▶│   prepare    │──▶│ codex-handoff │──▶│   Codex   │──▶│ Claude Code  │
│  (Architect) │   │ (Pre-flight) │   │  (Formatter)  │   │ (Builder) │   │  (Reviewer)  │
└─────────────┘   └──────────────┘   └──────────────┘   └───────────┘   └─────────────┘
   designs the       researches          generates          codes from      verifies with
   spec JSON         prior art,          AGENTS.md +        task files      verify command
                     risks, gaps         task files
```

If Codex gets stuck, `triage` diagnoses the failure and recommends next steps.

### What Gets Generated

| File | Purpose |
|------|---------|
| `.codex/prepare.md` | Pre-flight research: prior art, risks, open questions, suggested tasks |
| `AGENTS.md` | Codex instruction file (read before every task) |
| `.codex/tasks/NNN-slug.md` | Individual task files with explicit instructions |
| `.codex/plan.md` | Milestone overview with running Decision Log |
| `.codex/verification.md` | Review checklist for the verifying AI |
| `.codex/handoff-meta.json` | Metadata and task status tracking |
| `.codex/triage-*.md` | Triage reports when Codex gets stuck |
| Scaffold files | Boilerplate with `TODO(NNN)` markers linking to tasks |

## Requirements

- [Bun](https://bun.sh) runtime
- [GitHub CLI](https://cli.github.com) (`gh`) for creating issues
- `ANTHROPIC_API_KEY` in your environment for `prepare` and `triage` commands

## Usage

### 0. Pre-flight research (optional but recommended)

Before writing your spec, run `prepare` to have Claude scan the existing codebase and surface risks, prior art, open questions, and a suggested task breakdown.

```bash
bun run codex-handoff.ts prepare ./my-project "Build user authentication with JWT"

# Or pipe a longer description from stdin
cat description.txt | bun run codex-handoff.ts prepare ./my-project --stdin
```

Output is saved to `.codex/prepare.md`. Review it, answer the open questions, then write your spec JSON.

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

Creates one GitHub issue per task with a `codex` label. Tag `@codex` on each issue to start work.

### 3. Log decisions as you go

Append a dated decision to the `Decision Log` in `.codex/plan.md` at any point:

```bash
bun run codex-handoff.ts log ./my-project "Chose JWT over sessions — stateless, works across multiple services"
bun run codex-handoff.ts log ./my-project "Used RS256 signing so token verification doesn't require a shared secret"
```

### 4. Verify Codex's output

```bash
bun run codex-handoff.ts verify ./my-project
```

Checks for:
- Unresolved `TODO()` markers
- Placeholder values left in code
- Test pass/fail
- Build pass/fail
- Files changed outside task scope

### 5. Triage a stuck or failing handoff

If Codex's output fails verification or goes off the rails:

```bash
bun run codex-handoff.ts triage ./my-project
```

This runs `verify` internally, captures git status and recent commits, reads active task specs, and sends the full picture to Claude. Output includes:

- **Root cause** — what specifically went wrong
- **Immediate next steps** — ordered, with exact commands
- **Should the spec be revised?** — and what to change
- **Lessons to log** — bullet points to capture with `log`

Triage reports are saved to `.codex/triage-TIMESTAMP.md`.

### 6. Check task status

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

## Full Workflow Example

```
You:          "Build me a REST API for tracking inventory"

Claude Code:   Runs codex-handoff prepare — discovers existing auth middleware,
               flags a risk around unauthenticated endpoints, asks whether to
               reuse the existing store pattern

You:           Answers open questions, writes spec.json

Claude Code:   Runs codex-handoff generate
Claude Code:   Runs codex-handoff log "Reusing existing auth middleware from src/lib/auth.ts"
Claude Code:   Pushes to GitHub
Claude Code:   Runs codex-handoff issues --repo you/inventory-api

You:           Tags @codex on each issue

Codex:         Creates branches, writes code, opens PRs

Claude Code:   Runs codex-handoff verify — finds 2 unresolved TODOs
Claude Code:   Runs codex-handoff triage — root cause identified, next steps generated
Claude Code:   Fixes spec, re-hands off, or reviews PRs directly
```

## Design Principles

1. **Claude Code is the brain, the script is the hands.** The script does zero thinking. It takes a fully formed spec and formats it into files.

2. **Research before coding.** The `prepare` phase forces prior art discovery and risk identification before a single line of spec is written. Bad specs produce bad code; `prepare` catches the gaps upstream.

3. **Tasks are overly explicit.** Codex's weakness is ambiguity. Every task specifies exact files, exact steps, exact acceptance criteria. This is intentional.

4. **TODO(NNN) markers link scaffolds to tasks.** Codex can grep for `TODO(003)` to find all implementation points for task 003.

5. **AGENTS.md stays under 32 KiB.** Codex enforces this limit. Task details go in separate files, referenced from AGENTS.md.

6. **Verification is automated where possible.** grep + test/build commands handle 80% of review. The verifying AI handles the rest.

7. **Decisions are first-class.** The `log` command keeps a running record of *why* the architecture looks the way it does — invaluable when a triage report asks "should we revise the spec?"

## Acknowledgments

This project was inspired by [AI Project Handoff Format](https://github.com/yy4uic-ai/ai-handoff-format) by yy4uic-ai.

## License

MIT
