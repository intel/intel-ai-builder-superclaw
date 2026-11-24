---
name: pptx-create
description: "Use this skill when the user wants to create or generate a PowerPoint deck (.pptx): slides, a presentation, a pitch or strategy deck, or a report turned into slides. Builds colourful, full slides with native charts from a JSON outline and checks them in one command. To read or summarize an existing .pptx, use the pptx skill instead."
---

# Create PowerPoint decks

`<skill_dir>` below means the base directory shown when this skill loaded. Everything needed is
installed; do not run `pip install` and do not read other files in `<skill_dir>`.

## Workflow (three steps)

1. **Write `deck.json`** in the user's workspace, for example `/workspace/<deck-name>/deck.json`,
   using the layouts below. Unless the user asks for a length, make **8-12 slides**: `cover` first,
   `closing` last.
2. **Build and check** with one command:

   ```bash
   python <skill_dir>/scripts/build_deck.py /workspace/<deck-name>/deck.json
   ```

   The last line is `PASS` or `FAIL`.
3. **On `FAIL`**, fix every `ERROR` and `FIX` line in one pass, editing only the slides they name,
   and run the same command once more. An `ERROR` shows that layout's fields; a `FIX` names the text
   and how many words to cut; a `WARN ... words` line means the slide is thin, so add facts from the
   source in the same pass. The deck is saved either way: if lines remain after the second run,
   deliver it. Do not read the scripts. Then tell the user the file path, slide count and outline.

## Writing the slides

- **Titles state the conclusion** as a full sentence ("Pi trades convenience for control"), not a
  topic ("Pi features"). Read in order, the titles tell the whole story.
- **Each content slide carries 40-90 words.** Give every card, item or step a short heading
  (2-5 words) plus one or two full sentences with a specific fact, number, name or example.
- **Use the user's own facts and numbers.** Never invent figures; label estimates and unverified
  claims as such. Add a `source` to every slide whose content comes from a document or data.
- **Choose the layout by the content's shape**: parallel points `cards`; headline numbers `stats`;
  two options `two_column`; many attributes `table`; ranked actions `numbered`; a sequence `steps`;
  a data series `chart`. Never use the same layout on two slides in a row.
- A `callout` is one sentence that says what the slide means for the audience.
- Cut filler such as "leverage", "robust", "seamless", "various" and "in today's world".
- Write all text, including panel headings, in the user's language.

## deck.json

`output` is the `.pptx` path (honor any path the user gave). Do not set `theme`: the build picks a
colour that fits the topic. Only if the user asked for a colour, set `theme` to that colour as the
user said it (`"orange"`, `"Intel blue"`) or as a hex code (`"#0068B5"`); the build makes a theme
from it.

```json
{
  "output": "/workspace/agents/agents.pptx",
  "slides": [
    {"layout": "cover", "title": "Pi Agent vs Hermes Agent", "subtitle": "A minimal coding harness versus an always-on assistant", "note": "Comparative analysis, October 2026"},
    {"layout": "section", "number": "01", "title": "Pi: a small core you extend", "subtitle": "Built in 2025 as a reaction to opaque coding agents"},
    {"layout": "cards", "title": "Pi is four layered packages, not a monolith",
     "cards": [["1", "pi-ai", "One LLM API across Anthropic, OpenAI, Google and local models, with mid-session switching."], ["2", "pi-agent-core", "A reusable agent loop; OpenClaw uses it as its engine."], ["3", "pi-tui", "A terminal UI that redraws only what changed, so it never flickers."], ["4", "pi-coding-agent", "The pi CLI: four tools, a short prompt and branchable sessions."]],
     "callout": "Other projects build on Pi's core instead of forking it", "source": "Source: project docs"},
    {"layout": "stats", "title": "Pi is minimal by design",
     "stats": [["4", "core tools", "read, write, edit and bash"], ["<1K", "prompt tokens", "frontier models need little instruction"], ["0", "permission prompts", "sandboxes are recommended instead"]],
     "columns": [["Left out", ["No built-in MCP or sub-agents", "No plan mode or to-do tools"]], ["Added back by users", ["TypeScript extensions and skills", "Packages shared via npm or git"]]], "source": "Source: project docs"},
    {"layout": "two_column", "title": "The two agents are built for different jobs",
     "columns": [["Pi", ["A terminal coding harness for developers who want full control", "User-authored skills that load only when relevant", "Runs commands without approval; sandboxing is advised"]], ["Hermes Agent", ["An always-on personal assistant that runs on its own schedule", "Persistent memory and skills it learns over time", "Reachable from Telegram, Slack, Discord and Signal"]]],
     "callout": "Compare Hermes with OpenClaw, not with Pi", "source": "Source: project docs"},
    {"layout": "table", "title": "Head to head, scope is the clearest difference", "headers": ["Dimension", "Pi", "Hermes Agent"],
     "rows": [["Niche", "Terminal coding harness", "Always-on personal assistant"], ["Memory", "Branchable session trees", "Persistent across sessions"], ["Skills", "User-authored, loaded on demand", "Learned over time"], ["Interfaces", "CLI, SDK and RPC modes", "CLI plus chat-app gateway"]],
     "insights": ["They rarely compete directly", "\"Skills\" means different things in each"], "source": "Source: project docs"},
    {"layout": "chart", "title": "Most evaluation time went to coding tasks", "kind": "donut", "categories": ["Coding", "Research", "Messaging"],
     "series": [["Share of time", [0.45, 0.3, 0.25]]], "number_format": "0%", "takeaways": ["Coding dominated the trial", "Messaging was tested least"], "source": "Source: example data"},
    {"layout": "numbered", "title": "Choose Pi for coding; verify Hermes before adopting it",
     "items": [["Choose Pi for a lean harness", "Four tools and no hidden context give full control over what the model sees."], ["Sandbox it", "Pi runs commands without approval, so add permission gates if governance requires them."], ["Verify Hermes first", "Confirm its memory and skill features against the official repository."]],
     "panel": {"value": "1 of 4", "label": "sources were primary", "text": "Re-check these findings once official documentation is available."}, "source": "Source: project docs"},
    {"layout": "steps", "title": "Three steps settle the open questions",
     "steps": [["Identify", "Confirm whether Hermes Agent is an official Nous Research product, a release or a community project."], ["Read the repos", "Check both projects' READMEs and release notes, and confirm how Hermes stores memory."], ["Compare", "Score architecture, memory, models and extensibility side by side on verified facts."]],
     "callout": "Until then, treat every Hermes claim as a hypothesis"},
    {"layout": "quote", "quote": "Describing features without a source risks inventing details.", "attribution": "Research note on Hermes Agent"},
    {"layout": "closing", "title": "Next step: gather primary documentation", "bullets": ["Is Hermes Agent an official product?", "Does Pi's minimalism hold for local models?"], "next_step": "Rerun the comparison on verified facts"}
  ]
}
```

Limits: `cards` 2-6 cards of `[heading, text]` or `[badge, heading, text]`, where a badge is a
number or 1-2 letters, never a symbol or emoji (optional `columns`: the number of card columns);
`stats` 2-4 of `[value, label, note]`, with optional `columns` (up to 2 of `[heading, [bullets]]`) or
`bullets`; `two_column` exactly 2 columns; `table` 2-6 columns and up to 8 rows, optional `insights`
and `insight_title`; `numbered` 2-5 items, optional `panel`; `steps` 3-6 steps, optional `callout`;
`chart` `kind` is `bar`, `column`, `stacked`, `line` or `donut` (one series), one number per
category, optional `takeaways`, `takeaways_title` and `number_format` (`"0%"`, `"#,##0"`);
`closing` takes `bullets` or `message`, and an optional `next_step`.

Write only inside the workspace. Never edit files under `<skill_dir>`.
