---
name: skill-finder
description: Checks whether the user already has a suitable Agent Skill installed locally, and if not, finds an existing skill they can install. Use when users ask if they already have a skill, whether a suitable skill exists locally, or ask to find an existing skill instead of creating a new one. Do not use for questions about how skills work, SKILL.md syntax, or general discussions about the skill system.
meta:
  version: "1.2.0"
  triggers:
    - "is there a skill for"
    - "I want a skill that does"
    - "find me a skill to"
    - "有没有关于...的 skill"
    - "帮我找一个...的技能"
  dependencies:
    - mcp:fetch
    - tool:bash
    - tool:write_file
---

# Skill Finder

Help the user discover an existing skill that already fulfills their requirements instead of building one from scratch. The user describes a need in natural language; you search verified sources, evaluate security, rank closest matches, and execute local installation workflows.

## When to use

- When a user asks whether a capability already exists as a skill ("Do I already have a skill for Git rebase conflicts?", "Is there a skill for ...?").
- **Local-first:** Always check the user's locally installed skills FIRST. Only search online sources if no suitable local skill is found.
- **Mandatory Gatekeeper:** Invoke this skill BEFORE starting `skill-creator` to avoid duplicate implementations.

## Target Repositories & Dynamic Routing Matrix

### 1. First-Party / Official Repositories (GitHub API Content Fetching)
These repos follow the `agentskills.io` spec. Because path layouts may vary by package monorepos, use fallback paths if the primary directory errors out.

| Owner / Repo | Domain / Focus | Primary Content API Path (main branch) |
| :--- | :--- | :--- |
| `anthropics/skills` | Office docs (docx/xlsx), Canvas, Meta-creators | `https://api.github.com/repos/anthropics/skills/contents/packages/document-skills/skills` <br> *Fallback: `/packages/example-skills/skills`* |
| `MiniMax-AI/skills` | Frontend, Full-stack UI, Mobile, Office suites | `https://api.github.com/repos/MiniMax-AI/skills/contents/skills` |
| `MicrosoftDocs/Agent-Skills` | Azure cloud, enterprise software architecture | `https://api.github.com/repos/MicrosoftDocs/Agent-Skills/contents/skills` |

*To inspect metadata, request the raw file at:*
`https://raw.githubusercontent.com/<owner>/<repo>/main/<detected_path>/<name>/SKILL.md`

### 2. Public Marketplaces & Registries
- **ClawHub (`clawhub.ai`)**: Public registry for OpenClaw. If direct network timeouts occur (403/502), gracefully treat it as an environmental restriction and proceed with alternative indices.
- **SkillHub (`skillhub.space`)**: The OpenClaw Skills Registry (Discover, Share & Install Agent Skills).
  - Preferred search API: `GET https://skillhub.space/api/skills?search=<keywords>`
  - Use `Accept: application/json`
  - Do not use `/api/v1/search`.
  - Do not require or install SkillHub CLI for normal search flow.
  - `api.skillhub.cn` may fail in some networks due to TLS/certificate issues; prefer `skillhub.space`.

---

## Execution Workflow

### Step 1: Semantic Mapping & Keyphrase Extraction
Acknowledge the user's intent in a single sentence. If the request is ambiguous, ask **exactly one** clarifying question targeting the task domain and technical stack. Derive 3–5 high-density English search keywords (e.g., "表格工资计算" ➔ `xlsx payroll calculator dynamic formulas`).

### Step 2: Local Inventory Check (Do This First)
Before touching any network source, check whether a relevant skill is already installed locally.
- If a local skill already satisfies the need, tell the user it is **already installed**, name it, and stop here — do NOT search online.
- Only if no local skill matches, proceed to Step 3 (online discovery).

### Step 3: Multi-Source Ingestion
1. Connect via `mcp:fetch` or GitHub tools to inspect the target repository directories.
2. If querying registries (`clawhub` or `skillhub`), verify domain status and then use the public HTTP search endpoint when available.
   - For SkillHub, call `https://skillhub.space/api/skills?search=<keywords>` directly.
   - Example:
     - `curl -s -H "Accept: application/json" "https://skillhub.space/api/skills?search=wps"`
   - Treat SkillHub CLI as optional and out of scope for default discovery.
   - Parse response fields such as `name`/`slug`, `description`, `isVerified`, `validationScore`, `downloads`, `stars`, `owner`, and `createdAt`.

### Step 4: Security & Scope Vetting (Mandatory)
Before displaying any community-contributed skill (especially from open marketplaces), scan the `SKILL.md` raw content for security anomalies:
* **🚨 REJECT/WARN immediately if the skill matches these patterns:**
    - Contains obfuscated base64 scripts or hardcoded execution blocks calling `curl`/`wget` to unverified/external domains.
    - Requests global environment tokens or scans highly sensitive paths (`~/.ssh`, `~/.aws`, `.env`) unrelated to its stated functionality.

### Step 5: Rank & Present
Render a highly scannable Markdown comparison table containing the top 3–5 matched items. Order items strictly by semantic proximity to the requested workflow. Clearly tag partial or fuzzy matches.

---

## Installation & Deployment Mapping

When the user selects a candidate, execute or instruct deployment mapping precisely to prevent wrong-location directory pollution:

* **Target Destination:** Always deploy skills into `.opencode/skills/<skill-name>/SKILL.md` (Self-install path for this helper is `.opencode/skills/skill-finder/SKILL.md`).
* **In-App Marketplace Stream:** For default hub repos (`anthropics`, `minimax`), direct the user to go to **Skills → Install skills**, select the target name, and hit **Install**.
* **External Git / Raw Stream:** Pull down the complete directory structure using local file tools, create the nested path under `.opencode/skills/<name>/`, and write the extracted `SKILL.md` manifest along with any companion scripts. Remind the user if a specific `.mcp.json` extension tool configuration is mandated by the package `dependencies`.

---

## Output Contract

Your final response must strictly adhere to the following structure:
1. One-sentence validation of the user's requirement.
2. A compact Markdown ranking table (Columns: Name, Source, Trust Rank, Capabilities).
3. Explicit disclosure if ClawHub or any endpoint was skipped due to network or gateway drops.
4. Clear installation paths mapping to the target environment.
5. A single closing prompt asking the user which specific solution they wish to deploy.