import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { validateSubagentProjectRoot } from './projectRoot.js';

void test('accepts any existing directory and canonicalizes aliases', () => {
  const cleanupRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ai-subagent-project-root-')));
  const projectRoot = join(cleanupRoot, 'project');
  const nestedRoot = join(projectRoot, 'nested');
  const aliasRoot = join(cleanupRoot, 'alias');
  try {
    mkdirSync(nestedRoot, { recursive: true });
    symlinkSync(projectRoot, aliasRoot);

    assert.strictEqual(validateSubagentProjectRoot(projectRoot), projectRoot);
    assert.strictEqual(validateSubagentProjectRoot(nestedRoot), nestedRoot);
    assert.strictEqual(validateSubagentProjectRoot(aliasRoot), projectRoot);
  } finally {
    rmSync(cleanupRoot, { force: true, recursive: true });
  }
});

void test('rejects missing paths and regular files', () => {
  const cleanupRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ai-subagent-invalid-project-root-')));
  const filePath = join(cleanupRoot, 'file.txt');
  try {
    writeFileSync(filePath, 'fixture\n', 'utf8');

    assert.throws(() => validateSubagentProjectRoot(join(cleanupRoot, 'missing')), /invalid_subagent_project_root/u);
    assert.throws(() => validateSubagentProjectRoot(filePath), /invalid_subagent_project_root/u);
  } finally {
    rmSync(cleanupRoot, { force: true, recursive: true });
  }
});
