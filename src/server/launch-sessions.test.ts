import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Hive } from './hive.ts';
import { createApp } from './app.ts';
import { listRows, setAgentPresence } from './test-fixtures.ts';
import type { LaunchSettings } from '../shared/launch-settings.ts';

const uuid = '67d735d1-9e33-4a61-9645-a931afc97f2b';
const settings: LaunchSettings = { software: 'codex-work', model: 'fixture-model', effort: 'high', extraFlags: '--search',
  environment: { CODEX_HOME: '/fixture/work-profile' }, workspacePath: '/fixture/project', cdWorktree: true,
  passProject: true, adoptUntrusted: true, role: 'brain', seniority: null, focus: 'coord' };

function fixture(t: TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-tracked-launch-'));
  const file = path.join(dir, 'hive.db'), hive = new Hive(file), app = createApp(hive);
  t.after(async () => { await hive.adaptiveTopology.stop(); hive.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = hive.projects.listProjects()[0]!;
  const call = async (method: string, url: string, body?: unknown, token?: string, extraHeaders = {}) => {
    const response = await app.request(url, { method, headers: { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const prepare = async (software = 'codex-work', extra = {}) => {
    const result = await call('POST', '/api/ui/launch-prepare', { project: project.slug,
      settings: { ...settings, software }, ...extra });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const ticket = /hml_[a-f0-9]{64}/.exec(result.body.command)?.[0];
    assert.ok(ticket);
    return { ticket, command: String(result.body.command) };
  };
  const join = (ticket: string, extra = {}, token?: string) => call('POST', '/api/agent/join',
    { role: 'brain', project: project.slug, launchTicket: ticket, ...extra }, token);
  const capture = (ticket: string, sessionId = uuid) => call('POST', '/api/launch-session/capture', { sessionId }, ticket);
  return { hive, project, call, prepare, join, capture, file };
}

test('Human launch stores exact configuration, binds automatically, ignores model-reported settings and survives restart', async t => {
  const f = fixture(t), { ticket, command } = await f.prepare();
  assert.match(command, /hooks.SessionStart/);
  assert.doesNotMatch(command, /Include nativeSession=/);
  assert.equal((await f.join(ticket)).status, 409, 'no fabricated conversation when hook did not run');
  assert.equal(f.hive.identity.listAgents().filter(a => a.role === 'brain').length, 0);
  assert.equal((await f.capture(ticket)).status, 200);
  const joined = await f.join(ticket, { nativeSession: { software: 'claude', sessionId: null, model: 'wrong', effort: 'low' } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const agent = joined.body.agent;
  assert.deepEqual(f.hive.launchSessions.saved(agent.id), { settings, sessionId: uuid, captured: true });
  assert.equal(f.hive.identity.nativeSession(agent.id)!.software, 'codex');
  assert.equal((await f.join(ticket, { resume: agent.name }, joined.body.token)).status, 200);
  assert.equal((await f.join(ticket)).status, 409, 'reusing a pasted initial command never creates another identity');
  const rows = JSON.stringify(listRows(f.hive, 'launch_sessions'));
  assert.ok(!rows.includes(ticket) && !rows.includes('/fixture/work-profile'), 'ticket hashed and profile encrypted at rest');
  const context = await f.call('GET', `/api/ui/launch-context?project=${f.project.slug}`);
  assert.deepEqual(context.body.savedLaunches[agent.id].settings, settings);
  for (const endpoint of ['/api/ui/snapshot', '/api/agent/agents']) {
    const result = await f.call('GET', endpoint, undefined, endpoint.includes('/agent/') ? joined.body.token : undefined);
    assert.ok(!JSON.stringify(result.body).includes(uuid));
    assert.ok(!JSON.stringify(result.body).includes('/fixture/work-profile'));
  }
  const reopened = new Hive(f.file);
  try { assert.deepEqual(reopened.launchSessions.saved(agent.id), f.hive.launchSessions.saved(agent.id)); }
  finally { await reopened.adaptiveTopology.stop(); reopened.db.close(); }
});

test('Claude has an assigned exact UUID and Cursor captures create-chat output without model reporting', async t => {
  const f = fixture(t);
  const claude = await f.prepare('claude-work');
  const id = /--session-id '([^']+)'/.exec(claude.command)?.[1];
  assert.ok(id);
  const joined = await f.join(claude.ticket);
  assert.equal(joined.status, 200);
  assert.equal(f.hive.launchSessions.saved(joined.body.agent.id)!.sessionId, id);
  const cursor = await f.prepare('cursor-agent');
  assert.match(cursor.command, /cursor-agent --model fixture-model --search create-chat/);
  assert.match(cursor.command, /--resume "\$_hivemind_chat_id"/);
  assert.equal((await f.join(cursor.ticket)).status, 409);
  assert.equal((await f.capture(cursor.ticket, 'chat_fixture-123')).status, 200);
  const cursorJoin = await f.join(cursor.ticket);
  assert.equal(cursorJoin.status, 200);
  assert.equal(f.hive.identity.nativeSession(cursorJoin.body.agent.id)!.sessionId, 'chat_fixture-123');
});

test('resume is bound to the immutable employee/project; wrong IDs, reuse and foreign callbacks fail closed', async t => {
  const f = fixture(t), first = await f.prepare();
  await f.capture(first.ticket);
  const joined = await f.join(first.ticket), agent = joined.body.agent;
  const other = f.hive.identity.join({ role: 'brain', project: f.project.slug }).agent;
  setAgentPresence(f.hive, agent.id, { online: false, lastSeenAt: Date.now() - 300_000 });
  const next = await f.prepare('codex-work', { agentId: agent.id, native: true, sessionId: uuid });
  const stale = await f.prepare('codex-work', { agentId: agent.id, native: true, sessionId: uuid });
  assert.equal((await f.capture(next.ticket, '019b2800-1234-7000-8000-000000000002')).status, 409);
  assert.equal((await f.capture(next.ticket)).status, 200);
  assert.equal((await f.join(next.ticket, { resume: other.name })).status, 409);
  const count = f.hive.identity.listAgents().length;
  assert.equal((await f.join(next.ticket)).status, 409, 'no resume argument must roll the unintended new join back');
  assert.equal(f.hive.identity.listAgents().length, count);
  const resumed = await f.join(next.ticket, { resume: agent.name });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.agent.id, agent.id);
  await f.capture(stale.ticket);
  assert.equal((await f.join(stale.ticket, { resume: agent.name })).status, 409, 'an older prepared command cannot supersede a newer join');
  assert.equal((await f.join(first.ticket, { resume: agent.name }, resumed.body.token)).status, 409);
  assert.equal((await f.call('POST', '/api/launch-session/capture', { sessionId: uuid }, next.ticket,
    { origin: 'http://localhost' })).status, 403);
  assert.equal((await f.capture(`hml_${'f'.repeat(64)}`)).status, 409);
  assert.equal((await f.call('POST', '/api/ui/launch-prepare', { project: f.project.slug, settings }, resumed.body.token)).status, 403);
  const manual = await f.call('POST', '/api/agent/join', { role: 'brain', project: f.project.slug, resume: agent.name });
  assert.equal(manual.status, 200);
  assert.equal(f.hive.launchSessions.saved(agent.id), null, 'untracked replacement cannot restore a stale tracked conversation');
});

test('new launches do not overwrite saved settings until join; metadata never crosses projects', async t => {
  const f = fixture(t), initial = await f.prepare('claude-work'), joined = await f.join(initial.ticket);
  const agent = joined.body.agent, original = f.hive.launchSessions.saved(agent.id);
  setAgentPresence(f.hive, agent.id, { online: false, lastSeenAt: Date.now() - 300_000 });
  await f.prepare('codex-another', { agentId: agent.id });
  assert.deepEqual(f.hive.launchSessions.saved(agent.id), original);
  const side = f.hive.projects.createProject(f.hive.identity.getAgent('human'), { name: 'Side', slug: 'side' });
  assert.deepEqual((await f.call('GET', `/api/ui/launch-context?project=${side.slug}`)).body.savedLaunches, {});
  assert.equal((await f.call('POST', '/api/ui/launch-prepare', { project: side.slug, agentId: agent.id, settings })).status, 409);
  const pending = await f.prepare('claude-work');
  assert.equal((await f.join(pending.ticket, { project: side.slug })).status, 409);
});

test('tracked joins keep the selected project even when the prompt omits it, and normalize launch choices', async t => {
  const f = fixture(t);
  const side = f.hive.projects.createProject(f.hive.identity.getAgent('human'), { name: 'Side', slug: 'side' });
  const result = await f.call('POST', '/api/ui/launch-prepare', { project: side.slug,
    settings: { ...settings, software: 'claude-work', model: ' fixture-model ', effort: 'HIGH', passProject: false } });
  assert.equal(result.status, 200);
  const ticket = /hml_[a-f0-9]{64}/.exec(result.body.command)![0];
  const joined = await f.join(ticket, { project: null });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.agent.projectId, side.id);
  assert.equal(f.hive.launchSessions.saved(joined.body.agent.id)?.settings.model, 'fixture-model');
  assert.equal(f.hive.launchSessions.saved(joined.body.agent.id)?.settings.effort, 'high');
  assert.equal((await f.call('POST', '/api/ui/launch-prepare', { project: side.slug,
    settings: { ...settings, extraFlags: '--last' } })).status, 400);
});
