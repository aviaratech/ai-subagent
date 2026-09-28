import type { ChildProcess } from 'node:child_process';

const DEFAULT_FORCE_KILL_GRACE_MS = 5000;
let forceKillGraceMs = DEFAULT_FORCE_KILL_GRACE_MS;

export function __resetSessionForceKillGraceMsForTesting(): void {
  forceKillGraceMs = DEFAULT_FORCE_KILL_GRACE_MS;
}

export function __setSessionForceKillGraceMsForTesting(ms: number): void {
  forceKillGraceMs = ms;
}

export function terminateProcessWithGrace(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    let exited = false;
    let forceKillHandle: NodeJS.Timeout | undefined;

    const finish = (): void => {
      if (exited) {
        return;
      }
      exited = true;
      if (forceKillHandle !== undefined) {
        clearTimeout(forceKillHandle);
        forceKillHandle = undefined;
      }
      proc.off('error', finish);
      proc.off('exit', finish);
      resolve();
    };

    proc.once('error', finish);
    proc.once('exit', finish);

    proc.kill('SIGTERM');
    forceKillHandle = setTimeout(() => {
      forceKillHandle = undefined;
      if (!exited) {
        proc.kill('SIGKILL');
      }
    }, forceKillGraceMs);
  });
}
