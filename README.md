# ai-subagent

> **WIP · experimental · not production-ready.** The predecessor implementation
> never worked reliably. This public extraction has packaging and deterministic
> contract tests; it has no certified end-to-end provider lifecycle. Do not use
> it as a required review, delivery, or production control.

ai-subagent is an opt-in MCP plugin for provider-backed child sessions. It
exposes `spawn_agent`, `send_input`, `wait_agent`, `resume_agent`, and
`close_agent`. Its current source includes Codex, Claude, and Grok adapters and
role presets for builder, reviewer, explorer, ask, and default children.
Availability of those code paths is **not** evidence that they work reliably
on a given host.

## What is verified

The repository CI builds and typechecks the source, runs deterministic
`node:test` suites, bundles the MCP server, checks the public payload for
known private references, installs a tarball into a clean temporary directory,
and discovers the five tools over MCP stdio. These checks exercise packaging
and local contracts. They do not launch a provider, test authentication, or
prove spawn, resume, cancellation, and cleanup across every provider.

## Known limitations

- The earlier private plugin was unreliable. Specific failures and provider
  versions are not yet characterized by repeatable public fixtures.
- Codex, Claude, and Grok child lifecycles remain unverified in a clean external
  host. Authentication, capacity, stream completion, resume, and cleanup can
  fail. The adapter reports those failures and does not silently change models.
- Grok requires its native CLI and an interactive local host. It is unavailable
  in CI, containers, and remote server environments.
- The public plugin denies recursive calls to itself. It does not impose a
  repository-specific permission policy on other MCP tools; the host and user
  must select and constrain tools appropriate for their environment.
- The included model catalog is a snapshot. New host models or effort levels
  require a reviewed catalog update.
- Existing local sessions from any predecessor installation are not migrated.
  The public plugin stores its own state under
  `~/.local/share/ai-subagent/`.
- Superpowers role skills must be installed separately. Missing or changed
  required skill references fail before child launch.

Please use [GitHub issues](https://github.com/aviaratech/ai-subagent/issues)
for generic, reproducible failures. Never attach credentials, private prompts,
provider transcripts, or business data.

## Install from a clean checkout

Use Node 24.21.0 or newer within the Node 24 line and npm 11.19.0.

```sh
git clone https://github.com/aviaratech/ai-subagent.git
cd ai-subagent
npm ci
npm run checks
```

Point an MCP host at the resulting absolute launcher path:

```json
{
  "mcpServers": {
    "ai-subagent": {
      "command": "node",
      "args": ["/absolute/path/to/ai-subagent/dist/mcp-launcher.js"]
    }
  }
}
```

Installing the plugin is an explicit choice. It is not installed or enabled by
another package. Keep native delegation and review available as the supported
route while this plugin remains experimental.

For a packaged installation:

```sh
npm pack
mkdir -p /tmp/ai-subagent-consumer
npm install --prefix /tmp/ai-subagent-consumer ./aviaratech-ai-subagent-0.1.0.tgz
```

Then point the MCP host at
`/tmp/ai-subagent-consumer/node_modules/@aviaratech/ai-subagent/dist/mcp-launcher.js`.
The package includes the plugin manifest, MCP declaration, skills, compiled
source, and standalone bundle. No private workspace symlink is needed.

## Development and release

```sh
npm ci
npm run typecheck
npm test
npm run bundle
npm run safety:check
npm run pack:smoke
```

The `checks` script runs these with formatting and lint. A release is built
from a reviewed public commit: run `npm ci && npm run checks`, inspect
`npm pack --dry-run --json`, tag the verified commit, and attach the resulting
`npm pack` archive to its release. Do not describe that archive as a reliable
provider implementation. npm registry publication, if chosen later, requires
a separate release decision and credentials.

## Data and security

The plugin inherits provider authentication from the host. It never asks for
credentials through MCP. `OPENROUTER_API_KEY` is needed only for an explicit
OpenRouter model selection. Telemetry uses owner-only local JSONL files with
14-day retention and omits prompts, provider output, credentials, and raw
transcripts. Child provider logs and transcripts can still contain sensitive
content; handle them under the host's ordinary data policy.

`close_agent` is destructive for the selected child session. A host shutdown
suspends a resumable child when the provider supports it; test this behavior in
your own environment before relying on it.
