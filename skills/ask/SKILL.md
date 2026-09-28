---
name: ask
description: Use when asking a bounded design question, sanity check, or second opinion through an ai-subagent
---

# Ask

This is an experimental plugin; provider lifecycles remain unverified. Read the
repository README before relying on it for a task.

The ask preset is a focused second-opinion child. Its model default comes from
the bundled [model policy snapshot](../../dist/vendor/ai/shared/modelPolicy.js),
and callers may select any active registered model and compatible effort.

The parent decides whether to delegate. A spawn starts one child immediately;
ai-subagent does not add an approval or issue-workflow round trip.

```jsonc
spawn_agent({
  "agent_type": "ask",
  "model": "<optional-active-model-id>",
  "project_root": "/path/to/repository-or-worktree",
  "message": "Question: <bounded question>. Context: <only what matters>. Answer directly and name uncertainty."
})
```

The child loads `using-superpowers` and then brainstorming or systematic
debugging when applicable. It uses native provider authority under the parent
task and working directory, and cannot delegate again.

Use `wait_agent({ targets, timeout_ms: 0, include_output: false })` to inspect
sanitized in-progress `progress` without consuming terminal output. The
numeric progress fields are `activityCount`, `elapsedMs`, `firstActivityAtMs`,
`idleMs`, `lastActivityAtMs`, `receivedBytes`, and `startedAtMs`; they contain
no prompt, response, stream, stderr, or transcript content. ai-subagent never
applies a child deadline; an observational wait timeout never stops the child.
Keep the returned id. Use `send_input` for a follow-up in the same conversation;
after an MCP or parent-host restart, use `resume_agent({ id })` before that
follow-up. Activity growth means the provider is working. `idleMs` is context,
not an automatic failure; an in-progress `processOutcome` means its process
has ended and terminal handling is settling. A host disconnect suspends local
work and preserves the native conversation for `resume_agent`; do not call
`close_agent` unless the parent has decided that conversation is finished.
Treat the ask as complete when `wait_agent` returns `completed` with a direct
answer. Summarize its answer and uncertainty, then `close_agent`; use
`close_agent` when the parent needs to stop the child. On a provider-owned
incomplete or error turn, preserve the child id and available evidence. Verify
whether the ask is answered, then use a focused same-session continuation or
explicit provider fallback before closing. Close after recovery finishes or
the parent deliberately abandons the resumable conversation.

If `terminalCause` is `grok_usage_balance_exhausted` and
`providerTerminalStatus` is `http_402`, the provider launched successfully but
the current allowance is unavailable. Preserve the evidence and choose an
explicit fallback or wait for an allowance change; an unchanged retry cannot
succeed.

Use `reviewer` for pre-PR code review and `builder` for implementation.
