# pptx-create skill

Creates PowerPoint decks. The `pptx` skill next to it only reads them.

## Provenance

All files are ours, written for SuperClaw (issue #3512). Nothing is taken from Anthropic's
proprietary `pptx` skill, whose license forbids copies and derivative works; its files were not
read. Its output deck from #3512 was used only as a visual quality target.

The first version of this skill vendored `likaku/Mck-ppt-design-skill` (Apache-2.0). Its
fixed-geometry layouts left most of each slide empty and could not take larger text, so it was
replaced by `scripts/layouts.py`; no upstream code or text remains, so its `LICENSE` and `NOTICE`
were removed with it.

| Path | What it does |
|---|---|
| `SKILL.md` | Three-step flow (write `deck.json`, run `build_deck.py`, fix what it names), writing rules, 11 layouts with one worked example, limits. |
| `scripts/build_deck.py` | Reads `deck.json`, builds every slide, flags placeholder text and thin slides, prints `FIX`/`WARN` lines and `PASS`/`FAIL`. Exit 0 pass, 1 a slide needs fixing, 2 invalid outline. |
| `scripts/layouts.py` | The 11 layouts and 7 themes: white slides with a main and a contrasting colour, each with one of 3 cover styles; a requested colour word or hex code becomes its own theme; when `deck.json` sets none, `build_deck.py` picks one from topic words (English and Chinese) in the slide titles. Each layout fills the content area and picks the largest font size at which its text fits; text that cannot fit at the smallest size becomes a `FIX` issue. Segoe UI and Microsoft YaHei by name; no fonts bundled. |

## Ownership and boundaries

- **Touched contract:** leaf change. A Profile skill folder; OpenCode discovers it from `skills/`.
- **Allowed dependencies:** Python standard library and `python-pptx` (in the agent environment).
  No network, no `pip install`, no cloud API.
- **Profiles:** identical copies in `lite`, `standard` and `pro`.

## Tests

From a folder outside this skill, with the agent environment's `python`:

```bash
python -X utf8 <skill_dir>/scripts/build_deck.py deck.json   # the SKILL.md example, with a real output path
```

It must print `PASS` with no `WARN` lines. Open the deck in PowerPoint and check every slide.
