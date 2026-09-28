import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), 'ai-subagent-package-smoke-'));
let client;
try {
  const archiveJson = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const archive = join(temp, JSON.parse(archiveJson)[0].filename);
  const install = join(temp, 'external');
  execFileSync('npm', ['install', '--ignore-scripts', '--prefix', install, archive], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  const packageRoot = join(install, 'node_modules', '@aviaratech', 'ai-subagent');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.private !== false || manifest.name !== '@aviaratech/ai-subagent') {
    throw new Error('Installed package metadata does not identify the public plugin');
  }
  for (const skillName of readdirSync(join(packageRoot, 'skills'))) {
    const skillPath = join(packageRoot, 'skills', skillName, 'SKILL.md');
    const skill = readFileSync(skillPath, 'utf8');
    for (const [, reference] of skill.matchAll(/\]\((\.\.\/[^)]+)\)/gu)) {
      if (!existsSync(resolve(dirname(skillPath), reference))) {
        throw new Error(`Packaged skill reference is missing: ${skillName} -> ${reference}`);
      }
    }
  }
  client = new Client({ name: 'package-smoke', version: '0.1.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(packageRoot, 'dist', 'mcp-launcher.js')],
      cwd: install,
    }),
  );
  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name).sort();
  const expected = ['close_agent', 'resume_agent', 'send_input', 'spawn_agent', 'wait_agent'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Packaged MCP tools mismatch: ${JSON.stringify(names)}`);
  }
  console.log(`Clean package install and MCP discovery passed: ${names.join(', ')}`);
} finally {
  await client?.close();
  rmSync(temp, { recursive: true, force: true });
}
