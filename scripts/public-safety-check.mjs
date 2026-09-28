import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const scanned = ['src', 'dist', 'skills', '.claude-plugin', 'README.md', '.mcp.json', 'package.json'];
const forbidden = [
  /\bai-(?!subagents?\b)[a-z][a-z0-9-]*\b/iu,
  /\/\.secrets\//u,
  /\/Users\/[^/]+\//u,
  /AWS_PROFILE|DB_HOST|DB_USER|DB_NAME/iu,
  /ISSUE_CLI_/u,
];

function files(path) {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap(name => files(join(path, name)));
}

const findings = [];
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const value of Object.values({
  ...(manifest.dependencies ?? {}),
  ...(manifest.devDependencies ?? {}),
})) {
  if (typeof value === 'string' && value.startsWith('workspace:')) {
    findings.push('package.json: private workspace dependency');
  }
}
for (const target of scanned) {
  for (const file of files(join(root, target))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      for (const pattern of forbidden) {
        if (pattern.test(lines[index])) {
          findings.push(`${file.slice(root.length)}:${index + 1}: ${pattern}`);
        }
      }
    }
  }
}
if (findings.length > 0) {
  console.error(findings.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Public source safety check passed');
}
