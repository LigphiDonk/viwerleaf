---
id: research-literature-trace
name: Research Literature Trace
description: Use for survey or ideation work that needs literature collection, screening, source tracing, canonical paper URLs, or gap summaries.
version: 1.0.0
stages: [survey, ideation]
tools: [read_file, search_project, write_file]
---

# Research Literature Trace

Use this skill for literature collection, screening, and source tracing.

## Goals

- collect traceable papers and canonical links
- identify representative baselines and gaps
- write reusable notes into the survey-stage workspace

## Working Rules

1. Prefer official publisher pages, DOI resolvers, conference proceedings, or trusted indexes.
2. Keep claims tied to an explicit source path or URL.
3. Record short screening notes rather than long prose.
4. Mark uncertainty explicitly when a source cannot be verified.
5. Each paper entry in `paper_bank.json` **MUST** include a `url` field pointing to the real paper page (prefer DOI link `https://doi.org/...`; fallback to Semantic Scholar, arXiv, or publisher page). Never leave `url` empty.
6. The `authors` field in `paper_bank.json` **MUST** be an array of strings (e.g. `["Alice", "Bob"]`), never a single string like `"TBD"`.
7. For every markdown artifact (e.g. `domain_map.md`), generate **both** a Chinese version (`domain_map.zh.md`) and an English version (`domain_map.en.md`) alongside the main file.

## Expected Outputs

- literature shortlist with URLs
- screening notes
- gap summary for ideation
