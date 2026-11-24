# `features/egress-approvals/`

The frontend side of egress approvals: `useEgressApprovals` watches for network requests
waiting on the user and sends their decisions, for the dialog in
`app/components/egress-approval-dialog.tsx`; `useChatWebAccess` and `ChatWebAccessSwitch` are
the per-chat "Ask for approval / Allow for this session" switch in the composer.
`egress-approvals.ts` holds the poll loop and decision handling without Solid, so they can be
tested.

**Public surface:** `index.ts` — `useEgressFeatures` (builds both hooks for `app.tsx`),
`useEgressApprovals`, `ChatWebAccessSwitch`, the `ChatWebAccess` and `EgressApprovals` types,
and the helpers the dialog uses (`approvalChoices`, `liveApprovals`, `secondsLeft`,
`PROXY_UNLISTED_ACTION`, `ApprovalChoice`).

**Depends on:** `solid-js`, `lucide-solid`, `src/i18n`,
`~/shared/platform/transport/instance-api` and `ServiceHubHttpError` from
`~/shared/platform/transport/servicehub`. No `fetch`, no openwork-server client.

**Contract:** leaf UI slice ([`../README.md`](../README.md)); consumes
`shared/contracts/src/sandbox-manager-host-api.ts` (pending approvals, decisions, chat grants,
error table) only through `~/shared/platform/transport/instance-api`.

**Still in `app/`:** the approval dialog (`app/components/egress-approval-dialog.tsx`) and the
new-chat hand-over in `app/app.create-session.ts`.

**Verify:** from `apps/ui`, `pnpm test src/features/egress-approvals` and
`pnpm test:workspace-files-panel src/features/egress-approvals`.

## Behaviour

- **Choices.** An approval that lists the `grant_scopes` it offers gets one Allow per scope
  from `approvalChoices` (Allow once, Allow all sites for this session) beside Deny; one that
  lists none gets Deny and Allow with no scope.
- **Chat names.** `chat-names.ts` names the chat an approval is for by hashing each root
  session the app lists into its `session_ref` (Web Crypto SHA-256 with the contract's
  `EGRESS_APPROVAL_SESSION_REF_LABEL`); no match names no chat.
- **Proxy approvals.** A `proxy.connect_unlisted` approval labels its allow-all "Allow all
  unlisted sites until SuperClaw restarts" and says it covers commands from every session
  (`egress_approval.proxy.*`): the proxy keeps that grant in its own memory, not in the chat
  switch.
- **Chat switch.** `app/pages/session-page.tsx` puts the switch in the composer's picker row
  through the `ComposerPickerAccessory` context from `session-composer.tsx`; it re-reads its
  chat whenever the approvals change. On the
  new-chat screen the choice is held until `app.create-session.ts` hands over the new root
  session (`applyPreselect`, one `PUT`, which the session waits for up to
  `PRESELECT_WAIT_MS` before it opens). On an existing chat it reads and writes the chat-grant
  routes for the root session the chat rolls up to (`chat-web-access.ts`). It is hidden for
  Slack and Telegram chats.
