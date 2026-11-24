# docx-create skill

Creates new Word documents from Markdown. Reading existing `.docx` files stays with the `docx` skill
and `local-file-agent`.

## Provenance

| | |
|---|---|
| Upstream | [github/awesome-copilot](https://github.com/github/awesome-copilot), `skills/md-to-docx` |
| Commit | `2746e462c143` (2026-05-27) |
| License | MIT. `LICENSE` is the repository's license file, kept verbatim. |
| Provenance check | 0 lines of 50+ characters shared with Anthropic's proprietary `pptx`/`docx`/`xlsx` skills (issue #3512) |

## What we took and what we changed

| Path | Source | Change |
|---|---|---|
| `SKILL.md` | Ours, from upstream `SKILL.md` | Renamed to `docx-create` (our `docx` skill reads Word files) and scoped to creating them. Removed the `npm install` step. Added the write-Markdown-then-convert workflow, the supported-Markdown list, and the `WARN`/`ERROR` check. |
| `scripts/md-to-docx.mjs` | Upstream, modified by the SuperClaw project (2026-10-23) | Imports `docx` and `marked` from `vendor/`. Fixes: front matter is read only at the start of the file and with CRLF line endings (upstream deleted the text between the first two `---` rules of a file without front matter); the title falls back to the first `#` heading, then the file name, instead of "Document"; only that one heading is moved to the title page (upstream dropped every H1 containing the title); no made-up "Version: 1.0" or date; the default output path never overwrites the input; JPEG images are embedded with their real type, tall images are constrained to the printable page, and missing, remote or unsupported images print `WARN:`; body H1 is sized like its style; Microsoft YaHei for East Asian text. A title is split only at its first dash, so the subtitle keeps the rest; images that share a paragraph with other images or text are all embedded, after its text (upstream dropped them); list items keep every block in order, including code blocks and paragraphs of loose lists (upstream kept only the first text and nested list); ordered lists count from their start number instead of repeating each item's marker; checklist items (`- [ ]`, `- [x]`) show ☐ or ☒ in place of the bullet (upstream dropped the box). |
| `vendor/docx.mjs`, `vendor/marked.mjs` | Generated | `docx` 9.6.1 and `marked` 17.0.4 bundled by `scripts/skill-bundles/docx-create/build.mjs`. Do not edit. |
| `THIRD_PARTY_NOTICES.md` | Generated | Licenses of every package inside the two bundles, including those `docx` inlines in its own build. |

Not taken: `scripts/package.json` (replaced by the vendored bundles).

## Ownership and boundaries

- **Touched contract:** leaf change for the skill folder. No payload change: the skill uses the
  shipped `node` (`tools/node`, on the agent's `PATH`).
- **Allowed dependencies:** Node built-ins and the two files in `vendor/`. No network, no
  `npm install`. Fonts come from Word on the reader's machine.
- **Why vendored:** adding `docx` and `marked` to `scripts/native-backend/config-deps` brings 401
  files (9.4 MB) into the `node_modules` tree that is copied into every runtime generation at
  start-up (measured at about +1.5 s per start). The two bundles are 437 KB and copy with the Profile.
- **Profiles:** identical copies in `lite`, `standard` and `pro`.
- **Updating:** bump the versions in `scripts/skill-bundles/docx-create/package.json`, then
  `npm install --ignore-scripts && npm run build` there. The build rebuilds `docx` from its release
  tag to list what it inlines, and fails if that rebuild differs from the published package. To take
  a newer upstream script, re-apply the changes above, re-run the provenance check, and update the
  commit in this file.

## Tests

From a folder outside this skill, with the shipped `node`:

```bash
node <skill_dir>/scripts/md-to-docx.mjs report.md
```

Expected: `Generated: ...report.docx`, with a `WARN:` line for each missing, remote or non-PNG/JPEG
image. A Markdown file without front matter but with two `---` rules must keep the text between
them; `node <skill_dir>/scripts/md-to-docx.mjs notes.docx` must fail with
`ERROR: output would overwrite the input`.
