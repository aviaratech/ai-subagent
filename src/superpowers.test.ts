import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { renderSuperpowersBootstrap, resolveSuperpowersSkills } from './superpowers.js';

void describe('ai-subagent Superpowers skill bootstrap', () => {
  void it('keeps ask and builder recovery ahead of destructive close on incomplete provider turns', () => {
    const ask = readFileSync(new URL('../skills/ask/SKILL.md', import.meta.url), 'utf8');
    const builder = readFileSync(new URL('../skills/builder/SKILL.md', import.meta.url), 'utf8');

    assert.match(ask, /On a provider-owned\s+incomplete or error turn, preserve the child id and available evidence/u);
    assert.match(ask, /use a focused same-session continuation or\s+explicit provider fallback before closing/u);
    assert.match(
      builder,
      /On a\s+provider-owned incomplete or error turn, preserve the child id and verify\s+worktree edits/u,
    );
    assert.match(builder, /use a focused same-session continuation or explicit\s+provider fallback before closing/u);
  });

  void it('teaches every parent workflow to stop unchanged retries when Grok usage is exhausted', () => {
    const skills = ['ask', 'builder', 'code-workflow', 'dispatching'].map(name =>
      readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8'),
    );

    for (const skill of skills) {
      assert.match(skill, /grok_usage_balance_exhausted/u);
      assert.match(skill, /providerTerminalStatus.*http_402/su);
      assert.match(skill, /unchanged\s+retry/u);
      assert.match(skill, /allowance/u);
    }
  });

  void it('selects role-scoped builder skills and renders stable file references', () => {
    const root = createSkillRoot([
      'using-superpowers',
      'test-driven-development',
      'systematic-debugging',
      'verification-before-completion',
      'finishing-a-development-branch',
    ]);
    try {
      const skills = resolveSuperpowersSkills({
        agentType: 'builder',
        purpose: 'Debug the failure, implement the fix, and prepare the branch for merge.',
        skillRoots: [root],
      });

      assert.deepStrictEqual(skills.names, [
        'using-superpowers',
        'test-driven-development',
        'systematic-debugging',
        'verification-before-completion',
        'finishing-a-development-branch',
      ]);
      assert.ok(skills.references.every(reference => reference.startsWith(realpathSync(root))));
      assert.deepStrictEqual(
        skills.skills,
        skills.names.map((name, index) => ({
          digest: digest(`# ${name}\n`),
          name,
          reference: skills.references[index],
        })),
      );
      const bootstrap = renderSuperpowersBootstrap(skills);
      assert.match(bootstrap, /Read .*using-superpowers\/SKILL.md before acting\./u);
      assert.match(bootstrap, /Load these files directly with the Read tool; do not invoke a host Skill tool/u);
      assert.match(bootstrap, /Reading each listed SKILL.md is the invocation for this child/u);
      assert.match(bootstrap, /Do not invoke nested delegation/u);
      assert.doesNotMatch(bootstrap, /dispatching-parallel-agents/u);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  void it('uses read-only design and review selections without indiscriminately loading builder skills', () => {
    const root = createSkillRoot([
      'using-superpowers',
      'brainstorming',
      'systematic-debugging',
      'verification-before-completion',
    ]);
    try {
      const ask = resolveSuperpowersSkills({
        agentType: 'ask',
        purpose: 'Compare two design options.',
        skillRoots: [root],
      });
      const review = resolveSuperpowersSkills({
        agentType: 'reviewer',
        purpose: 'Review the changed contract.',
        skillRoots: [root],
      });

      assert.deepStrictEqual(ask.names, ['using-superpowers', 'brainstorming']);
      assert.deepStrictEqual(review.names, ['using-superpowers', 'verification-before-completion']);
      assert.equal(ask.names.includes('test-driven-development'), false);
      assert.equal(review.names.includes('test-driven-development'), false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  void it('fails before launch when a required installed skill is unavailable', () => {
    const root = createSkillRoot(['using-superpowers']);
    try {
      assert.throws(
        () =>
          resolveSuperpowersSkills({ agentType: 'builder', purpose: 'Implement the scoped task.', skillRoots: [root] }),
        /superpowers_skill_missing: test-driven-development/u,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  void it('rejects a symlinked SKILL.md reference', () => {
    const root = createSkillRoot(['using-superpowers']);
    try {
      const skillDirectory = join(root, 'test-driven-development');
      mkdirSync(skillDirectory, { recursive: true });
      symlinkSync(join(root, 'using-superpowers', 'SKILL.md'), join(skillDirectory, 'SKILL.md'));

      assert.throws(
        () => resolveSuperpowersSkills({ agentType: 'builder', purpose: 'Implement the task.', skillRoots: [root] }),
        /superpowers_skill_invalid: test-driven-development.*non-symlink/u,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  void it('rejects a non-regular SKILL.md reference', () => {
    const root = createSkillRoot(['using-superpowers']);
    try {
      mkdirSync(join(root, 'test-driven-development', 'SKILL.md'), { recursive: true });

      assert.throws(
        () => resolveSuperpowersSkills({ agentType: 'builder', purpose: 'Implement the task.', skillRoots: [root] }),
        /superpowers_skill_invalid: test-driven-development.*regular/u,
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  void it('rejects an unreadable SKILL.md reference', () => {
    const root = createSkillRoot(['using-superpowers', 'test-driven-development']);
    const reference = join(root, 'test-driven-development', 'SKILL.md');
    try {
      chmodSync(reference, 0o000);
      assert.throws(
        () => resolveSuperpowersSkills({ agentType: 'builder', purpose: 'Implement the task.', skillRoots: [root] }),
        /superpowers_skill_unreadable: test-driven-development/u,
      );
    } finally {
      chmodSync(reference, 0o600);
      rmSync(root, { force: true, recursive: true });
    }
  });
});

function createSkillRoot(names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-subagent-superpowers-'));
  for (const name of names) {
    const skillDirectory = join(root, name);
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(join(skillDirectory, 'SKILL.md'), `# ${name}\n`, 'utf8');
  }
  return root;
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
