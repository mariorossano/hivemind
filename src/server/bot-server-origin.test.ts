import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hive } from './hive.ts';
import { startServer } from './serve.ts';
import { registerBotDefinition } from './bot-definitions.ts';

for (const proxied of [false, true]) {
  test(`bot lifecycle uses the listening origin (${proxied ? 'preserved-Host proxy' : 'direct HTTP'})`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hive-bot-origin-'));
    const hive = new Hive(path.join(dir, 'hive', 'hive.db'));
    const started = startServer({ port: 0, hive, telegram: false });
    let proxy: ReturnType<typeof createServer> | undefined;
    try {
      const port = await started.ready, backend = `http://127.0.0.1:${port}`;
      let browser = backend;
      if (proxied) {
        // Match Vite's changeOrigin:false: preserve Host and Origin, not just the path.
        proxy = createServer((req, res) => {
          const upstream = httpRequest({ hostname: '127.0.0.1', port, path: req.url,
            method: req.method, headers: req.headers }, response => {
            res.writeHead(response.statusCode!, response.headers);
            response.pipe(res);
          });
          upstream.on('error', () => { res.writeHead(502); res.end(); });
          req.pipe(upstream);
        });
        await new Promise<void>(resolve => proxy!.listen(0, '127.0.0.1', resolve));
        const address = proxy.address();
        assert.ok(address && typeof address === 'object');
        browser = `http://127.0.0.1:${address.port}`;
        assert.notEqual(browser, backend);
      }
      const human = hive.identity.getAgent('human'), project = hive.projects.listProjects()[0]!;
      const brain = hive.identity.join({ role: 'brain', project: project.slug });
      const pkg = path.join(dir, 'definition'); mkdirSync(pkg);
      writeFileSync(path.join(pkg, 'TOOLS.md'), 'Local fixture only.');
      writeFileSync(path.join(pkg, 'tool'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
let raw = ''; process.stdin.on('data', chunk => raw += chunk);
process.stdin.on('end', async () => {
  const input = JSON.parse(raw), home = process.argv[4];
  if (process.argv[2] === 'configure') {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(input.config));
    console.log(JSON.stringify({ configured: true }));
  } else if (input.tool === 'connect') {
    console.log(JSON.stringify({ connected: true }));
  } else {
    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    const response = await fetch(config.hiveUrl + '/api/ui/session', {
      method: 'POST', headers: { origin: config.hiveUrl, 'content-type': 'application/json' }
    });
    const cookieName = response.headers.get('set-cookie')?.split('=')[0];
    await response.body?.cancel();
    console.log(JSON.stringify({ tool: input.tool, status: response.status, cookieName }));
  }
});
`, { mode: 0o700 });
      const manifest = path.join(pkg, 'hivemind-bot.json');
      writeFileSync(manifest, JSON.stringify({ version: 1, kind: 'bot', id: 'fixture-bot', name: 'Fixture Bot',
        capabilities: ['publish', 'tools'], command: 'tool', instructions: 'TOOLS.md',
        tools: [{ name: 'status', description: 'Local status', effect: 'read', parameters: { version: 1, fields: [] } }] }));
      registerBotDefinition(hive.home, manifest);

      const bootstrap = await fetch(browser + '/api/ui/session', { method: 'POST',
        headers: { origin: browser, 'content-type': 'application/json' } });
      assert.equal(bootstrap.status, 200);
      const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
      await bootstrap.body?.cancel();
      const ui = async (route: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
        const response = await fetch(browser + '/api/ui' + route, { method,
          headers: { cookie, origin: browser, 'content-type': 'application/json', ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, data: await response.json() as any };
      };
      const catalog = `/projects/${project.slug}/bots/catalog/fixture-bot`;
      const settings = { enabled: true, values: {}, expectedRevision: 0 };
      // Forwarded headers must never choose the origin persisted for a local executable.
      const saved = await ui(catalog, 'PUT', settings, {
        forwarded: 'host=attacker.invalid;proto=https', 'x-forwarded-host': 'attacker.invalid',
        'x-forwarded-proto': 'https', 'x-forwarded-port': '1234',
      });
      assert.equal(saved.status, 200);
      const configFile = path.join(saved.data.configuration.home, 'config.json');
      const config = JSON.parse(readFileSync(configFile, 'utf8'));
      assert.equal(config.hiveUrl, backend);
      const context = await ui(`/launch-context?project=${project.slug}`);
      assert.equal(context.status, 200);
      assert.equal(context.data.hivemindMcp.env.HIVEMIND_URL, backend);
      assert.equal(context.data.botError, undefined);
      assert.equal(context.data.botDefinitions[0].id, 'fixture-bot');

      const setup = await ui(`/projects/${project.id}/bots/setup`, 'POST', { name: 'FixtureFeed', definitionId: 'fixture-bot' });
      assert.equal(setup.status, 201); assert.equal(setup.data.connected, true);
      const bot = setup.data.bot, route = `/projects/${project.id}/bots/${bot.id}`;
      const access = hive.bots.access(bot), credential = hive.bots.botCredential(human, project.id, bot.id).credential;
      const checkResult = (data: any) => assert.deepEqual(data.result, {
        tool: 'status', status: 200, cookieName: `hivemind_human_${port}`,
      });
      const status = await ui(route + '/control', 'POST', { action: 'status', expectedAccessRevision: access.revision });
      assert.equal(status.status, 200); checkResult(status.data);
      const reconnect = await ui(route + '/connect', 'POST', {
        expectedRevision: credential.revision, expectedAccessRevision: access.revision,
      });
      assert.equal(reconnect.status, 200); assert.equal(reconnect.data.connected, true);
      const agentCall = () => fetch(backend + `/api/agent/bots/${bot.id}/tools`, {
        method: 'POST', headers: { authorization: `Bearer ${brain.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'status', arguments: {} }),
      });
      const called = await agentCall(); assert.equal(called.status, 200); checkResult(await called.json());

      assert.equal((await ui(catalog, 'PUT', { ...settings, expectedRevision: 1 }, { origin: 'https://attacker.invalid' })).status, 403);
      assert.equal(JSON.parse(readFileSync(configFile, 'utf8')).hiveUrl, backend);
      // A genuinely different server remains an error; do not remove the profile binding check.
      writeFileSync(configFile, JSON.stringify({ ...config, hiveUrl: `http://127.0.0.1:${port === 7420 ? 7422 : 7420}` }));
      const rejected = await agentCall(); assert.equal(rejected.status, 409); await rejected.body?.cancel();
      assert.equal((await ui(route + '/control', 'POST', { action: 'status', expectedAccessRevision: access.revision })).status, 409);
      assert.match((await ui(`/launch-context?project=${project.slug}`)).data.botError, /different Hivemind server/);
    } finally {
      if (proxy) { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy!.close(() => resolve())); }
      await started.shutdown(); hive.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
}
