# `features/` — the slices

One directory per product capability. A slice owns its own UI, its own state and the
modules only it uses, and it is reached through one file: its `index.ts`.

## Allowed dependencies

| From | May import |
|---|---|
| `app/` | anything, but a slice only through its `index.ts` |
| `features/<slice>/` | itself, `shared/`, `src/i18n` and npm packages (including `@different-ai/openwork-contracts/*`). Never a sibling slice, not even its `index.ts`, and never `app/` |
| `shared/` | `shared/`, `src/i18n` and npm packages. Nothing else. |

Checked from the repository root by `node scripts/ui-slice-boundary.mjs`, which explains each
rule and prints the exact fix. Cross-slice imports and upward imports from `shared/` are
absolute. `features/ -> app/` back-edges and imports past a slice's `index.ts` are ratchets
whose seed is 0, so the first new one fails the check: move what you need down into
`shared/`, or pass it in from `app/`.

Every slice is a leaf UI slice and implements no architecture contract. A slice that calls a
backend consumes a `shared/contracts` schema through a `shared/platform/transport/` adapter,
and its README names both.

## A slice is complete when

1. Every module only it uses lives in it, including its specs.
2. It has an `index.ts` exporting what callers actually use, and no more.
3. Nothing outside imports a module inside it.
4. Its `README.md` names its public surface and what of its domain is still in `app/`.

Give a new slice both files from its first commit, even if the surface is one export —
retrofitting a public API onto a slice callers already reach into is most of the work.

No slice imports `app/` today. `mcp` and `agent-creator` meet all four criteria and are the
worked examples; the others meet 2 to 4, and their READMEs say what is still in `app/` —
for most of them, the UI built on the slice's state.

## Slice README template

```markdown
# `features/<slice>/`

What the slice does, in one to three sentences.

**Public surface:** `index.ts` — the exports callers use.

**Depends on:** the `shared/` modules, injected dependencies and contract packages it uses.

**Contract:** leaf UI slice ([`../README.md`](../README.md)); name the `shared/contracts`
schema and transport adapter if it calls a backend.

**Still in `app/`:** what of this domain has not moved into the slice yet.

**Verify:** from `apps/ui`, the command that runs the slice's specs.
```

Add a `## Behaviour` section only for rules a reader cannot see from the code's shape.

## Running the specs

From `apps/ui`:

- `pnpm test src/features/<slice>` runs the `*.test.ts(x)` specs under `bun test`.
- `pnpm test:workspace-files-panel src/features/<slice>` runs the `*.vitest.ts(x)` specs.
  `bun test` does not pick those up, and `vitest.workspace-files-panel.config.ts` lists its
  files one by one, so a new `.vitest.ts` file runs nowhere until it is added to that list.
