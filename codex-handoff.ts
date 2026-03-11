#!/usr/bin/env bun
/**
 * codex-handoff — Generate structured handoff documents for OpenAI Codex.
 *
 * Claude Code architects the project and builds a spec JSON.
 * This script formats that spec into files Codex can consume:
 *   - AGENTS.md (Codex instruction file)
 *   - .codex/tasks/NNN-slug.md (individual task files)
 *   - .codex/plan.md (PLANS.md-format overview)
 *   - .codex/verification.md (Claude Code review checklist)
 *   - .codex/handoff-meta.json (metadata + status tracking)
 *   - Scaffold files with TODO markers
 *
 * Usage:
 *   bun run ~/.claude/scripts/codex-handoff.ts generate <target-dir> --spec <file.json>
 *   bun run ~/.claude/scripts/codex-handoff.ts generate <target-dir> --stdin
 *   bun run ~/.claude/scripts/codex-handoff.ts verify <target-dir>
 *   bun run ~/.claude/scripts/codex-handoff.ts status <target-dir>
 *   bun run ~/.claude/scripts/codex-handoff.ts issues <target-dir> --repo <owner/name>
 */

import { execSync, spawnSync } from "child_process";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  readdirSync,
} from "fs";
import { join, resolve, basename } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HandoffSpec {
  project: {
    name: string;
    description: string;
    repo?: string;
    language: string;
    runtime: string;
    packageManager: string;
  };
  conventions: {
    codeStyle: string[];
    testing: string;
    linting?: string;
    buildCommand?: string;
    testCommand: string;
  };
  structure: {
    directories: string[];
    entryPoint: string;
    configFiles?: string[];
  };
  tasks: HandoffTask[];
  scaffoldFiles?: ScaffoldFile[];
  reviewChecklist?: string[];
  constraints?: string[];
}

interface HandoffTask {
  id: string;
  title: string;
  description: string;
  files: string[];
  dependencies?: string[];
  acceptance: string[];
  hints?: string[];
  testCommand?: string;
}

interface ScaffoldFile {
  path: string;
  content: string;
  purpose: string;
}

interface HandoffMeta {
  version: string;
  createdAt: string;
  project: string;
  totalTasks: number;
  taskStatus: Record<string, "pending" | "in_progress" | "done" | "failed">;
  repo?: string;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const [, , command, targetArg, ...flags] = process.argv;

if (!command || !targetArg) {
  console.log(`Usage:
  codex-handoff prepare <dir> "<description>" | --stdin   Pre-flight research before writing spec
  codex-handoff generate <dir> --spec <file> | --stdin    Generate handoff from spec JSON
  codex-handoff log <dir> "<decision text>"               Append decision to plan.md
  codex-handoff triage <dir>                              Diagnose a stuck/failing handoff
  codex-handoff verify <dir>                              Verify Codex output
  codex-handoff status <dir>                              Show task status
  codex-handoff issues <dir> --repo <owner/name>          Create GitHub issues`);
  process.exit(1);
}

const targetDir = resolve(targetArg);

switch (command) {
  case "prepare":
    await runPrepare();
    break;
  case "generate":
    await runGenerate();
    break;
  case "log":
    runLog();
    break;
  case "triage":
    await runTriage();
    break;
  case "verify":
    runVerify();
    break;
  case "status":
    runStatus();
    break;
  case "issues":
    runCreateIssues();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Claude API helper
// ---------------------------------------------------------------------------

async function callClaude(userPrompt: string, systemPrompt?: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — cannot run AI analysis");
    process.exit(1);
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt ?? "You are a software architect preparing structured handoff documents for AI coding agents.",
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    console.error("Claude API error:", await response.text());
    process.exit(1);
  }

  const data = await response.json() as { content: { text: string }[] };
  return data.content[0].text;
}

// ---------------------------------------------------------------------------
// Prepare (pre-flight research phase)
// ---------------------------------------------------------------------------

async function runPrepare() {
  const stdinFlag = flags.includes("--stdin");
  let description: string;

  if (stdinFlag) {
    const chunks: Buffer[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(Buffer.from(chunk));
    }
    description = Buffer.concat(chunks).toString("utf-8").trim();
  } else if (flags.length > 0 && !flags[0].startsWith("--")) {
    description = flags.join(" ").trim();
  } else {
    console.error('Usage: codex-handoff prepare <dir> "<description of what to build>" | --stdin');
    process.exit(1);
  }

  console.log("Scanning project...");
  const existingFiles = scanProjectFiles(targetDir);

  const prompt = [
    `## Task Description`,
    "",
    description,
    "",
    existingFiles.length > 0
      ? `## Existing Codebase (${existingFiles.length} files scanned)\n\n` +
        existingFiles.map(f => `### ${f.path}\n\`\`\`\n${f.snippet}\n\`\`\``).join("\n\n")
      : "## Existing Codebase\n\n(Empty — this is a new project)",
    "",
    "## Your Job",
    "",
    "Produce a structured pre-flight report with these sections:",
    "",
    "### 1. Prior Art",
    "What existing code is relevant? What can be reused? What might conflict?",
    "",
    "### 2. Risks & Gotchas",
    "Most likely failure modes, edge cases, and security considerations.",
    "",
    "### 3. Open Questions",
    "Decisions the architect must make before writing the spec. Be specific.",
    "",
    "### 4. Suggested Task Breakdown",
    "Draft 3–7 tasks (id, title, dependencies) suitable for a codex-handoff spec.",
    "",
    "### 5. Recommended Constraints",
    "What constraints belong in the spec? (files not to touch, patterns to follow, etc.)",
    "",
    "Be direct and specific. This will be read by a human before they write the spec JSON.",
  ].join("\n");

  console.log("Running pre-flight analysis...\n");
  const analysis = await callClaude(prompt);

  mkdirSync(join(targetDir, ".codex"), { recursive: true });
  const content = [
    `# Pre-flight: ${description.slice(0, 80)}`,
    "",
    `_Generated: ${new Date().toISOString()}_`,
    "",
    analysis,
  ].join("\n") + "\n";

  writeFileSync(join(targetDir, ".codex", "prepare.md"), content);
  console.log(analysis);
  console.log(`\n✓ Pre-flight saved to .codex/prepare.md`);
  console.log(`\nReview the analysis, answer the open questions, then run:`);
  console.log(`  codex-handoff generate <dir> --spec <your-spec.json>`);
}

function scanProjectFiles(dir: string): { path: string; snippet: string }[] {
  const result = spawnSync("find", [
    dir,
    "-type", "f",
    "-not", "-path", "*/node_modules/*",
    "-not", "-path", "*/.git/*",
    "-not", "-path", "*/.codex/*",
    "-not", "-path", "*/dist/*",
    "-not", "-path", "*/build/*",
    "(", "-name", "*.ts", "-o", "-name", "*.tsx", "-o", "-name", "*.js",
    "-o", "-name", "*.py", "-o", "-name", "*.go", "-o", "-name", "*.rs",
    "-o", "-name", "*.md", "-o", "-name", "package.json", "-o", "-name", "*.toml", ")",
    "-size", "-100k",
  ], { encoding: "utf-8", cwd: dir });

  const files = (result.stdout || "").trim().split("\n").filter(Boolean).slice(0, 30);

  return files.map(f => {
    try {
      const lines = readFileSync(f, "utf-8").split("\n");
      return { path: f.replace(dir + "/", ""), snippet: lines.slice(0, 40).join("\n") };
    } catch {
      return { path: f.replace(dir + "/", ""), snippet: "(unreadable)" };
    }
  });
}

// ---------------------------------------------------------------------------
// Log Decision
// ---------------------------------------------------------------------------

function runLog() {
  const decisionText = flags.filter(f => !f.startsWith("--")).join(" ").trim();
  if (!decisionText) {
    console.error('Usage: codex-handoff log <dir> "<decision text>"');
    process.exit(1);
  }

  mkdirSync(join(targetDir, ".codex"), { recursive: true });
  const planPath = join(targetDir, ".codex", "plan.md");

  if (!existsSync(planPath)) {
    writeFileSync(planPath, "# Plan\n\n## Decision Log\n\n_No decisions yet._\n");
  }

  const timestamp = new Date().toISOString().split("T")[0];
  const entry = `- **${timestamp}**: ${decisionText}`;
  let content = readFileSync(planPath, "utf-8");

  if (content.includes("_No decisions yet._")) {
    content = content.replace("_No decisions yet._", entry);
  } else {
    // Append after last entry in Decision Log section
    const sectionIdx = content.indexOf("## Decision Log");
    if (sectionIdx === -1) {
      content = content.trimEnd() + "\n\n## Decision Log\n\n" + entry + "\n";
    } else {
      const nextSection = content.indexOf("\n## ", sectionIdx + 1);
      if (nextSection === -1) {
        content = content.trimEnd() + "\n" + entry + "\n";
      } else {
        content = content.slice(0, nextSection) + entry + "\n" + content.slice(nextSection);
      }
    }
  }

  writeFileSync(planPath, content);
  console.log(`✓ Logged: ${entry}`);
}

// ---------------------------------------------------------------------------
// Triage (blocked protocol)
// ---------------------------------------------------------------------------

async function runTriage() {
  const codexDir = join(targetDir, ".codex");
  if (!existsSync(codexDir)) {
    console.error("No .codex directory found — run generate first");
    process.exit(1);
  }

  console.log("Gathering project state...");

  const meta: HandoffMeta = JSON.parse(
    readFileSync(join(codexDir, "handoff-meta.json"), "utf-8")
  );

  // Run verify and capture output
  const verifyResult = spawnSync(process.execPath, [process.argv[1], "verify", targetDir], {
    encoding: "utf-8",
    timeout: 120000,
  });
  const verifyOutput = (verifyResult.stdout + (verifyResult.stderr || "")).trim();

  const gitStatus = spawnSync("git", ["status", "--short"], { encoding: "utf-8", cwd: targetDir });
  const gitLog = spawnSync("git", ["log", "--oneline", "-10"], { encoding: "utf-8", cwd: targetDir });

  // Read task files for failed/in_progress tasks
  const activeTasks: string[] = [];
  for (const [id, status] of Object.entries(meta.taskStatus)) {
    if (status === "failed" || status === "in_progress") {
      const taskFiles = readdirSync(join(codexDir, "tasks")).filter(f => f.startsWith(id));
      for (const tf of taskFiles) {
        activeTasks.push(readFileSync(join(codexDir, "tasks", tf), "utf-8"));
      }
    }
  }

  const prepareMd = existsSync(join(codexDir, "prepare.md"))
    ? readFileSync(join(codexDir, "prepare.md"), "utf-8")
    : null;

  const prompt = [
    `## Project: ${meta.project}`,
    "",
    "## Task Status",
    "```json",
    JSON.stringify(meta.taskStatus, null, 2),
    "```",
    "",
    "## Verification Output",
    "```",
    verifyOutput.slice(0, 3000),
    "```",
    "",
    "## Git Status",
    "```",
    (gitStatus.stdout || "").trim() || "(clean)",
    "```",
    "",
    "## Recent Commits",
    "```",
    (gitLog.stdout || "").trim() || "(none)",
    "```",
    ...(activeTasks.length
      ? ["", "## Active/Failed Task Specs",
         ...activeTasks.flatMap(t => ["```markdown", t.slice(0, 2000), "```"])]
      : []),
    ...(prepareMd
      ? ["", "## Pre-flight Analysis", prepareMd.slice(0, 2000)]
      : []),
    "",
    "## Your Job",
    "",
    "Produce a triage report with these sections:",
    "",
    "### Root Cause",
    "What specifically went wrong? Be precise.",
    "",
    "### Immediate Next Steps",
    "Ordered list of concrete actions to unblock. Include exact commands.",
    "",
    "### Should the Spec Be Revised?",
    "If yes, what specifically needs to change before re-generating?",
    "",
    "### Lessons for the Decision Log",
    "1–2 bullet points to log with `codex-handoff log` to prevent this next time.",
  ].join("\n");

  console.log("Analyzing with Claude...\n");
  const analysis = await callClaude(
    prompt,
    "You are a senior engineer diagnosing why an AI coding agent got stuck and recommending concrete next steps."
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const triagePath = join(codexDir, `triage-${timestamp}.md`);
  writeFileSync(triagePath, [
    `# Triage: ${meta.project}`,
    "",
    `_Generated: ${new Date().toISOString()}_`,
    "",
    "## Verify Output",
    "```",
    verifyOutput,
    "```",
    "",
    "## Git Status",
    "```",
    (gitStatus.stdout || "").trim() || "(clean)",
    "```",
    "",
    "## Analysis",
    "",
    analysis,
  ].join("\n") + "\n");

  console.log(analysis);
  console.log(`\n✓ Triage saved to ${triagePath}`);
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

async function runGenerate() {
  const spec = await loadSpec();
  validateSpec(spec);

  // Ensure directories exist
  mkdirSync(join(targetDir, ".codex", "tasks"), { recursive: true });
  for (const dir of spec.structure.directories) {
    mkdirSync(join(targetDir, dir), { recursive: true });
  }

  // Generate all output files
  writeAgentsMd(spec);
  writePlan(spec);
  writeTaskFiles(spec);
  writeVerification(spec);
  writeMetadata(spec);
  writeScaffolds(spec);

  console.log(`\n✓ Handoff generated in ${targetDir}`);
  console.log(`  AGENTS.md — Codex instructions`);
  console.log(`  .codex/plan.md — Task overview`);
  console.log(`  .codex/tasks/ — ${spec.tasks.length} task files`);
  console.log(`  .codex/verification.md — Review checklist`);
  console.log(`  .codex/handoff-meta.json — Metadata`);
  if (spec.scaffoldFiles?.length) {
    console.log(`  ${spec.scaffoldFiles.length} scaffold files written`);
  }
  console.log(
    `\nNext: push to GitHub, then create issues with 'codex-handoff issues <dir> --repo <owner/name>'`
  );
}

async function loadSpec(): Promise<HandoffSpec> {
  const specFlagIdx = flags.indexOf("--spec");
  const stdinFlag = flags.includes("--stdin");

  if (specFlagIdx !== -1 && flags[specFlagIdx + 1]) {
    const specPath = resolve(flags[specFlagIdx + 1]);
    return JSON.parse(readFileSync(specPath, "utf-8"));
  }

  if (stdinFlag) {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  }

  console.error("Provide --spec <file> or --stdin");
  process.exit(1);
}

function validateSpec(spec: HandoffSpec) {
  const required = ["project", "conventions", "structure", "tasks"];
  for (const key of required) {
    if (!(key in spec)) {
      console.error(`Missing required field: ${key}`);
      process.exit(1);
    }
  }
  if (!spec.tasks.length) {
    console.error("Spec must have at least one task");
    process.exit(1);
  }
  for (const task of spec.tasks) {
    if (!task.id || !task.title || !task.description || !task.files?.length || !task.acceptance?.length) {
      console.error(`Task ${task.id || "(no id)"} missing required fields (id, title, description, files, acceptance)`);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// AGENTS.md
// ---------------------------------------------------------------------------

function writeAgentsMd(spec: HandoffSpec) {
  const s = spec;
  const lines: string[] = [
    `# ${s.project.name}`,
    "",
    s.project.description,
    "",
    "## Setup",
    "",
    `- **Language**: ${s.project.language}`,
    `- **Runtime**: ${s.project.runtime}`,
    `- **Package manager**: ${s.project.packageManager}`,
    `- **Test command**: \`${s.conventions.testCommand}\``,
  ];

  if (s.conventions.buildCommand) {
    lines.push(`- **Build command**: \`${s.conventions.buildCommand}\``);
  }
  if (s.conventions.linting) {
    lines.push(`- **Linting**: \`${s.conventions.linting}\``);
  }

  lines.push("", "## Code Conventions", "");
  for (const rule of s.conventions.codeStyle) {
    lines.push(`- ${rule}`);
  }

  lines.push("", "## Architecture", "", "```");
  lines.push(`${s.project.name}/`);
  for (const dir of s.structure.directories) {
    const parts = dir.split("/").filter(Boolean);
    const depth = parts.length;
    const indent = "  ".repeat(depth);
    const leaf = parts[parts.length - 1];
    lines.push(`${indent}${leaf}/`);
  }
  lines.push("```", "");
  lines.push(`**Entry point**: \`${s.structure.entryPoint}\``);

  if (s.constraints?.length) {
    lines.push("", "## Constraints", "");
    for (const c of s.constraints) {
      lines.push(`- ${c}`);
    }
  }

  lines.push(
    "",
    "## Task Execution Rules",
    "",
    "- Work on ONE task at a time, in order",
    "- Each task is in `.codex/tasks/NNN-slug.md` — read it fully before starting",
    `- Create a branch named \`codex/<task-id>-<slug>\` for each task`,
    `- After completing each task, run: \`${s.conventions.testCommand}\``,
    "- Do NOT modify files outside the task's listed files unless strictly necessary",
    '- Commit with message format: `codex: <task-title>`',
    "- All TODO(NNN) markers in scaffold files correspond to task NNN — implement them",
    "- Do NOT leave any TODO markers unresolved when completing a task",
    "",
    "## Review Guidelines",
    "",
    "- Flag any TODO markers left unimplemented",
    "- Check that all acceptance criteria from the task file are met",
    "- Verify no hardcoded secrets or placeholder values remain",
    `- Ensure tests pass: \`${s.conventions.testCommand}\``,
  );

  if (s.conventions.buildCommand) {
    lines.push(`- Ensure build succeeds: \`${s.conventions.buildCommand}\``);
  }

  const content = lines.join("\n") + "\n";

  // Warn if over 32 KiB (Codex limit)
  if (Buffer.byteLength(content) > 32768) {
    console.warn(
      `⚠ AGENTS.md is ${Buffer.byteLength(content)} bytes — Codex limit is 32 KiB. Consider trimming.`
    );
  }

  writeFileSync(join(targetDir, "AGENTS.md"), content);
}

// ---------------------------------------------------------------------------
// Plan (PLANS.md format)
// ---------------------------------------------------------------------------

function writePlan(spec: HandoffSpec) {
  const lines: string[] = [
    `# Plan: ${spec.project.name}`,
    "",
    spec.project.description,
    "",
    "## Milestones",
    "",
  ];

  for (const task of spec.tasks) {
    const deps =
      task.dependencies?.length
        ? ` (depends on: ${task.dependencies.join(", ")})`
        : "";
    lines.push(`### ${task.id}: ${task.title}${deps}`);
    lines.push("");
    for (const ac of task.acceptance) {
      lines.push(`- [ ] ${ac}`);
    }
    lines.push("");
  }

  lines.push("## Decision Log", "", "_No decisions yet._", "");
  writeFileSync(join(targetDir, ".codex", "plan.md"), lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Task Files
// ---------------------------------------------------------------------------

function writeTaskFiles(spec: HandoffSpec) {
  for (const task of spec.tasks) {
    const slug = task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);
    const filename = `${task.id}-${slug}.md`;

    const lines: string[] = [
      `# Task ${task.id}: ${task.title}`,
      "",
    ];

    if (task.dependencies?.length) {
      lines.push("## Depends On", "");
      for (const dep of task.dependencies) {
        lines.push(`- Task ${dep}`);
      }
      lines.push("");
    } else {
      lines.push("## Depends On", "", "None (can start immediately)", "");
    }

    lines.push("## Files to Create/Modify", "");
    for (const f of task.files) {
      lines.push(`- \`${f}\``);
    }

    lines.push("", "## Description", "", task.description, "");

    if (task.hints?.length) {
      lines.push("## Implementation Hints", "");
      for (const hint of task.hints) {
        lines.push(`- ${hint}`);
      }
      lines.push("");
    }

    lines.push("## Acceptance Criteria", "");
    for (const ac of task.acceptance) {
      lines.push(`- [ ] ${ac}`);
    }

    if (task.testCommand) {
      lines.push("", "## Verification", "");
      lines.push(`Run: \`${task.testCommand}\``);
    }

    lines.push("");
    writeFileSync(join(targetDir, ".codex", "tasks", filename), lines.join("\n"));
  }
}

// ---------------------------------------------------------------------------
// Verification Checklist
// ---------------------------------------------------------------------------

function writeVerification(spec: HandoffSpec) {
  const lines: string[] = [
    "# Verification Checklist",
    "",
    "Use this to review Codex's output. Run `codex-handoff verify` to automate the global checks.",
    "",
    "## Global Checks",
    "",
    '- [ ] No unresolved TODOs: `grep -r "TODO(" src/`',
    '- [ ] No placeholder values: `grep -ri "your.*here\\|placeholder\\|CHANGEME\\|xxx" src/`',
    `- [ ] Tests pass: \`${spec.conventions.testCommand}\``,
  ];

  if (spec.conventions.buildCommand) {
    lines.push(
      `- [ ] Build succeeds: \`${spec.conventions.buildCommand}\``
    );
  }
  if (spec.conventions.linting) {
    lines.push(`- [ ] Lint passes: \`${spec.conventions.linting}\``);
  }

  if (spec.reviewChecklist?.length) {
    lines.push("", "## Project-Specific Checks", "");
    for (const item of spec.reviewChecklist) {
      lines.push(`- [ ] ${item}`);
    }
  }

  lines.push("", "## Per-Task Verification", "");
  for (const task of spec.tasks) {
    lines.push(`### Task ${task.id}: ${task.title}`, "");
    for (const ac of task.acceptance) {
      lines.push(`- [ ] ${ac}`);
    }
    lines.push("");
  }

  writeFileSync(
    join(targetDir, ".codex", "verification.md"),
    lines.join("\n")
  );
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function writeMetadata(spec: HandoffSpec) {
  const meta: HandoffMeta = {
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    project: spec.project.name,
    totalTasks: spec.tasks.length,
    taskStatus: Object.fromEntries(
      spec.tasks.map((t) => [t.id, "pending" as const])
    ),
    repo: spec.project.repo,
  };
  writeFileSync(
    join(targetDir, ".codex", "handoff-meta.json"),
    JSON.stringify(meta, null, 2) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Scaffold Files
// ---------------------------------------------------------------------------

function writeScaffolds(spec: HandoffSpec) {
  if (!spec.scaffoldFiles?.length) return;

  for (const sf of spec.scaffoldFiles) {
    const fullPath = join(targetDir, sf.path);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    const header = `// ${sf.purpose}\n// Generated by codex-handoff — implement TODOs per the referenced task\n\n`;
    writeFileSync(fullPath, header + sf.content);
  }
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

function runVerify() {
  const codexDir = join(targetDir, ".codex");
  if (!existsSync(codexDir)) {
    console.error("No .codex directory found — run generate first");
    process.exit(1);
  }

  const meta: HandoffMeta = JSON.parse(
    readFileSync(join(codexDir, "handoff-meta.json"), "utf-8")
  );

  console.log(`\n=== Verification: ${meta.project} ===\n`);

  // Check for unresolved TODOs
  const todoResult = spawnSync("grep", ["-rn", "TODO(", targetDir, "--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.jsx", "--include=*.py"], {
    encoding: "utf-8",
    cwd: targetDir,
  });
  const todos = (todoResult.stdout || "").trim();
  if (todos) {
    console.log(`✗ Unresolved TODOs found:`);
    for (const line of todos.split("\n").slice(0, 20)) {
      console.log(`  ${line}`);
    }
    if (todos.split("\n").length > 20) {
      console.log(`  ... and ${todos.split("\n").length - 20} more`);
    }
  } else {
    console.log(`✓ No unresolved TODO markers`);
  }

  // Check for placeholder values
  const placeholderResult = spawnSync("grep", ["-rni", "your.*here\\|placeholder\\|CHANGEME\\|xxxxx", targetDir, "--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.py", "--exclude-dir=node_modules", "--exclude-dir=.codex"], {
    encoding: "utf-8",
    cwd: targetDir,
  });
  const placeholders = (placeholderResult.stdout || "").trim();
  if (placeholders) {
    console.log(`\n✗ Placeholder values found:`);
    for (const line of placeholders.split("\n").slice(0, 10)) {
      console.log(`  ${line}`);
    }
  } else {
    console.log(`✓ No placeholder values detected`);
  }

  // Run test command if we can find it
  const verificationMd = readFileSync(join(codexDir, "verification.md"), "utf-8");
  const testMatch = verificationMd.match(/Tests pass: `([^`]+)`/);
  if (testMatch) {
    const testCmd = testMatch[1];
    console.log(`\nRunning tests: ${testCmd}`);
    const testResult = spawnSync("sh", ["-c", testCmd], {
      encoding: "utf-8",
      cwd: targetDir,
      timeout: 60000,
    });
    if (testResult.status === 0) {
      console.log(`✓ Tests passed`);
    } else {
      console.log(`✗ Tests failed (exit code ${testResult.status})`);
      if (testResult.stderr) {
        console.log(testResult.stderr.slice(0, 500));
      }
    }
  }

  // Run build command
  const buildMatch = verificationMd.match(/Build succeeds: `([^`]+)`/);
  if (buildMatch) {
    const buildCmd = buildMatch[1];
    console.log(`\nRunning build: ${buildCmd}`);
    const buildResult = spawnSync("sh", ["-c", buildCmd], {
      encoding: "utf-8",
      cwd: targetDir,
      timeout: 60000,
    });
    if (buildResult.status === 0) {
      console.log(`✓ Build succeeded`);
    } else {
      console.log(`✗ Build failed (exit code ${buildResult.status})`);
      if (buildResult.stderr) {
        console.log(buildResult.stderr.slice(0, 500));
      }
    }
  }

  // Check git diff for unexpected file changes
  const gitResult = spawnSync("git", ["diff", "--name-only", "HEAD"], {
    encoding: "utf-8",
    cwd: targetDir,
  });
  if (gitResult.status === 0 && gitResult.stdout.trim()) {
    const changedFiles = gitResult.stdout.trim().split("\n");
    // Load all expected files from tasks
    const taskFiles = new Set<string>();
    for (const taskId of Object.keys(meta.taskStatus)) {
      const taskDir = join(codexDir, "tasks");
      const taskFilesList = readdirSync(taskDir).filter((f) =>
        f.startsWith(taskId)
      );
      for (const tf of taskFilesList) {
        const content = readFileSync(join(taskDir, tf), "utf-8");
        const fileMatches = content.matchAll(/- `([^`]+)`/g);
        for (const m of fileMatches) {
          taskFiles.add(m[1]);
        }
      }
    }

    const unexpected = changedFiles.filter(
      (f) => !taskFiles.has(f) && !f.startsWith(".codex/") && f !== "AGENTS.md"
    );
    if (unexpected.length) {
      console.log(`\n⚠ Files changed outside task scope:`);
      for (const f of unexpected) {
        console.log(`  ${f}`);
      }
    }
  }

  // Task status summary
  console.log(`\n--- Task Status ---`);
  for (const [id, status] of Object.entries(meta.taskStatus)) {
    const icon =
      status === "done" ? "✓" : status === "failed" ? "✗" : status === "in_progress" ? "…" : "○";
    console.log(`  ${icon} Task ${id}: ${status}`);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function runStatus() {
  const metaPath = join(targetDir, ".codex", "handoff-meta.json");
  if (!existsSync(metaPath)) {
    console.error("No .codex/handoff-meta.json found");
    process.exit(1);
  }

  const meta: HandoffMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
  console.log(`\nProject: ${meta.project}`);
  console.log(`Created: ${meta.createdAt}`);
  console.log(`Repo: ${meta.repo || "(none)"}`);
  console.log(`Tasks: ${meta.totalTasks}\n`);

  const counts = { pending: 0, in_progress: 0, done: 0, failed: 0 };
  for (const [id, status] of Object.entries(meta.taskStatus)) {
    counts[status]++;
    const icon =
      status === "done" ? "✓" : status === "failed" ? "✗" : status === "in_progress" ? "…" : "○";
    console.log(`  ${icon} Task ${id}: ${status}`);
  }
  console.log(
    `\n  Summary: ${counts.done} done, ${counts.in_progress} in progress, ${counts.pending} pending, ${counts.failed} failed\n`
  );
}

// ---------------------------------------------------------------------------
// Create GitHub Issues
// ---------------------------------------------------------------------------

function runCreateIssues() {
  const repoIdx = flags.indexOf("--repo");
  const repo = repoIdx !== -1 ? flags[repoIdx + 1] : undefined;

  if (!repo) {
    console.error("Provide --repo <owner/name>");
    process.exit(1);
  }

  const tasksDir = join(targetDir, ".codex", "tasks");
  if (!existsSync(tasksDir)) {
    console.error("No .codex/tasks directory found");
    process.exit(1);
  }

  const taskFiles = readdirSync(tasksDir)
    .filter((f) => f.endsWith(".md"))
    .sort();

  console.log(`\nCreating ${taskFiles.length} issues in ${repo}...\n`);

  // Ensure 'codex' label exists
  spawnSync("gh", ["label", "create", "codex", "--repo", repo, "--color", "0052cc", "--description", "Codex task from handoff", "--force"], {
    encoding: "utf-8",
  });

  for (const tf of taskFiles) {
    const content = readFileSync(join(tasksDir, tf), "utf-8");
    const titleMatch = content.match(/^# Task \w+: (.+)$/m);
    const title = titleMatch ? titleMatch[1] : tf.replace(".md", "");

    const result = spawnSync(
      "gh",
      [
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        `Task ${tf.split("-")[0]}: ${title}`,
        "--body-file",
        join(tasksDir, tf),
        "--label",
        "codex",
      ],
      { encoding: "utf-8" }
    );

    if (result.status === 0) {
      const url = result.stdout.trim();
      console.log(`  ✓ ${tf} → ${url}`);
    } else {
      console.log(`  ✗ ${tf}: ${result.stderr?.trim()}`);
    }
  }

  console.log(
    `\nDone. Tag @codex on each issue to start work, or use Codex Cloud.`
  );
}
