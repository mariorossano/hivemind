import type { WaitResult } from "../shared/types.ts";

const FATAL = /join first|no token|HTTP 401|HTTP 403|HTTP 404/i;

export function isTransientWaitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (FATAL.test(msg)) return false;
  return true;
}

export async function waitUntilMail(
  callWait: () => Promise<WaitResult>,
  opts: { delay?: (ms: number) => Promise<void>; retryDelayMs?: number } = {},
): Promise<WaitResult> {
  const delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retryDelayMs = opts.retryDelayMs ?? 1500;
  for (;;) {
    try {
      const result = await callWait();
      if (!result.idle) return result;
    } catch (err) {
      if (!isTransientWaitError(err)) throw err;
      await delay(retryDelayMs);
    }
  }
}
