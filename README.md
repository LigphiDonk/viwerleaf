<p align="center">
  <img src="./icons/icon.png" alt="Oh My Paper" width="120" height="120" />
</p>

<h1 align="center">Oh My Paper</h1>

<p align="center">
  <strong>A research harness for Claude Code — turn your terminal into an autonomous research lab.</strong>
</p>

> **Note:** This project is an extension/contribution based on the [Oh-My-Paper](https://github.com/LigphiDonk/Oh-my--paper) project. All credits to the original authors. This branch/version contains additional features and modifications.

<p align="center">
  <a href="./README.zh.md">中文文档</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/claude--code-plugin-blueviolet?style=flat-square" />
  <img src="https://img.shields.io/badge/agents-5-ff69b4?style=flat-square" />
  <img src="https://img.shields.io/badge/skills-34-green?style=flat-square" />
  <img src="https://img.shields.io/badge/commands-8-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/license-MIT-orange?style=flat-square" />
</p>

---

## TL;DR

```bash
# In Claude Code:
/plugin marketplace add LigphiDonk/Oh-my--paper
/plugin install omp@oh-my-paper
```

Restart Claude Code. Run `/omp:setup` inside your research project, then drive the full pipeline with `/omp:survey`, `/omp:experiment`, and `/omp:write`. No GUI, no window-switching — everything in the terminal.

---

## Table of Contents

- [Why This Exists](#why-this-exists)
- [Install](#install)
- [Slash Commands](#slash-commands)
- [The Agent Team](#the-agent-team)
- [34 Research Skills](#34-research-skills)
- [Hooks](#hooks)
- [Research Pipeline](#research-pipeline)
- [Project Scaffold](#project-scaffold)
- [How Memory Works](#how-memory-works)
- [Codex Delegation](#codex-delegation)
- [Remote Experiments](#remote-experiments)
- [For LLM Agents](#for-llm-agents)
- [Philosophy](#philosophy)
- [Contributing](#contributing)
- [Uninstall](#uninstall)

---

## Why This Exists

Claude Code is already a great coding agent. But **research isn't just coding** — it's literature survey, idea evaluation, experiment design, paper writing, reference checking, and a dozen other things that require domain-specific workflows.

Oh My Paper makes Claude Code **research-aware** by adding:

- **A structured 5-stage pipeline** — Survey → Ideation → Experiment → Publication → Promotion
- **5 specialized agent roles** — each with isolated memory and clear responsibilities
- **34 built-in research skills** — from paper search to figure generation
- **Background hooks** — auto-inject project context at session start, prompt role selection, track task completion
- **Codex delegation** — hand off parallel tasks to Codex in a separate terminal

Install it and forget about it. Your sessions get smarter. Your research gets organized.

---

## Install

### Step 1: Add the marketplace

```bash
/plugin marketplace add LigphiDonk/Oh-my--paper
```

### Step 2: Install the plugin

```bash
/plugin install omp@oh-my-paper
```

### Step 3: Restart Claude Code

Required for hooks to activate.

### Step 4: Initialize your project

```bash
/omp:setup
```

This scaffolds the `.pipeline/` directory and registers the `SessionStart` hook for your project.

### Update

Keep the plugin up to date with one command:

```bash
/omp:update
```

Options:
- `--check-only` - Only check for updates without installing
- `--auto` - Auto-update without confirmation

The plugin also checks for updates automatically once per day when you start a session (if auto-check is enabled).

If a new version is available:
1. The update command downloads the latest code from GitHub
2. Copies it to the plugin cache directory
3. Prompts you to run `/reload-plugins` (and restart if hooks changed)

> **Manual update (fallback)**:
> If automatic update fails, you can manually update:
> ```bash
> /plugin uninstall omp
> /plugin install omp@oh-my-paper
> /reload-plugins
> ```

### Install from Local Directory

```bash
git clone https://github.com/LigphiDonk/Oh-my--paper.git /tmp/oh-my-paper
# In Claude Code:
/plugin marketplace add /tmp/oh-my-paper
/plugin install omp@oh-my-paper
```

---

## Slash Commands

All commands are prefixed with `/omp:`.

| Command | What It Does |
|---------|-------------|
| `/omp:setup` | Scaffold a new research project — creates `.pipeline/`, memory files, and registers the SessionStart hook |
| `/omp:survey` | AI-assisted literature survey — search papers, build `literature_bank.md` |
| `/omp:ideate` | Generate and evaluate research ideas based on survey findings |
| `/omp:experiment` | Design experiments, write evaluation code, run on remote compute nodes |
| `/omp:write` | Draft paper sections, generate figures and captions, manage LaTeX files |
| `/omp:review` | Peer-review your paper or experiment results before submission |
| `/omp:update` | One-click plugin update — check for and install the latest version from GitHub |
| `/omp:delegate` | Generate a Codex prompt for a coding/experiment task; wait for result and update project state |
| `/omp:plan` | Review global progress, confirm next steps, update research plan |

### Quick Start

```bash
/omp:setup          # scaffold the project
/omp:survey         # start literature survey
/omp:ideate         # generate ideas from survey
/omp:experiment     # design & run experiments
/omp:write          # draft the paper
/omp:review         # final quality gate
```

---

## The Agent Team

When you open Claude Code in an Oh My Paper project, the `SessionStart` hook fires and Claude immediately asks which role you want to take on. Each role has **isolated memory** — it only reads and writes the files it needs.

| Role | Responsibility | Memory Scope |
|------|---------------|-------------|
| **Conductor** | Global planning, review outputs, dispatch tasks, auto-update `project_truth` after each subtask | `project_truth` · `orchestrator_state` · `tasks.json` · `review_log` · `agent_handoff` · `decision_log` |
| **Literature Scout** | Search papers, organize literature bank | `project_truth` · `execution_context` · `literature_bank` · `decision_log` |
| **Experiment Driver** | Design experiments, write code, run evaluations | `execution_context` · `experiment_ledger` · `research_brief.json` · `project_truth` |
| **Paper Writer** | Draft sections, generate figures, audit references | `execution_context` · `result_summary` · `literature_bank` · `agent_handoff` |
| **Reviewer** | Peer review, quality gate, consistency check | `execution_context` · `project_truth` · `result_summary` |

### How It Works

```
Session opens
    → SessionStart hook fires
        → Claude asks: which role today?
            → Agent loads role-specific memory files
                → Works as that persona
                    → On subtask complete: auto-updates tasks.json + project_truth
                        → Next session picks up right where you left off
```

**Key design decisions:**

- **Memory isolation** — the Paper Writer can't see the Conductor's orchestrator state; the Literature Scout can't see experiment results. This prevents context pollution.
- **Shared state** — `tasks.json` and `project_truth.md` are the common ground, updated by all roles after each subtask.
- **No manual sync** — the Conductor auto-updates `tasks.json` (marks tasks `done`) and appends a progress entry to `project_truth.md` whenever a subtask completes, without waiting for you to ask.

---

## 34 Research Skills

Skills are structured instruction sets that Claude loads on demand. Each skill is a markdown file covering a specific research task.

<details>
<summary><strong>Click to expand the full skill list</strong></summary>

| Category | Skills |
|----------|--------|
| **Literature** | `paper-finder` · `paper-analyzer` · `paper-image-extractor` · `research-literature-trace` · `biorxiv-database` · `dataset-discovery` |
| **Survey & Ideation** | `inno-deep-research` · `gemini-deep-research` · `inno-code-survey` · `inno-idea-generation` · `inno-idea-eval` · `research-idea-convergence` |
| **Experiment** | `inno-experiment-dev` · `inno-experiment-analysis` · `research-experiment-driver` · `remote-experiment` |
| **Writing** | `inno-paper-writing` · `ml-paper-writing` · `scientific-writing` · `inno-figure-gen` · `inno-reference-audit` · `research-paper-handoff` |
| **Planning & Review** | `inno-pipeline-planner` · `research-pipeline-planner` · `inno-paper-reviewer` · `inno-prepare-resources` · `inno-rclone-to-overleaf` |
| **Presentation** | `making-academic-presentations` · `inno-grant-proposal` |
| **Agent Dispatch** | `claude-code-dispatch` · `codex-dispatch` |
| **Domain-Specific** | `academic-researcher` · `bioinformatics-init-analysis` · `research-news` |

</details>

Skills are auto-recommended based on your current pipeline stage. Add project-local skills in the `skills/` directory.

---

## Hooks

Oh My Paper registers three hooks that run in the background:

| Hook | Trigger | What It Does |
|------|---------|-------------|
| **SessionStart** | Every time you open Claude Code in this project | Outputs project context to Claude — current stage, active task, last handoff — then prompts you to pick a role via `AskUserQuestion` |
| **Stop** | When a task completes | Tracks task completion, updates `tasks.json` |
| **PostToolUse (Write)** | After any file write | Detects pipeline stage transitions |

**Important:** Hooks only activate after running `/omp:setup` in your project. Setup registers the `SessionStart` hook in `.claude/settings.json` and creates the `.pipeline/` directory that the hook checks.

---

## Research Pipeline

A structured 5-stage workflow from idea to publication:

```
┌──────────┐    ┌──────────┐    ┌────────────┐    ┌─────────────┐    ┌───────────┐
│  Survey  │ →  │ Ideation │ →  │ Experiment │ →  │ Publication │ →  │ Promotion │
└──────────┘    └──────────┘    └────────────┘    └─────────────┘    └───────────┘
```

Each stage comes with:
- **Auto-generated task trees** — what to do next
- **Recommended skills** — which skills to load
- **Context-aware prompts** — agents read `tasks.json` and `research_brief.json` and know what to do

---

## Project Scaffold

`/omp:setup` creates this structure:

```
my-research/
├── paper/                  # LaTeX workspace
│   ├── main.tex
│   ├── sections/
│   └── refs/
├── experiment/             # Experiment code & scripts
├── survey/                 # Literature survey artifacts
├── ideation/               # Ideas, evaluations, plans
├── promotion/              # Slides, demos, outreach
├── skills/                 # Project-local skills
├── .pipeline/
│   ├── tasks/
│   │   └── tasks.json      # Task tree across all stages
│   ├── docs/
│   │   └── research_brief.json
│   └── memory/             # Agent memory files
├── .claude/
│   └── settings.json       # SessionStart hook registration
├── CLAUDE.md
└── AGENTS.md
```

---

## How Memory Works

Each agent role reads and writes specific memory files. The Conductor is responsible for keeping shared state in sync.

```
.pipeline/memory/
├── project_truth.md        # Ground truth + progress log (appended after each subtask)
├── orchestrator_state.md   # Conductor's planning state
├── execution_context.md    # Current task context for executors
├── experiment_ledger.md    # Experiment history & results
├── result_summary.md       # Latest results for writing & review
├── review_log.md           # Review feedback history
├── literature_bank.md      # Organized paper notes
├── agent_handoff.md        # Cross-agent handoff messages
└── decision_log.md         # Rejected directions & reasoning

.pipeline/tasks/
└── tasks.json              # Shared task tree (all roles read/write this)
```

Memory survives across sessions. The `SessionStart` hook reads these files and injects the relevant context — you pick up right where you left off.

**Auto-sync rule:** The Conductor updates `tasks.json` and `project_truth.md` automatically after every subtask completes (delegate / experiment / survey / write / review). You never need to ask it to sync.

---

## Codex Delegation

The Conductor can hand off coding and experiment tasks to Codex:

```bash
/omp:delegate
```

The flow:
1. Conductor reads project context and the current task
2. Presents task summary — you confirm
3. Generates a complete Codex prompt with context pre-injected
4. You copy it to a new terminal: `codex "..."`
5. Conductor polls for completion (`CODEX_DONE` signal in `agent_handoff.md`)
6. Reads result, asks you to accept/revise/reject
7. On accept: updates `tasks.json` and `project_truth.md` automatically

---

## Remote Experiments

The `remote-experiment` skill + `/omp:experiment` support a full auto-experiment loop:

```
Design plan → Implement code → rsync to server → Run on GPU → Parse metrics → Repeat
```

- SSH/rsync-based remote compute via `compute-helper` CLI
- Configurable success thresholds, max iterations, and failure limits
- Results flow back into `experiment_ledger.md` for the Paper Writer

---

## For LLM Agents

If you're an AI agent installing this plugin:

```bash
# Step 1: Add marketplace
/plugin marketplace add LigphiDonk/Oh-my--paper

# Step 2: Install plugin
/plugin install omp@oh-my-paper

# Step 3: Verify installation
/plugin
# Should show: omp @ oh-my-paper, Status: Enabled

# Step 4: User must restart Claude Code (you cannot do this)
# Tell user: "Please restart Claude Code to activate hooks."

# Step 5: Initialize project
/omp:setup
```

---

## Philosophy

> **Enhance, don't replace.** Claude Code is already smart — we add research structure, not overrides.

- **Your context is for reasoning** — hooks inject only what's needed; memory files keep the rest on disk
- **Domain-specific, not generic** — every skill, agent, and command is designed for academic research
- **Invisible when not needed** — hooks run in the background; no noise if you're just coding
- **Composable** — use one command, use all of them, or just let the hooks do their thing
- **Memory over repetition** — agents remember project context so you don't re-explain every session

---

## Contributing

PRs welcome. If you add a new skill, put it in `skills/` with proper YAML frontmatter and update `research-catalog.json`.

Any change to cached content requires version bumps in **both**:
- `plugins/oh-my-paper/.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`

---

## Uninstall

```bash
/plugin uninstall omp@oh-my-paper
```

---

## License

MIT. See [LICENSE](./LICENSE).

---

## Acknowledgments

Special thanks to the **[Linux.do](https://linux.do)** community for your support and feedback.

---

<p align="center">
  <strong>Oh My Paper</strong> — Where Research Meets the Terminal.
</p>
