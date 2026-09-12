import { Hono } from "hono";
import { cors } from "hono/cors";
import { HiveError, type Seniority } from "../shared/types.ts";
import { standingOrders } from "../shared/standing-orders.ts";
import { Hive, describeAgent } from "./hive.ts";

export function createApp(hive: Hive) {
  const app = new Hono();
  app.use("*", cors({ origin: ["http://127.0.0.1:7421", "http://localhost:7421", "http://127.0.0.1:7420"] }));

  app.onError((err, c) => {
    if (err instanceof HiveError) return c.json({ error: err.message }, err.status as 400);
    console.error(err);
    return c.json({ error: err.message || "internal error" }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true, name: "hivemind" }));

  const ui = new Hono();
  ui.get("/snapshot", (c) => {
    const human = hive.getAgent("human");
    return c.json({
      you: human,
      agents: hive.listAgents(),
      channels: hive.listChannels(human),
      unread: hive.unreadCounts(human),
      mentions: hive.mentionInbox(human, 30),
    });
  });
  ui.get("/channels/:id/messages", (c) => {
    const human = hive.getAgent("human");
    const id = c.req.param("id");
    const threadId = c.req.query("threadId") || null;
    const beforeSeq = c.req.query("beforeSeq") ? Number(c.req.query("beforeSeq")) : undefined;
    const listed = hive.listMessages(human, id, {
      threadId,
      beforeSeq,
      limit: Number(c.req.query("limit") ?? 80),
    });
    const ch = hive.getChannel(id);
    if (!threadId) {
      const latest = hive.latestSeq(ch.id);
      if (latest) hive.markRead(human, ch.id, latest);
    }
    return c.json({
      channel: ch,
      messages: listed.messages,
      hasOlder: listed.hasOlder,
      threads: hive.threadsInChannel(ch.id),
      replyCounts: hive.replyCounts(ch.id),
    });
  });
  ui.post("/channels", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const channel = hive.createChannel(human, {
      name: String(body.name ?? ""),
      type: body.type ?? "public",
      topic: body.topic,
      memberNames: body.memberNames,
    });
    return c.json({ channel });
  });
  ui.post("/channels/:id/messages", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const message = hive.postMessage(human, {
      channel: c.req.param("id"),
      body: String(body.body ?? ""),
      threadId: body.threadId ?? null,
    });
    hive.markRead(human, message.channelId, message.seq);
    return c.json({ message });
  });
  ui.post("/dms", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const channel = hive.openDm(human, String(body.name ?? ""));
    return c.json({ channel });
  });
  ui.post("/threads/:id/status", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const thread = hive.setThreadStatus(human, c.req.param("id"), body.status ?? null);
    return c.json({ thread });
  });
  ui.post("/clear-context", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const message = hive.clearContext(human, String(body.name ?? ""));
    return c.json({ message });
  });
  ui.post("/channels/:id/invite", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    const names = Array.isArray(body.names) ? body.names.map(String) : [String(body.name ?? "")];
    const channel = hive.invite(human, c.req.param("id"), names.filter(Boolean));
    return c.json({ channel });
  });
  ui.post("/read", async (c) => {
    const human = hive.getAgent("human");
    const body = await c.req.json();
    hive.markRead(human, String(body.channelId), Number(body.seq));
    return c.json({ ok: true });
  });

  const agent = new Hono();
  agent.use("*", async (c, next) => {
    if (c.req.path.endsWith("/join") && c.req.method === "POST") return next();
    const header = c.req.header("authorization") ?? "";
    const token = header.replace(/^Bearer\s+/i, "").trim();
    if (!token) throw new HiveError(401, "Missing token. Join first.");
    const me = hive.agentByToken(token);
    if (me.role === "human") throw new HiveError(403, "Human uses the web UI, not the agent API");
    hive.touch(me.id, true);
    c.set("me", me);
    c.set("token", token);
    await next();
  });

  agent.post("/join", async (c) => {
    const body = await c.req.json();
    const header = c.req.header("authorization") ?? "";
    const bearer = header.replace(/^Bearer\s+/i, "").trim();
    const result = hive.join({
      role: body.role,
      seniority: (body.seniority ?? null) as Seniority | null,
      focus: body.focus ?? null,
      token: bearer || body.token || null,
      resumeName: body.resume || body.resumeName || null,
    });
    return c.json({
      ...result,
      standingOrders: standingOrders(result.agent),
      describe: describeAgent(result.agent),
    });
  });

  agent.get("/me", (c) => {
    const me = c.get("me");
    return c.json({ you: me, standingOrders: standingOrders(me) });
  });
  agent.get("/agents", (c) => c.json({ agents: hive.listAgents() }));
  agent.get("/channels", (c) => {
    const me = c.get("me");
    return c.json({ channels: hive.listChannels(me), unread: hive.unreadCounts(me) });
  });
  agent.get("/channels/:id/messages", (c) => {
    const me = c.get("me");
    const listed = hive.listMessages(me, c.req.param("id"), {
      threadId: c.req.query("threadId") || null,
      afterSeq: c.req.query("afterSeq") ? Number(c.req.query("afterSeq")) : 0,
      beforeSeq: c.req.query("beforeSeq") ? Number(c.req.query("beforeSeq")) : undefined,
      limit: Number(c.req.query("limit") ?? 80),
    });
    const ch = hive.getChannel(c.req.param("id"));
    return c.json({
      channel: ch,
      messages: listed.messages,
      hasOlder: listed.hasOlder,
      threads: hive.threadsInChannel(ch.id),
      replyCounts: hive.replyCounts(ch.id),
    });
  });
  agent.post("/channels", async (c) => {
    const me = c.get("me");
    const body = await c.req.json();
    const channel = hive.createChannel(me, {
      name: String(body.name ?? ""),
      type: body.type ?? "public",
      topic: body.topic,
      memberNames: body.memberNames,
    });
    return c.json({ channel });
  });
  agent.post("/channels/:id/messages", async (c) => {
    const me = c.get("me");
    const body = await c.req.json();
    const message = hive.postMessage(me, {
      channel: c.req.param("id"),
      body: String(body.body ?? ""),
      threadId: body.threadId ?? null,
    });
    return c.json({ message });
  });
  agent.post("/dms", async (c) => {
    const me = c.get("me");
    const body = await c.req.json();
    const channel = hive.openDm(me, String(body.name ?? body.to ?? ""));
    return c.json({ channel });
  });
  agent.post("/threads/:id/status", async (c) => {
    const me = c.get("me");
    const body = await c.req.json();
    const thread = hive.setThreadStatus(me, c.req.param("id"), body.status ?? null);
    return c.json({ thread });
  });
  agent.post("/channels/:id/invite", async (c) => {
    const me = c.get("me");
    const body = await c.req.json();
    const names = Array.isArray(body.names) ? body.names.map(String) : [String(body.name ?? body.member ?? "")];
    const channel = hive.invite(me, c.req.param("id"), names.filter(Boolean));
    return c.json({ channel });
  });
  agent.post("/clear-context", async (c) => {
    const me = c.get("me");
    const body = await c.req.json();
    const message = hive.clearContext(me, String(body.name ?? body.agent ?? ""));
    return c.json({ message });
  });
  agent.post("/wait", async (c) => {
    const me = c.get("me");
    const body = await c.req.json().catch(() => ({}));
    const timeoutMs = Number(body.timeoutMs ?? 120_000);
    const result = await hive.wait(me, timeoutMs, c.req.raw.signal);
    return c.json(result);
  });
  agent.post("/leave", (c) => {
    const me = c.get("me");
    hive.setOffline(me.id);
    return c.json({ ok: true });
  });

  app.route("/api/ui", ui);
  app.route("/api/agent", agent);
  return app;
}

declare module "hono" {
  interface ContextVariableMap {
    me: import("../shared/types.ts").Agent;
    token: string;
  }
}
