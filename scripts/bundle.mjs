import { build } from 'esbuild';
import { chmodSync, writeFileSync } from 'node:fs';

const bundle = new URL('../dist/mcp-server.bundle.js', import.meta.url);
const launcher = new URL('../dist/mcp-launcher.js', import.meta.url);

await build({
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  bundle: true,
  entryPoints: [new URL('../dist/mcp-server.js', import.meta.url).pathname],
  external: ['node:*', 'node-pty'],
  format: 'esm',
  ignoreAnnotations: true,
  logOverride: { 'package.json': 'silent' },
  minify: false,
  outfile: bundle.pathname,
  platform: 'node',
  target: 'node24',
});

writeFileSync(
  launcher,
  `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundle = join(dirname(fileURLToPath(import.meta.url)), 'mcp-server.bundle.js');
const child = spawn(process.execPath, [bundle], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}
child.once('error', error => {
  console.error(error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 143);
});
`,
);
chmodSync(launcher, 0o755);
