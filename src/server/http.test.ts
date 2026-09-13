import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hive } from "./hive.ts";
import { startServer } from "./serve.ts";

async function json(
  base: string,
  method: string,
  url: string,
  body?: unknown,
  token?: string,
) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  return { status: res.status, data };
}

test("HTTP protocol: join, isolate, wait, Human admin", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-http-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  const started = startServer({ port: 0, hive, telegram: false });
  const port = await started.ready;
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await json(base, "GET", "/api/health");
    assert.equal(health.data.ok, true);

    const snap = await json(base, "GET", "/api/ui/snapshot");
    assert.equal(snap.data.you.name, "Human");
    assert.ok(snap.data.channels.some((c: { name: string }) => c.name === "brains"));

    const brain = await json(base, "POST", "/api/agent/join", { role: "brain", focus: "coord" });
    const worker = await json(base, "POST", "/api/agent/join", {
      role: "worker",
      seniority: "senior",
      focus: "frontend",
    });
    assert.equal(brain.status, 200);
    assert.equal(worker.status, 200);
    const brainTok = brain.data.token as string;
    const workerTok = worker.data.token as string;
    const workerName = worker.data.agent.name as string;
    const brainName = brain.data.agent.name as string;

    const workerCh = await json(base, "GET", "/api/agent/channels", undefined, workerTok);
    assert.ok(!workerCh.data.channels.some((c: { name: string }) => c.name === "brains"));

    const mention = await json(
      base,
      "POST",
      "/api/agent/channels/general/messages",
      { body: "hello @Human" },
      workerTok,
    );
    assert.equal(mention.status, 403);

    await json(base, "POST", "/api/ui/channels/general/messages", {
      body: "public chatter only",
    });
    const idle = await json(base, "POST", "/api/agent/wait", { timeoutMs: 400 }, workerTok);
    assert.equal(idle.data.idle, true);

    await json(base, "POST", "/api/agent/dms", { name: workerName }, brainTok);
    await json(
      base,
      "POST",
      `/api/agent/channels/general/messages`,
      { body: "ignore" },
      brainTok,
    );
    const dm = await json(base, "POST", "/api/agent/dms", { name: workerName }, brainTok);
    await json(
      base,
      "POST",
      `/api/agent/channels/${encodeURIComponent(dm.data.channel.id)}/messages`,
      { body: "build the login form" },
      brainTok,
    );
    const mail = await json(base, "POST", "/api/agent/wait", { timeoutMs: 800 }, workerTok);
    assert.equal(mail.data.idle, false);
    const bodies = [...mail.data.messages, ...mail.data.mentions].map((m: { body: string }) => m.body);
    assert.ok(bodies.some((b: string) => /login/.test(b)));

    const after = await json(base, "GET", "/api/ui/snapshot");
    assert.ok(after.data.channels.some((c: { type: string }) => c.type === "dm"));
    assert.ok(after.data.agents.some((a: { name: string }) => a.name === workerName));
    assert.ok(after.data.agents.some((a: { name: string }) => a.name === brainName));
    assert.equal(typeof after.data.queued, "object");
    assert.equal(after.data.queued[worker.data.agent.id] ?? 0, 0);

    const room = await json(
      base,
      "POST",
      "/api/agent/channels",
      { name: "login-room", type: "private", memberNames: [workerName] },
      brainTok,
    );
    assert.equal(room.status, 200);
    const invited = await json(
      base,
      "GET",
      `/api/agent/channels/${room.data.channel.id}/messages`,
      undefined,
      workerTok,
    );
    assert.equal(invited.status, 200);
    assert.equal(invited.data.threads, undefined);
    assert.equal(invited.data.replyCounts, undefined);
    const fatLimit = await json(
      base,
      "GET",
      `/api/agent/channels/${room.data.channel.id}/messages?limit=50`,
      undefined,
      workerTok,
    );
    assert.equal(fatLimit.data.threads, undefined);
    const withMeta = await json(
      base,
      "GET",
      `/api/agent/channels/${room.data.channel.id}/messages?meta=1`,
      undefined,
      workerTok,
    );
    assert.ok(withMeta.data.threads);

    const humanDm = await json(base, "POST", "/api/ui/dms", { name: workerName });
    await json(base, "POST", `/api/ui/channels/${humanDm.data.channel.id}/messages`, {
      body: "Human override: use the existing settings component",
    });
    const reply = await json(
      base,
      "POST",
      `/api/agent/channels/${humanDm.data.channel.id}/messages`,
      { body: "Understood, using the existing component." },
      workerTok,
    );
    assert.equal(reply.status, 200);

    const clear = await json(base, "POST", "/api/ui/clear-context", { name: workerName });
    assert.equal(clear.status, 200);
    assert.equal(clear.data.message.control, "clear_context");

    await json(base, "POST", "/api/agent/channels/general/messages", { body: "goal please @Human" }, brainTok);
    const beforeSeen = await json(base, "GET", "/api/ui/snapshot");
    assert.ok((beforeSeen.data.unread.general ?? 0) > 0);
    assert.ok(beforeSeen.data.mentions.length > 0);
    const seen = await json(base, "POST", "/api/ui/mentions/seen");
    assert.equal(seen.status, 200);
    assert.equal(seen.data.messages.length, 0);
    assert.equal(seen.data.unread.general ?? 0, 0);
  } finally {
    started.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
