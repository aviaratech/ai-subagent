---
name: dispatching
description: Use when coordinating multiple independent provider-backed subagents for exploration, building, or review
---

# Dispatching

This is an experimental plugin; provider lifecycles remain unverified. Read the
repository README before relying on it for a task.

Use multiple ai-subagents only for independent tasks whose results the parent
can merge cleanly. The parent obtains any needed consent before spawning and
stays responsible for the combined scope and lifecycle.

Good fits are independent area investigations, parallel design checks, or
builder/reviewer sequencing. Avoid overlapping edits, child-to-child
coordination, and any child-owned publication or merge action.

```jsonc
spawn_agent({
  "agent_type": "explorer",
  "model": "<optional-active-model-id>",
  "project_root": "/path/to/repository-or-worktree",
  "message": "Inspect <area>. Report facts and risks. Do not edit."
})
```

Poll children together with `timeout_ms: 0` and `include_output: false`.
Observations never cancel a child. Compare progress activity and idle time to
choose whether to wait; an in-progress `processOutcome` means final handling is
settling after the provider process exited. Collect each terminal body once,
reconcile disagreements from repository evidence, and call `close_agent` for
every child. Completion means every spawned child is completed, failed, or
explicitly closed and the parent has chosen the next action. Persist every
child id until that decision: host shutdown preserves resumable provider
conversations, whereas `close_agent` intentionally destroys them.

If `terminalCause` is `grok_usage_balance_exhausted` and
`providerTerminalStatus` is `http_402`, the provider launched successfully but
the current allowance is unavailable. Preserve the evidence and choose an
explicit fallback or wait for an allowance change; an unchanged retry cannot
succeed.
