---
name: local-safety-guard
description: Use this skill to prevent destructive operations when working on production systems or running agents autonomously. Detects dangerous shell commands, restricts file edits to safe directories, and enforces confirmation before irreversible actions.
---

# Safety Guard — Prevent Destructive Operations

## When to Use

- When working on production systems
- When agents are running autonomously
- When you want to restrict edits to a specific directory
- During sensitive operations (migrations, deploys, data changes)

## Destructive Command Detection

Before executing any shell command, check for these dangerous patterns and **refuse or warn** before proceeding:

| Pattern | Risk | Safer Alternative |
|---------|------|-------------------|
| `rm -rf /`, `rm -rf ~`, `rm -rf .` | Catastrophic data loss | Use targeted paths, confirm interactively |
| `git push --force` | Overwrites remote history | Use `--force-with-lease` |
| `git reset --hard` | Discards uncommitted work | Use `git stash` first |
| `git checkout .` | Discards all local changes | Review changes before discarding |
| `DROP TABLE` / `DROP DATABASE` | Irreversible data loss | Use backups, confirm explicitly |
| `docker system prune` | Removes all unused resources | Use selective prune with filters |
| `kubectl delete` | Destroys cluster resources | Dry-run first: `--dry-run=client` |
| `chmod 777` | Removes all file protections | Use least-privilege permissions |
| `sudo rm` | Elevated destructive action | Confirm path carefully |
| `npm publish` | Publishes package publicly | Use `--dry-run` first |
| `--no-verify` | Bypasses safety hooks | Run hooks, fix issues |
| `curl \| bash`, `wget \| sh` | Executes arbitrary remote code | Download first, inspect, then execute |
| `mv /etc/...`, `mv ~/.ssh/...` | Overwrites critical system/config files | Backup target first, confirm path |

**When a dangerous command is detected:**
1. Explain what the command does and what could go wrong
2. Ask the user for explicit confirmation before executing
3. Suggest a safer alternative where possible

## Directory Restriction

When told to focus on a specific directory, enforce these rules:

- **Read**: Allowed anywhere (needed for context)
- **Write/Edit**: Only within the specified directory tree
- **Shell commands**: Block commands that modify files outside the restricted directory

Example: If restricted to `src/api/`, block any file write to `src/components/` or `tests/` and explain why.

## Enforcement

Before every `bash` tool call, inspect the command string for destructive patterns:

1. **Check the command** against the patterns in the table above. Match substrings case-insensitively; also check for piped execution (`| bash`, `| sh`, `| zsh`), output redirects (`>`) to system paths, and `tee` targeting paths outside the allowed directory.
2. **If a match is found**, do NOT execute. Instead:
   - Print the matched pattern and explain the risk.
   - Suggest the safer alternative from the table.
   - Ask the user: "Do you want to proceed? (yes/no)"
   - Only execute if the user explicitly confirms.
3. **For directory-restricted sessions**, additionally check:
   - `write` / `edit` tool calls: reject if the target path is outside the restricted directory tree.
   - `bash` commands: scan for output targets (`>`, `>>`, `tee`, `mv`, `cp`) and reject if any target resolves outside the restricted directory.
4. **Log every block** — always tell the user what was prevented, which pattern matched, and why.

## Best Practices

1. **Always confirm** before running destructive commands — never auto-execute
2. **Prefer reversible actions** — `git stash` over `git checkout .`, backups before `DROP TABLE`
3. **Scope changes narrowly** — avoid broad glob patterns in destructive commands
4. **Log what you block** — explain to the user what was prevented and why
5. **Check twice, execute once** — review paths in `rm`, `mv`, and `cp` commands before running