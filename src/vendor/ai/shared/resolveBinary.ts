import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export function resolveBinaryPath(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (command.length === 0) {
    return command;
  }

  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return command;
  }

  const pathValue = env.PATH ?? '';
  const segments = pathValue.split(delimiter).filter(segment => segment.length > 0 && isAbsolute(segment));
  const extensions = resolveExtensions(env);

  for (const segment of segments) {
    for (const extension of extensions) {
      const candidate = join(segment, `${command}${extension}`);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  return command;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExtensions(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') {
    return [''];
  }

  const pathExt = env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM';
  return pathExt
    .split(';')
    .map(ext => ext.trim())
    .filter(ext => ext.length > 0)
    .map(ext => (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`));
}
