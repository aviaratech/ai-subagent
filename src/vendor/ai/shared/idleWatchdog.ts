/**
 * Bounds silence from a long-running child process. Call `reset()` on every
 * stdout/stderr chunk (proof of life) and `clear()` when the process settles.
 * If `idleTimeoutMs` elapses with no `reset()`, `onIdle` fires exactly once.
 *
 * Disabled (every method a no-op) when `idleTimeoutMs` is undefined or <= 0, so
 * callers that do not opt into an idle budget are unaffected.
 *
 * Timers are injectable so unit tests can drive time without real waits. This is
 * the single source for future idle watchdogs; the pre-existing copies in
 * launch.ts and ptySpawner.ts are intentionally left in place.
 *
 * Internal to the provider runtime — imported directly by the session classes, not
 * re-exported from the package's public barrel, so its absence from `index.ts`
 * is deliberate.
 */
export interface IdleWatchdog {
  /** Cancel any pending idle timer (call when the process exits/settles). */
  clear(): void;
  /** Restart the idle countdown (call on each child stdout/stderr chunk). */
  reset(): void;
}

export function createIdleWatchdog(options: {
  clearTimer?: typeof clearTimeout;
  idleTimeoutMs: number | undefined;
  onIdle: () => void;
  setTimer?: typeof setTimeout;
}): IdleWatchdog {
  const idleTimeoutMs = options.idleTimeoutMs;
  if (idleTimeoutMs === undefined || idleTimeoutMs <= 0) {
    return { clear: () => {}, reset: () => {} };
  }

  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  let handle: NodeJS.Timeout | undefined;
  let fired = false;

  const clear = (): void => {
    if (handle !== undefined) {
      clearTimer(handle);
      handle = undefined;
    }
  };

  const reset = (): void => {
    if (fired) {
      return;
    }
    clear();
    handle = setTimer(() => {
      handle = undefined;
      // Defensive: the outer reset() guard already prevents re-scheduling after a
      // fire, so this is belt-and-suspenders against a future refactor.
      if (fired) {
        return;
      }
      fired = true;
      options.onIdle();
    }, idleTimeoutMs);
    // Do not keep the event loop alive solely for this timer.
    unrefTimer(handle);
  };

  return { clear, reset };
}

function unrefTimer(handle: NodeJS.Timeout): void {
  const candidate: unknown = handle;
  if (typeof candidate !== 'object' || candidate === null || !('unref' in candidate)) {
    return;
  }
  const { unref } = candidate;
  if (typeof unref === 'function') {
    unref.call(candidate);
  }
}
