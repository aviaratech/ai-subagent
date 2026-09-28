---
name: builder
description: Use when delegating scoped implementation or code-build tasks to an ai-subagent builder
---

# Builder

This is an experimental plugin; provider lifecycles remain unverified. Read the
repository README before relying on it for a task.

The builder preset is an implementation child. Its default and
supported effort come from the generated
[model policy snapshot](../../dist/vendor/ai/shared/modelPolicy.js). `worker`
is a compatibility alias. Any active registered model may be selected
explicitly; provider failures never trigger another model.

```jsonc
spawn_agent({
  "agent_type": "builder",
  "model": "<optional-active-model-id>",
  "project_root": "/path/to/repository-or-worktree",
  "message": "Implement <scope>. Stay within <files/areas>. Run <checks>. Do not publish or merge."
})
```

Give the builder the intended scope, acceptance criteria, relevant context, and
checks to run. The parent owns user consent, workspace choice, diff review,
commits, publication, and merge unless the current task explicitly delegates
one of those actions.

The child starts with role-scoped Superpowers and uses TDD, systematic
debugging, verification, and branch-finishing guidance when applicable. It may
read/edit the canonical repository or worktree and run repository tests, builds,
typechecks, lint, Git commands, web tools, and configured MCP tools. The Grok
adapter does not add a sandbox, command allowlist, or role-specific permission
matrix; repository instructions and the parent task define the same behavioral
boundaries as a full-access native subagent. The plugin blocks recursive calls
to its own MCP namespace. It does not impose a policy on other MCP tools;
the parent and host must constrain them. Other command, publication, and
operational boundaries come from the parent task and repository instructions.
Nested delegation remains unavailable.

Poll with `timeout_ms: 0` and `include_output: false` to observe sanitized
in-progress `progress` without consuming terminal output. The numeric progress
fields are `activityCount`, `elapsedMs`, `firstActivityAtMs`, `idleMs`,
`lastActivityAtMs`, `receivedBytes`, and `startedAtMs`; they expose aggregate
timing and byte counts only, never prompt text, provider output, stream content,
provider stderr, or transcripts. ai-subagent never applies a child deadline and
a polling timeout does not cancel the child; the parent uses `close_agent` when
it needs to stop it. Collect terminal output once. Use `send_input` for missing
context or a correction in the same provider conversation. After an MCP or
parent-host restart, call `resume_agent({ id })` first, then `send_input`.
Progress activity means the provider is working; `idleMs` is context for the
parent, not a failure verdict. An in-progress `processOutcome` means the
provider process has ended and terminal handling is settling. On a
provider-owned incomplete or error turn, preserve the child id and verify
worktree edits, then use a focused same-session continuation or explicit
provider fallback before closing. After a completed turn, finish by inspecting
the diff, rerunning parent-owned checks, and calling `close_agent`. Host
shutdown suspends local work while preserving the provider conversation; only
`close_agent` destroys its resume token, so retain the id until the parent has
deliberately finished with the builder.

If `terminalCause` is `grok_usage_balance_exhausted` and
`providerTerminalStatus` is `http_402`, the provider launched successfully but
the current allowance is unavailable. Preserve the evidence and worktree,
then choose an explicit fallback or wait for an allowance change; an unchanged
retry cannot succeed.
