---
name: code-workflow
description: Use when orchestrating non-trivial code work with provider-backed ai-subagents
---

# Code Workflow

This is an experimental plugin; provider lifecycles remain unverified. Read the
repository README before relying on it for a task.

Use ai-subagent like a native child lifecycle when cross-provider delegation is
useful. Installation does not require delegation. The parent owns consent,
scope, repository workflow, findings, checks, publication, and merge.

Roles are presets behind one tool:

```jsonc
spawn_agent({
  "agent_type": "builder",
  "model": "<optional-active-model-id>",
  "project_root": "/path/to/worktree",
  "message": "Implement the scoped change and run its focused checks."
})
```

Use `ask` for bounded questions, `builder` for implementation, and `reviewer`
for review. Every active registered model is available
to every role; the plugin maps it to the canonical provider CLI.

Save the returned id and poll with `wait_agent({ "targets": ["<id>"],
"timeout_ms": 0, "include_output": false })`. A wait is observational: it
never sets or enforces a child deadline. Read `progress` as health evidence:
growing activity/bytes or an advancing last-activity time means the provider is
working; `idleMs` is a parent decision input, not a failure. An in-progress
`processOutcome` means the provider process ended and final validation or
cleanup is settling, so wait for the terminal result rather than duplicating
the task.

Use `send_input` for a correction or follow-up in the same provider
conversation. If the MCP server or parent host restarted, use
`resume_agent({ "id": "<id>" })` and then `send_input`; do not respawn merely
to continue context. The parent alone decides when to use `close_agent` to
stop a child. Host shutdown suspends local work and preserves the provider
conversation, while `close_agent` destroys its resume token. Collect terminal
output once, apply or reject the result deliberately, and close every child
only after it no longer needs to be resumed. A child cannot delegate again by
default.

If `terminalCause` is `grok_usage_balance_exhausted` and
`providerTerminalStatus` is `http_402`, the provider launched successfully but
the current allowance is unavailable. Preserve the evidence and choose an
explicit fallback or wait for an allowance change; an unchanged retry cannot
succeed.

The parent supplies the working directory and task scope. The plugin accepts
any existing directory, canonicalizes it, and uses the provider's native
autonomous launch mode. Repository policy may still direct the parent to choose
an isolated worktree, but ai-subagent does not enforce or inspect that workflow.
