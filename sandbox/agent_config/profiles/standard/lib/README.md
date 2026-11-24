# Profile runtime helpers

The Profile runtime middleware owns these leaf helpers for the `AgentRuntime`
and `Capability` contracts. They may depend on Node built-ins and Profile-local
code, not UI or host implementation modules. This folder is not a plugin or
tool discovery directory.

`protected-source-access.ts` is the shared source-file policy used by the
confirmation guard for opted-in custom agents and by Pro's built-in default
guard. Keep its copies byte-identical across Lite, Standard, and Pro: each
Profile is packaged as a self-contained configuration root.

Verify from the repository root:

```powershell
bun test --isolate .\tests\plugins\protected-pipeline-confirm-guard\ts .\tests\plugins\superclaw-default-tool-guard\ts
pnpm product-profiles:check
```
