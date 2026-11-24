---
name: github
description: Use this skill for any GitHub work — listing, reading, triaging, or commenting on issues and pull requests, reviewing diffs and CI checks, inspecting repos, branches, releases, or workflow runs, and searching code or issues on GitHub. Drives the pre-installed `gh` CLI, explains how to check whether a GitHub account is connected, and what to do when it is not.
---

# GitHub via the `gh` CLI

`gh` is pre-installed in this container and is the primary way to reach GitHub. **Never try to install it**, never scrape github.com HTML, and never hand the user an auth command — signing in happens in the app's settings, not in a shell (§6).

## 1. Preflight — check auth once per session

Before your first GitHub action, run:

```bash
gh auth status
```

Then follow whichever branch applies:

| `gh auth status` says | Do this |
|---|---|
| Logged in to github.com as `<user>` | Use `gh` for the whole task. Go to §2. |
| Not logged in / no accounts | Call `get_mcp_status`. If a GitHub MCP server is connected, use its tools for this task instead. |
| Not logged in **and** no GitHub MCP | Stop and give the user the connect message in §6 verbatim-ish. Do not guess, do not retry `gh`, and do not offer them a login command. |

Do not re-run `gh auth status` before every command — once per session is enough. If a later command fails with an auth error, treat that as the credential having been revoked and go back to this table.

## 2. Pick the target repository

`gh` infers the repo from the current directory's git remote. Inside a cloned repo under `/workspace`, plain `gh issue list` works. Otherwise pass `-R owner/repo` explicitly.

```bash
# Which repo would gh act on?
gh repo view --json nameWithOwner -q .nameWithOwner

# Or target one explicitly (works from any directory)
gh issue list -R cli/cli
```

If the user names a repo, prefer `-R owner/repo` over `cd`-ing around — it is unambiguous and cannot pick up the wrong remote.

## 3. Reading — always ask for JSON

Rendered `gh` output is built for humans and is easy to misparse. Use `--json` with only the fields you need, and `-q` (built-in jq) to shape it. Smaller field sets mean less context burned.

```bash
# Open issues, newest first
gh issue list --state open --limit 50 --json number,title,author,labels,createdAt,updatedAt

# Open PRs with review + CI state
gh pr list --state open --limit 50 --json number,title,author,isDraft,reviewDecision,statusCheckRollup

# One issue including its full comment thread
gh issue view 123 --json number,title,body,state,labels,comments

# One PR: metadata, then the diff as a separate call
gh pr view 456 --json number,title,body,headRefName,baseRefName,reviewDecision,files
gh pr diff 456

# CI results for a PR
gh pr checks 456

# Search (repo-scoped and global)
gh search issues --repo owner/repo --state open "login bug"
gh search code --repo owner/repo "parseToken"
```

`gh issue list` and `gh pr list` cap at `--limit 30` by default. Raise `--limit` when you need completeness, but prefer filters (`--state`, `--label`, `--author`, `--search`) over pulling everything and filtering yourself.

## 4. Anything the subcommands do not cover

`gh api` reaches the whole REST and GraphQL API with the stored credential, so you never need `curl` or a hand-built token header.

```bash
# REST, with automatic pagination
gh api --paginate repos/owner/repo/issues?state=open

# Who am I?
gh api user -q .login

# GraphQL when REST would take several round trips
gh api graphql -f query='
  query { repository(owner:"owner", name:"repo") {
    pullRequests(states:OPEN, first:20) { nodes { number title reviewDecision } }
  } }'
```

## 5. Writing — treat as consequential

Creating or commenting on issues and PRs, merging, closing, and pushing are all visible to the user's collaborators and are hard to undo. Only do them when the task actually asked for them, and say what you did afterwards.

```bash
gh issue comment 123 --body "…"
gh issue create --title "…" --body "…" --label bug
gh pr review 456 --comment --body "…"
```

Rules:

- **Never** `git push`, `gh pr create`, `gh pr merge`, or `gh release create` unless the user asked for that specific action.
- Prefer `--body-file` over a long inline `--body` so multi-line Markdown survives shell quoting intact.
- Do a read-only pass first. Confirm the issue or PR number you are about to write to actually matches what the user described.
- One comment, not several. If a first attempt appears to fail, verify with a read before retrying — a duplicate comment on someone's PR is worse than a missing one.

## 6. When GitHub is not connected

You are blocked on a missing credential, and the remedy is never a command the user types. Say something close to:

> No GitHub account is connected — open **Advanced → Connections → GitHub Account** and either sign in with your browser (approve a one-time code) or paste a personal access token.

Then stop. Both options store the credential inside this sandbox for `gh` to pick up.

Do **not**:

- offer `gh auth login` — this container has no interactive terminal, so it cannot complete;
- offer to set `GH_TOKEN`, or ask them to paste a token into the chat — the chat transcript is not a credential store;
- treat an internal-sounding org as a different host. `github.com/<org>/...` is public GitHub however private the org is, and needs a connected account with access, not a `--hostname` sign-in. SuperClaw connects github.com only, so if the work genuinely is on a GitHub Enterprise host, say that plainly rather than improvising a login command;
- fall back to a web search for data that lives behind the API. Private and internal repos return nothing, so at best you waste a turn and at worst you present a public look-alike as the user's repo;
- report a generic failure. "I can't reach GitHub" is unhelpful; the sentence above is actionable.

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `gh: command not found` | Stale backend image. Fall back to GitHub MCP if connected, otherwise tell the user to update SuperClaw. |
| `HTTP 401` / `Bad credentials` | Token revoked or expired. Ask the user to reconnect in Settings. |
| `HTTP 403` with a scope message | The token lacks a scope (commonly `repo` for private repos, `read:org` for org data, `read:project` for Projects boards). Report which scope is missing so the user can reconnect with it. |
| `refusing to allow an OAuth App to create or update workflow` on push | Expected, not a bug. Browser sign-in deliberately requests `repo`, `read:org`, and `read:project` only, so a commit touching `.github/workflows/**` is rejected; `gh auth status` shows whether the credential has `workflow` at all. Do not retry. Either (a) drop the workflow files from the commit — `git restore --source=HEAD~1 -- .github/workflows && git commit --amend --no-edit` — push the rest, and say plainly that the workflow edits were left out and why, or (b) tell the user to reconnect with a PAT carrying `workflow` scope. Never rewrite history beyond the commit you just made, and always say which option you took. |
| `HTTP 404` on a repo you expect to exist | Usually a private repo the token cannot see, or a typo'd `owner/repo`. Verify with `gh repo view -R owner/repo` before assuming it is gone. |
| `could not determine base repository` | You are outside a git repo, or the remote is not GitHub. Pass `-R owner/repo`. |
| `HTTP 429` / rate limit | Stop, report it, and do not retry in a loop. `gh api rate_limit` shows the reset time. |

Read a failure as information, not as something to retry past. Two identical failing calls mean the approach is wrong, not that the third will work.
