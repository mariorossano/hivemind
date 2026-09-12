import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Hive } from "./hive.ts";

function tempHive() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-"));
  const hive = new Hive(path.join(dir, "hive.db"));
  return { hive, dir };
}

test("workers cannot mention Human or open a DM with Human", () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "senior" });
  assert.equal(worker.agent.role, "worker");
  assert.throws(
    () => hive.postMessage(worker.agent, { channel: "general", body: "hello @Human" }),
    /cannot mention/,
  );
  assert.throws(() => hive.openDm(worker.agent, "Human"), /cannot open a DM with Human/);
  rmSync(dir, { recursive: true, force: true });
});

test("workers cannot see or post in #brains", () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "mid" });
  const brain = hive.join({ role: "brain" });
  const channels = hive.listChannels(worker.agent).map((c) => c.name);
  assert.ok(!channels.includes("brains"));
  assert.throws(
    () => hive.postMessage(worker.agent, { channel: "brains", body: "nope" }),
    /cannot post/,
  );
  const msg = hive.postMessage(brain.agent, { channel: "brains", body: "hello @Human we need a goal" });
  assert.ok(msg.mentions.includes("human"));
  rmSync(dir, { recursive: true, force: true });
});

test("role is sticky and offline work waits", async () => {
  const { hive, dir } = tempHive();
  const first = hive.join({ role: "worker", seniority: "junior", focus: "frontend" });
  assert.throws(
    () => hive.join({ role: "brain", token: first.token }),
    /cannot change/,
  );
  hive.setOffline(first.agent.id);
  const brain = hive.join({ role: "brain" });
  hive.openDm(brain.agent, first.agent.name);
  hive.postMessage(brain.agent, {
    channel: hive.findDm(brain.agent.id, first.agent.id)!.id,
    body: "when you are back, fix the login",
  });
  const back = hive.join({ role: "worker", seniority: "junior", token: first.token });
  const inbox = await hive.wait(back.agent, 500);
  assert.equal(inbox.idle, false);
  const all = [...inbox.control, ...inbox.mentions, ...inbox.messages];
  assert.ok(all.some((m) => /login/.test(m.body)));
  rmSync(dir, { recursive: true, force: true });
});

test("two joins without a token create two employees", () => {
  const { hive, dir } = tempHive();
  const a = hive.join({ role: "brain" });
  const b = hive.join({ role: "worker", seniority: "mid" });
  assert.notEqual(a.agent.id, b.agent.id);
  assert.notEqual(a.agent.name, b.agent.name);
  rmSync(dir, { recursive: true, force: true });
});

test("public chatter does not wake a waiting worker", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "senior" });
  const brain = hive.join({ role: "brain" });
  const sleeping = hive.wait(worker.agent, 400);
  await new Promise((r) => setTimeout(r, 40));
  hive.postMessage(brain.agent, { channel: "general", body: "noise one" });
  hive.postMessage(brain.agent, { channel: "general", body: "noise two" });
  const started = Date.now();
  const result = await sleeping;
  assert.equal(result.idle, true);
  assert.ok(Date.now() - started >= 300);
  rmSync(dir, { recursive: true, force: true });
});

test("restart does not add Human to brain-worker DMs", () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "mid" });
  const brain = hive.join({ role: "brain" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  assert.ok(!dm.memberIds.includes("human"));
  const again = new Hive(path.join(dir, "hive.db"));
  assert.ok(!again.getChannel(dm.id).memberIds.includes("human"));
  rmSync(dir, { recursive: true, force: true });
});

test("wait wakes workers only for addressed mail", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "senior" });
  const brain = hive.join({ role: "brain" });
  hive.postMessage(brain.agent, { channel: "general", body: "status update, no mention" });
  const idle = await hive.wait(worker.agent, 400);
  assert.equal(idle.idle, true);
  hive.postMessage(brain.agent, { channel: "general", body: `please take this @${worker.agent.name}` });
  const hit = await hive.wait(worker.agent, 400);
  assert.equal(hit.idle, false);
  assert.ok(hit.mentions.some((m) => m.body.includes(worker.agent.name)));
  rmSync(dir, { recursive: true, force: true });
});

test("Human can see brain-worker DMs and invite to private rooms", () => {
  const { hive, dir } = tempHive();
  const human = hive.getAgent("human");
  const worker = hive.join({ role: "worker", seniority: "mid" });
  const brain = hive.join({ role: "brain" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  hive.postMessage(brain.agent, { channel: dm.id, body: "secret assignment" });
  const humanChannels = hive.listChannels(human).map((c) => c.id);
  assert.ok(humanChannels.includes(dm.id));
  const privateCh = hive.createChannel(brain.agent, { name: "login", type: "private" });
  hive.invite(brain.agent, privateCh.id, [worker.agent.name]);
  const room = hive.getChannel(privateCh.id);
  assert.ok(room.memberIds.includes(worker.agent.id));
  rmSync(dir, { recursive: true, force: true });
});
