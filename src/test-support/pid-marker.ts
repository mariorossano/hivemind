import { readFileSync } from 'node:fs';

// Capture real timers before a deadline test replaces the globals with mock timers.
const schedule = setTimeout;

/** A newline commits the complete PID; an existing/partially written file is not readiness. */
export function readPidMarker(file: string): number | undefined {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!/^\d+\n$/.test(text)) return undefined;
  const pid = Number(text);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid fixture PID');
  return pid;
}

/** Bounded even with a mocked clock, and independent of platform-specific fs.watch events. */
export async function waitForPidMarker(file: string, timeoutMs = 5000): Promise<number> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const pid = readPidMarker(file);
    if (pid !== undefined) return pid;
    if (performance.now() >= deadline) throw new Error('Fixture PID readiness timed out');
    await new Promise<void>(resolve => schedule(resolve, 10));
  }
}
