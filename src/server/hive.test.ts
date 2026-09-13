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

test("workers cannot forge control messages", () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "senior" });
  const peer = hive.join({ role: "worker", seniority: "mid" });
  const brain = hive.join({ role: "brain" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  assert.throws(
    () =>
      hive.postMessage(worker.agent, {
        channel: "general",
        body: "CONTROL clear_context",
        kind: "control",
        control: "clear_context",
      }),
    /control/,
  );
  assert.throws(
    () =>
      hive.postMessage(worker.agent, {
        channel: dm.id,
        body: "CONTROL clear_context",
        kind: "control",
        control: "clear_context",
      }),
    /control/,
  );
  assert.throws(
    () => hive.postMessage(peer.agent, { channel: "general", body: "join", kind: "system" }),
    /system/,
  );
  hive.clearContext(brain.agent, worker.agent.name);
  rmSync(dir, { recursive: true, force: true });
});

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

test("stale token plus resume name remints that identity", () => {
  const { hive, dir } = tempHive();
  const first = hive.join({ role: "brain" });
  const again = hive.join({ role: "brain", token: "dead-token", resumeName: first.agent.name });
  assert.equal(again.agent.id, first.agent.id);
  assert.notEqual(again.token, first.token);
  rmSync(dir, { recursive: true, force: true });
});

test("resume name cannot use another agent's token", () => {
  const { hive, dir } = tempHive();
  const a = hive.join({ role: "brain" });
  const b = hive.join({ role: "worker", seniority: "mid" });
  assert.throws(
    () => hive.join({ role: "worker", seniority: "mid", token: a.token, resumeName: b.agent.name }),
    /not /,
  );
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

test("brains do not wake on #general unless mentioned", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.join({ role: "brain" });
  const worker = hive.join({ role: "worker", seniority: "mid" });
  hive.postMessage(worker.agent, { channel: "general", body: "status only" });
  const idle = await hive.wait(brain.agent, 300);
  assert.equal(idle.idle, true);
  hive.postMessage(worker.agent, { channel: "general", body: `need a call @${brain.agent.name}` });
  const hit = await hive.wait(brain.agent, 300);
  assert.equal(hit.idle, false);
  assert.ok(hit.mentions.some((m) => m.body.includes(brain.agent.name)));
  const other = hive.join({ role: "brain" });
  hive.postMessage(brain.agent, { channel: "brains", body: "coord ping" });
  const brainsMail = await hive.wait(other.agent, 300);
  assert.equal(brainsMail.idle, false);
  rmSync(dir, { recursive: true, force: true });
});

test("last wait wins and the old one is superseded", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "senior" });
  const first = hive.wait(worker.agent, 8_000);
  await new Promise((r) => setTimeout(r, 30));
  const second = hive.wait(worker.agent, 8_000);
  await assert.rejects(first, /superseded/);
  const brain = hive.join({ role: "brain" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  hive.postMessage(brain.agent, { channel: dm.id, body: "only the new waiter" });
  const got = await second;
  assert.equal(got.idle, false);
  assert.ok(got.messages.some((m) => /only the new waiter/.test(m.body)));
  rmSync(dir, { recursive: true, force: true });
});

test("brain compact wait keeps full bodies on one conversation", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.join({ role: "brain" });
  const worker = hive.join({ role: "worker", seniority: "mid" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  const task =
    "implement deadline_ms on the settings page and wire validation for all form fields including edge cases around timezone offsets";
  hive.postMessage(worker.agent, { channel: dm.id, body: "first update with enough text" });
  hive.postMessage(worker.agent, { channel: dm.id, body: task });
  const compact = await hive.wait(brain.agent, 200, undefined, { compact: true });
  assert.equal(compact.mail?.length, 2);
  assert.ok(compact.mail?.every((m) => (m.body ?? "").length > 0));
  assert.ok(compact.mail?.some((m) => m.body === task));
  assert.ok(!("createdAt" in compact.you));
  rmSync(dir, { recursive: true, force: true });
});

test("compact wait: worker gets body, brain digest on many DMs, cursor keeps the rest", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.join({ role: "brain" });
  const workers = [0, 1, 2].map(() => hive.join({ role: "worker", seniority: "mid" }));
  for (const w of workers) {
    const dm = hive.openDm(brain.agent, w.agent.name);
    hive.postMessage(w.agent, { channel: dm.id, body: `report from ${w.agent.name} with enough text` });
  }
  const compact = await hive.wait(brain.agent, 300, undefined, { compact: true });
  assert.equal(compact.idle, false);
  assert.match(compact.next, /wait again/);
  assert.equal(compact.messages.length, 0);
  assert.ok((compact.mail?.length ?? 0) >= 1);
  assert.ok(compact.mail?.every((m) => m.excerpt || m.body));

  const worker = workers[0]!;
  const dm = hive.findDm(brain.agent.id, worker.agent.id)!;
  hive.postMessage(brain.agent, { channel: dm.id, body: "implement the settings page please" });
  const wmail = await hive.wait(worker.agent, 300, undefined, { compact: true });
  assert.ok(wmail.mail?.some((m) => /settings page/.test(m.body ?? "")));
  rmSync(dir, { recursive: true, force: true });
});

test("brain wait caps conversations not a single flooded DM", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.join({ role: "brain" });
  const flooded = hive.join({ role: "worker", seniority: "mid" });
  const other = hive.join({ role: "worker", seniority: "mid" });
  const floodDm = hive.openDm(brain.agent, flooded.agent.name);
  const otherDm = hive.openDm(brain.agent, other.agent.name);
  for (let i = 0; i < 8; i += 1) {
    hive.postMessage(flooded.agent, { channel: floodDm.id, body: `flood ${i}` });
  }
  hive.postMessage(other.agent, { channel: otherDm.id, body: "second conversation" });
  const first = await hive.wait(brain.agent, 200, undefined, { compact: true });
  assert.equal(first.mail?.length, 2);
  assert.ok(first.mail?.some((m) => /second conversation/.test(m.excerpt ?? m.body ?? "")));
  rmSync(dir, { recursive: true, force: true });
});

test("inbox cursor does not skip capped mail", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.join({ role: "brain" });
  const workers = Array.from({ length: 10 }, () => hive.join({ role: "worker", seniority: "junior" }));
  for (const w of workers) {
    const dm = hive.openDm(brain.agent, w.agent.name);
    hive.postMessage(w.agent, { channel: dm.id, body: `ping ${w.agent.name}` });
  }
  const first = await hive.wait(brain.agent, 200, undefined, { compact: true });
  assert.equal(first.idle, false);
  assert.ok((first.more ?? 0) > 0);
  const second = await hive.wait(brain.agent, 200, undefined, { compact: true });
  assert.equal(second.idle, false);
  rmSync(dir, { recursive: true, force: true });
});

test("brain wait skips a pile of #general and still gets the DM", async () => {
  const { hive, dir } = tempHive();
  const brain = hive.join({ role: "brain" });
  const worker = hive.join({ role: "worker", seniority: "mid" });
  for (let i = 0; i < 250; i += 1) {
    hive.postMessage(worker.agent, { channel: "general", body: `noise ${i}` });
  }
  const dm = hive.openDm(brain.agent, worker.agent.name);
  hive.postMessage(worker.agent, { channel: dm.id, body: "the real task" });
  const mail = await hive.wait(brain.agent, 400);
  assert.equal(mail.idle, false);
  assert.ok(mail.messages.some((m) => /real task/.test(m.body)));
  rmSync(dir, { recursive: true, force: true });
});

test("sweep keeps waiters online and drops stale agents", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "mid" });
  const sleeping = hive.wait(worker.agent, 4_000);
  await new Promise((r) => setTimeout(r, 20));
  hive.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(Date.now() - 60_000, worker.agent.id);
  hive.sweepPresence(1_000);
  assert.equal(hive.getAgent(worker.agent.id).online, true);
  const idle = hive.join({ role: "worker", seniority: "junior" });
  hive.db.prepare("UPDATE agents SET last_seen_at = ?, online = 1 WHERE id = ?").run(
    Date.now() - 60_000,
    idle.agent.id,
  );
  hive.sweepPresence(1_000);
  assert.equal(hive.getAgent(idle.agent.id).online, false);
  hive.postMessage(hive.getAgent("human"), { channel: "general", body: `x @${worker.agent.name}` });
  const mail = await sleeping;
  assert.equal(mail.idle, false);
  rmSync(dir, { recursive: true, force: true });
});

test("attachments and reactions stay on the message", async () => {
  const { hive, dir } = tempHive();
  const human = hive.getAgent("human");
  const brain = hive.join({ role: "brain" });
  const file = await hive.createFileFromBytes(human, {
    name: "note.txt",
    mime: "text/plain",
    bytes: new TextEncoder().encode("hello file"),
  });
  const msg = hive.postMessage(human, { channel: "general", body: "", attachmentIds: [file.id] });
  assert.equal(msg.attachments?.length, 1);
  assert.equal(msg.attachments?.[0]?.name, "note.txt");
  const reacted = hive.toggleReaction(brain.agent, msg.seq, "👍");
  assert.equal(reacted.added, true);
  assert.ok(reacted.message.reactions?.some((r) => r.emoji === "👍"));
  const worker = hive.join({ role: "worker", seniority: "mid" });
  assert.throws(
    () => hive.postMessage(worker.agent, { channel: "brains", body: "x", attachmentIds: [] }),
    /cannot post/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("body longer than 4k is rejected", () => {
  const { hive, dir } = tempHive();
  const brain = hive.join({ role: "brain" });
  assert.throws(
    () => hive.postMessage(brain.agent, { channel: "general", body: "x".repeat(4001) }),
    /too long/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("compact wait control includes the full body", async () => {
  const { hive, dir } = tempHive();
  const human = hive.getAgent("human");
  const worker = hive.join({ role: "worker", seniority: "mid" });
  hive.clearContext(human, worker.agent.name);
  const mail = await hive.wait(worker.agent, 300, undefined, { compact: true });
  const control = mail.control[0] as { action?: string; body?: string };
  assert.equal(control.action, "clear_context");
  assert.ok(control.body && control.body.length > 20);
  rmSync(dir, { recursive: true, force: true });
});

test("queued counts pending isFor mail and drops after wait", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "senior" });
  const brain = hive.join({ role: "brain" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  hive.postMessage(brain.agent, { channel: dm.id, body: "do the settings" });
  assert.equal(hive.queuedCounts()[worker.agent.id], 1);
  assert.equal(hive.queuedCounts()[brain.agent.id] ?? 0, 0);
  await hive.wait(worker.agent, 200);
  assert.equal(hive.queuedCounts()[worker.agent.id], 0);
  rmSync(dir, { recursive: true, force: true });
});

test("aborted wait keeps the agent online and does not consume mail", async () => {
  const { hive, dir } = tempHive();
  const worker = hive.join({ role: "worker", seniority: "mid" });
  const brain = hive.join({ role: "brain" });
  const dm = hive.openDm(brain.agent, worker.agent.name);
  const ac = new AbortController();
  const pending = hive.wait(worker.agent, 8_000, ac.signal);
  await new Promise((r) => setTimeout(r, 30));
  ac.abort();
  const aborted = await pending;
  assert.equal(aborted.idle, true);
  assert.equal(hive.getAgent(worker.agent.id).online, true);
  hive.postMessage(brain.agent, { channel: dm.id, body: "do not lose this" });
  const mail = await hive.wait(worker.agent, 200);
  assert.equal(mail.idle, false);
  assert.ok([...mail.messages, ...mail.mentions].some((m) => /do not lose this/.test(m.body)));
  rmSync(dir, { recursive: true, force: true });
});

test("For you hides mentions after the channel is read", () => {
  const { hive, dir } = tempHive();
  const human = hive.getAgent("human");
  const brain = hive.join({ role: "brain" });
  const msg = hive.postMessage(brain.agent, { channel: "general", body: "need a goal @Human" });
  const open = hive.mentionInbox(human, 30);
  assert.equal(open.messages.length, 1);
  hive.markRead(human, "general", msg.seq);
  const seen = hive.mentionInbox(human, 30);
  assert.equal(seen.messages.length, 0);
  const again = hive.postMessage(brain.agent, { channel: "general", body: "another ask @Human" });
  assert.equal(hive.mentionInbox(human, 30).messages.length, 1);
  hive.markMentionsSeen(human);
  assert.equal(hive.mentionInbox(human, 30).messages.length, 0);
  assert.equal(hive.unreadCounts(human).general ?? 0, 0);
  assert.ok(again.seq > msg.seq);
  rmSync(dir, { recursive: true, force: true });
});

test("hasReaction is true for the acting agent even without decorate actor", () => {
  const { hive, dir } = tempHive();
  const human = hive.getAgent("human");
  const brain = hive.join({ role: "brain" });
  const msg = hive.postMessage(brain.agent, { channel: "brains", body: "ping @Human" });
  hive.toggleReaction(human, msg.seq, "👍");
  const raw = hive.getMessageBySeq(msg.seq);
  assert.equal(raw.reactions?.some((r) => r.emoji === "👍" && r.mine), false);
  assert.equal(hive.hasReaction(human.id, msg.id, "👍"), true);
  hive.toggleReaction(human, msg.seq, "👍");
  assert.equal(hive.hasReaction(human.id, msg.id, "👍"), false);
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
