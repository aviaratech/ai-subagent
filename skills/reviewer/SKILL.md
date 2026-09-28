---
name: reviewer
description: Use when requesting a provider-backed code, plan, or diff review through ai-subagent lifecycle tools
---

# Reviewer

This is an experimental plugin; provider lifecycles remain unverified. Read the
repository README before relying on it for a task.

The reviewer preset is a focused review child. Its default and effort come
from the bundled [model policy snapshot](../../dist/vendor/ai/shared/modelPolicy.js),
and the caller may select any active registered model. Capacity or auth failure
is surfaced with exact attribution and never silently downgraded.

```jsonc
spawn_agent({
  "agent_type": "reviewer",
  "model": "<optional-active-model-id>",
  "project_root": "/path/to/repository-or-worktree",
  "message": "Review the current diff against its stated intent. Lead with bugs, contract breaks, missing tests, and acceptance failures. End with VERDICT: approve | request-changes."
})
```

The child loads `using-superpowers` and verification guidance, uses native
provider authority under the parent task, and does not recursively request
another review.

The response must end with exactly one terminal line:

```text
VERDICT: approve | request-changes
```

Missing or malformed verdicts fail closed as request-changes. `approve` means
no blocking findings remain. The parent owns remediation and any separate
GitHub review, PR, or merge action; raw transcript logs are opaque evidence and
are never the review body. Poll with `wait_agent` using `timeout_ms: 0` and
`include_output: false` when checking health; that is an observation only, not
a child deadline. Keep the returned id so a restarted parent can
`resume_agent({ id })` before requesting a follow-up in the same conversation.
Host shutdown preserves that native conversation; only explicit `close_agent`
destroys its resume token after the parent has recorded the review outcome.
