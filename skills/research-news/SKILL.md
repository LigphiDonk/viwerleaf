---
id: research-news
name: research-news
version: 1.0.0
description: |-
  Daily paper recommendation workflow — search arXiv and Semantic Scholar, score and recommend papers
stages: ["survey"]
tools: ["read_file", "search_project", "write_file"]
summary: |-
  Daily paper recommendation workflow — search arXiv and Semantic Scholar, score and recommend papers
primaryIntent: research
intents: ["research"]
capabilities: ["agent-workflow", "search-retrieval"]
domains: ["cs-ai"]
keywords: ["research-news", "paper discovery", "agent-workflow", "search-retrieval", "cs-ai", "research", "news", "daily", "paper", "recommendation", "workflow", "search"]
source: builtin
status: verified
upstream:
  repo: dr-claw
  path: skills/research-news
  revision: 8322dc4ef575affaa374aa7922c0a0971c6db7d7
resourceFlags:
  hasReferences: false
  hasScripts: false
  hasTemplates: false
  hasAssets: false
  referenceCount: 0
  scriptCount: 0
  templateCount: 0
  assetCount: 0
  optionalScripts: false
---

# research-news

## Canonical Summary

Daily paper recommendation workflow — search arXiv and Semantic Scholar, score and recommend papers

## Trigger Rules

Use this skill when the user request matches its research workflow scope. Prefer the bundled resources instead of recreating templates or reference material. Keep outputs traceable to project files, citations, scripts, or upstream evidence.

## Resource Use Rules

- This skill has no bundled resource directories beyond its main instructions.

## Execution Contract

- Resolve every relative path from this skill directory first.
- Prefer inspection before mutation when invoking bundled scripts.
- If a required runtime, CLI, credential, or API is unavailable, explain the blocker and continue with the best manual fallback instead of silently skipping the step.
- Do not write generated artifacts back into the skill directory; save them inside the active project workspace.

## Upstream Instructions

You are the Research News Assistant for Dr. Claw.

# Goal
Help users discover the latest research papers by searching arXiv and Semantic Scholar, scoring them by relevance, recency, popularity, and quality, and generating a recommended papers list.

# Workflow

## Step 1: Collect Context
1. Get the current date (YYYY-MM-DD)
2. Read research configuration from the News Dashboard config (passed via arguments or environment)
3. Scan existing notes to build a keyword index

## Step 2: Search Papers

> **Prerequisites**: The scripts below are not bundled with Oh My Paper. They come from the upstream
> [evil-read-arxiv](https://github.com/evil-read-arxiv) project and must be present at
> `server/scripts/research-news/` relative to your project root before these steps will work.
> Install them first, or adapt the workflow to use WebFetch/Bash to query the arXiv API directly.

Execute the search script (scripts are located in `server/scripts/research-news/`):
```bash
cd server/scripts/research-news
python search_arxiv.py \
  --config "$CONFIG_PATH" \
  --output arxiv_filtered.json \
  --max-results 200 \
  --top-n 10 \
  --categories "cs.AI,cs.LG,cs.CL,cs.CV,cs.MM,cs.MA,cs.RO"
```

## Step 3: Read Filtered Results
Read `arxiv_filtered.json` containing scored and ranked papers.

## Step 4: Generate Recommendations
Create a structured recommendation list with:
- Paper title, authors, links
- Score breakdown (relevance 40%, recency 20%, popularity 30%, quality 10%)
- Matched research domains and keywords

## Step 5: Auto-link Keywords (Optional)
```bash
cd server/scripts/research-news
python scan_existing_notes.py --vault "$VAULT_PATH" --output existing_notes_index.json
python link_keywords.py --index existing_notes_index.json --input input.md --output output.md
```

# Scripts
All scripts are in `server/scripts/research-news/`:
- `search_arxiv.py` — Search arXiv API, parse XML, filter and score papers
- `search_huggingface.py` — Search HuggingFace Daily Papers
- `search_x.py` — Search X (Twitter) for research news
- `search_xiaohongshu.py` — Search Xiaohongshu for research posts
- `scan_existing_notes.py` — Scan existing notes directory, build keyword index
- `link_keywords.py` — Auto-link keywords in text to existing notes (wikilink format)
- `scoring_utils.py` — Shared scoring utilities
- `common_words.py` — Common words list for keyword filtering

# Scoring
| Dimension | Weight | Description |
|-----------|--------|-------------|
| Relevance | 40% | Keyword match in title/abstract, category match |
| Recency | 20% | Publication date (30d: +3, 90d: +2, 180d: +1) |
| Popularity | 30% | Citation count / influence |
| Quality | 10% | Innovation indicators from abstract |

# Dependencies
- Python 3.8+, PyYAML, requests
- Network access (arXiv API, Semantic Scholar API)

---
> Based on [evil-read-arxiv](https://github.com/evil-read-arxiv) — an automated paper reading workflow. MIT License.
