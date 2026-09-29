import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { invokeBot } from './bot-executor.ts';
import { readPidMarker, waitForPidMarker } from '../test-support/pid-marker.ts';

function executable(t: TestContext, body: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bot-executor-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'definition');
  writeFileSync(file, `#!${process.execPath}\n${body}`, { mode: 0o700 });
  return { dir, file };
}

test('bot executor passes only fixed arguments, preserves UTF-8 across chunks and withholds server secrets', async t => {
  const { dir, file } = executable(t, `
    let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
      const value=JSON.stringify({text:'Caffè ☕',request:JSON.parse(input),argv:process.argv.slice(2),cwd:process.cwd(),secret:process.env.BOT_EXECUTOR_TEST_SECRET??null});
      const bytes=Buffer.from(value), split=bytes.indexOf(Buffer.from('è'))+1;
      process.stdout.write(bytes.subarray(0,split),()=>setTimeout(()=>process.stdout.end(bytes.subarray(split)),20));
    });`);
  const old = process.env.BOT_EXECUTOR_TEST_SECRET;
  process.env.BOT_EXECUTOR_TEST_SECRET = 'private-test-value';
  t.after(() => { if (old === undefined) delete process.env.BOT_EXECUTOR_TEST_SECRET; else process.env.BOT_EXECUTOR_TEST_SECRET = old; });
  const request = { tool: 'status', arguments: { text: '$(not-a-command)' } };
  const result = await invokeBot(file, dir, request) as Record<string, unknown>;
  assert.equal(result.text, 'Caffè ☕');
  assert.deepEqual(result.request, request);
  assert.deepEqual(result.argv, ['invoke', '--home', dir]);
  assert.equal(result.cwd, realpathSync(dir));
  assert.equal(result.secret, null);
});

test('bot executor rejects invalid/oversized output and never leaks failure diagnostics', async t => {
  for (const body of [
    "process.stderr.write('private-token');process.exit(1);",
    "process.stdout.write('private-token');",
    "process.stdout.write('x'.repeat(65537));",
  ]) {
    const { dir, file } = executable(t, body);
    await assert.rejects(invokeBot(file, dir, {}), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /receipt|outcome may be unknown/);
      assert.ok(!error.message.includes('private-token'));
      return true;
    });
  }
  await assert.rejects(invokeBot('/not-an-executable', '/not-a-profile', { value: 'x'.repeat(65536) }), /exceeds 64 KiB/);
});

test('bot deadline settles even when a detached descendant keeps output pipes open', { timeout: 10000 }, async t => {
  const { dir, file } = executable(t, `
    const {spawn}=require('node:child_process'),path=require('node:path');
    const ready=path.join(process.argv[4],'ready');
    const child=spawn(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],String(process.pid)+String.fromCharCode(10));setTimeout(()=>process.exit(0),15000)",ready],{detached:true,stdio:['ignore',1,2]});
    child.unref();
  `);
  let descendant: number | undefined;
  const marker = path.join(dir, 'ready');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = invokeBot(file, dir, {});
  const rejected = assert.rejects(result, /outcome may be unknown/);
  // Observe early failures while readiness is pending; the awaits below still assert the result.
  void rejected.catch(() => {});
  try {
    descendant = await waitForPidMarker(marker);
    t.mock.timers.tick(30001);
    await rejected;
    process.kill(descendant, 0); // Rejection must precede the fixture's safety exit.
  } finally {
    // A failed readiness/assertion must not leave the deadline frozen or an orphan alive.
    t.mock.timers.tick(30001);
    const pid = descendant ?? readPidMarker(marker);
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
    await rejected;
  }
});
