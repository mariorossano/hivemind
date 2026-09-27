import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readPidMarker, waitForPidMarker } from './pid-marker.ts';

const schedule = setTimeout, cancel = clearTimeout;

test('PID readiness ignores missing, empty and partial writes even with mock timers enabled', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pid-marker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ready');
  assert.equal(readPidMarker(file), undefined);
  for (const text of ['', '12', '12x\n']) { writeFileSync(file, text); assert.equal(readPidMarker(file), undefined); }
  writeFileSync(file, '12');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timer = schedule(() => writeFileSync(file, '12345\n'), 30);
  t.after(() => cancel(timer));
  assert.equal(await waitForPidMarker(file), 12345, 'must not return the partial PID 12');
});

test('PID readiness rejects invalid completed PIDs and has a real deadline under mock timers', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pid-marker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ready');
  for (const text of ['0\n', '99999999999999999999\n']) {
    writeFileSync(file, text); assert.throws(() => readPidMarker(file), /Invalid fixture PID/);
  }
  writeFileSync(file, '');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await assert.rejects(waitForPidMarker(file, 20), /readiness timed out/);
});
