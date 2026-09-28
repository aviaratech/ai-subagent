import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSubagentRuntimeEnv } from './runtimeEnv.js';

void describe('ai-subagent runtime env', () => {
  void it('preserves the complete parent environment for provider-native child sessions', () => {
    const { forwardEnv, runtimeEnv } = buildSubagentRuntimeEnv({
      env: {
        AI_AGENT_IDENTITY: 'gpt-builder',
        EXAMPLE_CLOUD_PROFILE: 'operator-profile',
        CLAUDE_CONFIG_DIR: '/native/claude',
        CODEX_HOME: '/native/codex',
        EXAMPLE_DATABASE_ENDPOINT: 'db.example.test',
        GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_test',
        GROK_HOME: '/native/grok',
        HOME: '/home/example',
        LANG: 'en_US.UTF-8',
        OPENROUTER_API_KEY: 'openrouter-test-key',
        PATH: '/bin',
        TERM: 'xterm-256color',
        TMPDIR: '/var/folders/test',
      },
    });

    assert.strictEqual(forwardEnv.OPENROUTER_API_KEY, 'openrouter-test-key');
    assert.strictEqual(forwardEnv.AI_AGENT_IDENTITY, 'gpt-builder');
    assert.strictEqual(forwardEnv.CLAUDE_CONFIG_DIR, '/native/claude');
    assert.strictEqual(forwardEnv.CODEX_HOME, '/native/codex');
    assert.strictEqual(forwardEnv.GROK_HOME, '/native/grok');
    assert.strictEqual(forwardEnv.HOME, '/home/example');
    assert.strictEqual(forwardEnv.LANG, 'en_US.UTF-8');
    assert.strictEqual(typeof forwardEnv.PATH, 'string');
    assert.strictEqual(forwardEnv.TERM, 'xterm-256color');
    assert.strictEqual(forwardEnv.TMPDIR, '/var/folders/test');
    assert.strictEqual(forwardEnv.GITHUB_PERSONAL_ACCESS_TOKEN, 'ghp_test');
    assert.strictEqual(forwardEnv.EXAMPLE_CLOUD_PROFILE, 'operator-profile');
    assert.strictEqual(forwardEnv.EXAMPLE_DATABASE_ENDPOINT, 'db.example.test');
    assert.strictEqual(runtimeEnv.GITHUB_PERSONAL_ACCESS_TOKEN, 'ghp_test');
  });
});
