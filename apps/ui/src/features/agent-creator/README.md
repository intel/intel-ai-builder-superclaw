# `features/agent-creator/`

Creating and editing workspace agents: the Agents section of the Settings dialog, the
capability category/skill/MCP selection it renders, the agent-markdown generator and parser,
and the capability presets and tooltip copy only this screen uses.

**Public surface:** `index.ts` — `AgentCreatorView`, the data types its caller names
(`AgentFormData`, `AgentInfo`), and the agent-markdown helpers the caller uses when it saves
(`generateAgentMarkdown`, `ensureAgentMarkdownMode`).

**Depends on:** `~/shared/ui/` (`button`, `card`, `text-input`, `tooltip`),
`~/shared/util/agent-markdown` (`validateAgentMarkdown`), `~/shared/util/frontmatter-preview`,
the capability gate in `~/shared/platform/capability/`, and `yaml`. Two dependencies are
injected as props by `app/pages/settings-dialog.content.tsx` instead of imported:
`skillDescription(name)`, because the bundled skill catalog
(`app/data/bundled-skill-descriptions.ts`) is shared with `app/context/extensions.ts`; and
`filePreview`, because `FilePreviewModal` still depends on `app/context/platform` and
`app/lib/log`.

**Contract:** leaf UI slice ([`../README.md`](../README.md)). The tool/skill catalog it
renders comes from openwork-server's
[`sandbox/server/src/tool-skill-catalog.ts`](../../../../../sandbox/server/src/tool-skill-catalog.ts).

**Still in `app/`:** nothing of this domain.

**Verify:** from `apps/ui`, `pnpm test src/features/agent-creator` and
`pnpm test:workspace-files-panel src/features/agent-creator`.

## Behaviour

**Editing an existing agent.** The edit form changes the file through
`agent-creator-frontmatter.ts`, which patches the description in place. It must not
regenerate the file: the parser does not read tools, skills or the permission map, so a
regenerated file loses them. A patch is refused unless every other key resolves exactly as
before, and the form opens only when a trial patch of the file succeeds. YAML the patch
cannot write back (a flow mapping, an anchor other keys refer to) opens in Markdown instead.
Add a case to `agent-creator-frontmatter.test.ts` rather than special-casing it.

**Protected File Pipeline opt-in.** The catalog reports `protectedFilePipelineAvailable` only
when the active Product Profile has the confirmation and pipeline tools, the confirmation
guard, and both file subagents. Generated agents keep `task: "*": deny`; enabling the opt-in
adds `confirm_file_protection: ask` and allows exactly two delegations: `protected-file-agent`
after `APPROVED`, and `local-file-agent` after `ACTION_DENIED`, `PROTECTION_DECLINED` or
`PROTECTION_DISABLED`, for the current request only. The generated agent gets no direct
access to `run_protected_file_pipeline` or `local_sensitive_read`. The runtime rules (one-shot
decline tokens, raw-source access) are enforced by each Profile's
`plugins/08_protected_pipeline_confirm_guard.ts` and `lib/protected-source-access.ts`, not by
this slice. Existing agent files are not regenerated; recreate the agent or edit it in the
Markdown editor to adopt the routing.
