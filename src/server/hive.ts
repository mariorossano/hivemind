import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import {
  HiveError,
  HUMAN_ID,
  HUMAN_NAME,
  type Agent,
  type Channel,
  type ChannelType,
  type ControlAction,
  type Message,
  type Role,
  type Seniority,
  type Thread,
  type ThreadStatus,
  type WaitResult,
} from "../shared/types.ts";
import { pickName } from "./names.ts";

type AgentRow = {
  id: string;
  name: string;
  role: Role;
  seniority: Seniority | null;
  focus: string | null;
  token_hash: string;
  online: number;
  last_seen_at: number;
  created_at: number;
  inbox_cursor: number;
};

type ChannelRow = {
  id: string;
  name: string;
  type: ChannelType;
  topic: string | null;
  created_by: string;
  created_at: number;
};

type MessageRow = {
  seq: number;
  id: string;
  channel_id: string;
  thread_id: string | null;
  author_id: string;
  body: string;
  kind: "chat" | "system" | "control";
  control: ControlAction | null;
  mentions: string;
  created_at: number;
};

export function hiveHome(): string {
  return process.env.HIVEMIND_HOME ?? path.join(homedir(), ".hivemind");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return `hm_${randomBytes(24).toString("hex")}`;
}

function now(): number {
  return Date.now();
}

export class Hive {
  db: DatabaseSync;
  bus = new EventEmitter();
  private waiters = new Map<string, Set<() => void>>();

  constructor(dbPath = path.join(hiveHome(), "hive.db")) {
    this.bus.setMaxListeners(200);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    this.bootstrap();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL,
        seniority TEXT,
        focus TEXT,
        token_hash TEXT NOT NULL,
        online INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        inbox_cursor INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        topic TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channel_members (
        channel_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        PRIMARY KEY (channel_id, agent_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT UNIQUE NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT,
        author_id TEXT NOT NULL,
        body TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'chat',
        control TEXT,
        mentions TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        status TEXT
      );
      CREATE TABLE IF NOT EXISTS reads (
        agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        last_read_seq INTEGER NOT NULL,
        PRIMARY KEY (agent_id, channel_id)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel_seq ON messages(channel_id, seq);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
    `);
  }

  private bootstrap() {
    const existing = this.db.prepare("SELECT id FROM agents WHERE id = ?").get(HUMAN_ID);
    if (!existing) {
      const t = now();
      this.db.prepare(
        `INSERT INTO agents (id, name, role, seniority, focus, token_hash, online, last_seen_at, created_at, inbox_cursor)
         VALUES (?, ?, 'human', NULL, NULL, ?, 1, ?, ?, 0)`,
      ).run(HUMAN_ID, HUMAN_NAME, hashToken("human-local"), t, t);
    }

    this.ensureChannel("general", "general", "public", HUMAN_ID, "Town square");
    this.ensureChannel("brains", "brains", "brains", HUMAN_ID, "Human and brains only");
    this.addHumanToAllChannels();
  }

  private ensureChannel(
    id: string,
    name: string,
    type: ChannelType,
    createdBy: string,
    topic: string,
  ) {
    const found = this.db.prepare("SELECT id FROM channels WHERE id = ?").get(id);
    if (!found) {
      this.db.prepare(
        `INSERT INTO channels (id, name, type, topic, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, name, type, topic, createdBy, now());
    }
    this.addMember(id, HUMAN_ID);
  }

  private addHumanToAllChannels() {
    const channels = this.db.prepare("SELECT id FROM channels WHERE type != 'dm'").all() as { id: string }[];
    for (const c of channels) this.addMember(c.id, HUMAN_ID);
  }

  addMember(channelId: string, agentId: string) {
    this.db.prepare(
      `INSERT OR IGNORE INTO channel_members (channel_id, agent_id) VALUES (?, ?)`,
    ).run(channelId, agentId);
  }

  touch(agentId: string, online = true) {
    this.db.prepare(
      `UPDATE agents SET last_seen_at = ?, online = ? WHERE id = ?`,
    ).run(now(), online ? 1 : 0, agentId);
    this.bus.emit("agent", this.getAgent(agentId));
  }

  setOffline(agentId: string) {
    if (agentId === HUMAN_ID) return;
    this.touch(agentId, false);
  }

  getAgent(id: string): Agent {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    if (!row) throw new HiveError(404, "Agent not found");
    return this.mapAgent(row);
  }

  getAgentByName(name: string): Agent | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE lower(name) = lower(?)").get(name) as
      | AgentRow
      | undefined;
    return row ? this.mapAgent(row) : null;
  }

  agentByToken(token: string): Agent {
    const row = this.db.prepare("SELECT * FROM agents WHERE token_hash = ?").get(hashToken(token)) as
      | AgentRow
      | undefined;
    if (!row) throw new HiveError(401, "Invalid token");
    return this.mapAgent(row);
  }

  private mapAgent(row: AgentRow): Agent {
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      seniority: row.seniority,
      focus: row.focus,
      online: row.id === HUMAN_ID ? true : Boolean(row.online),
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
    };
  }

  listAgents(): Agent[] {
    const rows = this.db.prepare("SELECT * FROM agents ORDER BY role, seniority, name").all() as AgentRow[];
    return rows.map((r) => this.mapAgent(r));
  }

  join(input: {
    role: "brain" | "worker";
    seniority?: Seniority | null;
    focus?: string | null;
    token?: string | null;
    resumeName?: string | null;
  }): { agent: Agent; token: string; created: boolean } {
    if (input.role !== "brain" && input.role !== "worker") {
      throw new HiveError(400, "role must be brain or worker");
    }
    if (input.token) {
      const agent = this.agentByToken(input.token);
      if (agent.role !== input.role) {
        throw new HiveError(409, `${agent.name} is a ${agent.role}; role cannot change`);
      }
      if (input.role === "worker" && input.seniority && agent.seniority !== input.seniority) {
        throw new HiveError(409, `${agent.name} is ${agent.seniority}; seniority cannot change`);
      }
      this.touch(agent.id, true);
      return { agent, token: input.token, created: false };
    }

    if (input.resumeName) {
      const agent = this.getAgentByName(input.resumeName);
      if (!agent) throw new HiveError(404, `No identity named ${input.resumeName}`);
      if (agent.role !== input.role) {
        throw new HiveError(409, `${agent.name} is a ${agent.role}; role cannot change`);
      }
      if (input.role === "worker" && input.seniority && agent.seniority !== input.seniority) {
        throw new HiveError(409, `${agent.name} is ${agent.seniority}; seniority cannot change`);
      }
      const token = newToken();
      this.db.prepare("UPDATE agents SET token_hash = ? WHERE id = ?").run(hashToken(token), agent.id);
      this.touch(agent.id, true);
      return { agent: this.getAgent(agent.id), token, created: false };
    }

    if (input.role === "worker" && !input.seniority) {
      throw new HiveError(400, "Workers need --seniority junior|mid|senior");
    }
    if (input.role === "brain" && input.seniority) {
      throw new HiveError(400, "Brains have no seniority; only workers do");
    }

    const taken = new Set(
      (this.db.prepare("SELECT lower(name) AS n FROM agents").all() as { n: string }[]).map((r) => r.n),
    );
    const name = pickName(input.role, taken);
    const id = crypto.randomUUID();
    const token = newToken();
    const t = now();
    this.db.prepare(
      `INSERT INTO agents (id, name, role, seniority, focus, token_hash, online, last_seen_at, created_at, inbox_cursor)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 0)`,
    ).run(
      id,
      name,
      input.role,
      input.role === "worker" ? (input.seniority ?? null) : null,
      input.focus ?? null,
      hashToken(token),
      t,
      t,
    );

    for (const ch of this.db.prepare("SELECT id, type FROM channels").all() as { id: string; type: ChannelType }[]) {
      if (ch.type === "public") this.addMember(ch.id, id);
      if (ch.type === "brains" && input.role === "brain") this.addMember(ch.id, id);
    }

    const agent = this.getAgent(id);
    this.postSystem(
      "general",
      `${agent.name} has joined as ${describeAgent(agent)}.`,
    );
    const maxSeq = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM messages").get() as { n: number };
    this.db.prepare("UPDATE agents SET inbox_cursor = ? WHERE id = ?").run(maxSeq.n, id);
    this.bus.emit("agent", agent);
    return { agent: this.getAgent(id), token, created: true };
  }

  listChannels(actor: Agent): Channel[] {
    const rows = this.db.prepare("SELECT * FROM channels ORDER BY type, name").all() as ChannelRow[];
    return rows
      .map((r) => this.mapChannel(r))
      .filter((ch) => this.canSeeChannel(actor, ch));
  }

  getChannel(idOrName: string): Channel {
    const row = this.db.prepare(
      `SELECT * FROM channels WHERE id = ? OR lower(name) = lower(?)`,
    ).get(idOrName, idOrName) as ChannelRow | undefined;
    if (!row) throw new HiveError(404, "Channel not found");
    return this.mapChannel(row);
  }

  private mapChannel(row: ChannelRow): Channel {
    const members = this.db.prepare(
      "SELECT agent_id FROM channel_members WHERE channel_id = ?",
    ).all(row.id) as { agent_id: string }[];
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      topic: row.topic,
      createdBy: row.created_by,
      createdAt: row.created_at,
      memberIds: members.map((m) => m.agent_id),
    };
  }

  canSeeChannel(actor: Agent, ch: Channel): boolean {
    if (actor.role === "human") return true;
    if (ch.type === "brains" && actor.role !== "brain") return false;
    return ch.memberIds.includes(actor.id);
  }

  canPost(actor: Agent, ch: Channel): boolean {
    if (actor.role === "human") return true;
    if (ch.type === "brains") return actor.role === "brain";
    if (ch.type === "dm") return ch.memberIds.includes(actor.id);
    if (ch.type === "public") return true;
    return ch.memberIds.includes(actor.id);
  }

  createChannel(
    actor: Agent,
    input: { name: string; type: "public" | "brains" | "private"; topic?: string; memberNames?: string[] },
  ): Channel {
    if (actor.role === "worker") throw new HiveError(403, "Workers cannot create channels");
    if (input.type !== "public" && input.type !== "private" && input.type !== "brains") {
      throw new HiveError(400, "Channel type must be public, private, or brains");
    }
    if (input.type === "brains" && actor.role !== "human") {
      throw new HiveError(403, "Only Human can create brains channels");
    }
    const slug = slugify(input.name);
    if (!slug) throw new HiveError(400, "Invalid channel name");
    const exists = this.db.prepare("SELECT id FROM channels WHERE lower(name) = ?").get(slug);
    if (exists) throw new HiveError(409, `#${slug} already exists`);
    const id = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO channels (id, name, type, topic, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, slug, input.type, input.topic ?? null, actor.id, now());
    this.addMember(id, HUMAN_ID);
    if (input.type === "public") {
      for (const a of this.listAgents()) {
        if (a.role !== "human") this.addMember(id, a.id);
      }
    } else if (input.type === "brains") {
      for (const a of this.listAgents()) {
        if (a.role === "brain") this.addMember(id, a.id);
      }
    } else {
      this.addMember(id, actor.id);
      for (const name of input.memberNames ?? []) {
        const m = this.getAgentByName(name);
        if (m) this.addMember(id, m.id);
      }
    }
    const ch = this.getChannel(id);
    this.bus.emit("channel", ch);
    this.postSystem(id, `${actor.name} created #${slug}`);
    return this.getChannel(id);
  }

  openDm(actor: Agent, otherName: string): Channel {
    const other = this.getAgentByName(otherName);
    if (!other) throw new HiveError(404, `No agent named ${otherName}`);
    if (other.id === actor.id) throw new HiveError(400, "Cannot DM yourself");
    if (actor.role === "worker" && other.role === "human") {
      const existing = this.findDm(actor.id, other.id);
      if (existing) return existing;
      throw new HiveError(403, "Workers cannot open a DM with Human. Ask a brain.");
    }
    if (actor.role === "worker" && other.role === "worker") {
      throw new HiveError(403, "Workers cannot DM other workers. Talk to a brain.");
    }
    const found = this.findDm(actor.id, other.id);
    if (found) return found;
    const [a, b] = [actor.id, other.id].sort();
    const id = `dm:${a}:${b}`;
    this.db.prepare(
      `INSERT INTO channels (id, name, type, topic, created_by, created_at) VALUES (?, ?, 'dm', NULL, ?, ?)`,
    ).run(id, dmLabel(actor, other), actor.id, now());
    this.addMember(id, actor.id);
    this.addMember(id, other.id);
    const ch = this.getChannel(id);
    this.bus.emit("channel", ch);
    return ch;
  }

  findDm(a: string, b: string): Channel | null {
    const [x, y] = [a, b].sort();
    const row = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(`dm:${x}:${y}`) as
      | ChannelRow
      | undefined;
    return row ? this.mapChannel(row) : null;
  }

  postMessage(
    actor: Agent,
    input: {
      channel: string;
      body: string;
      threadId?: string | null;
      kind?: Message["kind"];
      control?: ControlAction | null;
    },
  ): Message {
    const ch = this.getChannel(input.channel);
    if (!this.canSeeChannel(actor, ch) || !this.canPost(actor, ch)) {
      throw new HiveError(403, `You cannot post to ${channelLabel(ch)}`);
    }
    if (actor.role === "human" && !ch.memberIds.includes(actor.id)) {
      this.addMember(ch.id, actor.id);
      ch.memberIds.push(actor.id);
    }
    const body = input.body.trim();
    if (!body && input.kind !== "control") throw new HiveError(400, "Empty message");
    const mentions = parseMentions(body, this.listAgents());
    if (actor.role === "worker" && mentions.some((id) => id === HUMAN_ID)) {
      throw new HiveError(403, "Workers cannot mention @Human. Ask a brain.");
    }
    if (input.threadId) {
      const root = this.db.prepare("SELECT id, channel_id FROM messages WHERE id = ?").get(input.threadId) as
        | { id: string; channel_id: string }
        | undefined;
      if (!root || root.channel_id !== ch.id) throw new HiveError(400, "Thread not in this channel");
    }
    const id = crypto.randomUUID();
    const t = now();
    const kind = input.kind ?? "chat";
    this.db.prepare(
      `INSERT INTO messages (id, channel_id, thread_id, author_id, body, kind, control, mentions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      ch.id,
      input.threadId ?? null,
      actor.id,
      body,
      kind,
      input.control ?? null,
      JSON.stringify(mentions),
      t,
    );
    if (input.threadId) {
      this.db.prepare(
        `INSERT OR IGNORE INTO threads (id, channel_id, status) VALUES (?, ?, 'open')`,
      ).run(input.threadId, ch.id);
    }
    this.touch(actor.id, true);
    const msg = this.getMessageById(id);
    this.bus.emit("message", msg);
    this.wakeMembers(ch, msg);
    return msg;
  }

  postSystem(channelId: string, body: string) {
    const human = this.getAgent(HUMAN_ID);
    try {
      this.postMessage(human, { channel: channelId, body, kind: "system" });
    } catch {
      // bootstrap edge
    }
  }

  getMessageById(id: string): Message {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
    if (!row) throw new HiveError(404, "Message not found");
    return this.mapMessage(row);
  }

  private mapMessage(row: MessageRow): Message {
    let author: Agent;
    try {
      author = this.getAgent(row.author_id);
    } catch {
      author = {
        id: row.author_id,
        name: "unknown",
        role: "worker",
        seniority: null,
        focus: null,
        online: false,
        lastSeenAt: row.created_at,
        createdAt: row.created_at,
      };
    }
    return {
      id: row.id,
      seq: row.seq,
      channelId: row.channel_id,
      threadId: row.thread_id,
      authorId: author.id,
      authorName: author.name,
      authorRole: author.role,
      body: row.body,
      kind: row.kind,
      control: row.control,
      mentions: JSON.parse(row.mentions) as string[],
      createdAt: row.created_at,
    };
  }

  listMessages(
    actor: Agent,
    channelRef: string,
    opts: { threadId?: string | null; afterSeq?: number; beforeSeq?: number; limit?: number } = {},
  ): { messages: Message[]; hasOlder: boolean } {
    const ch = this.getChannel(channelRef);
    if (!this.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot read this channel");
    const limit = Math.min(Math.max(1, Number.isFinite(opts.limit) ? Number(opts.limit) : 80), 200);
    const after = opts.afterSeq ?? 0;
    const before = opts.beforeSeq;
    let rows: MessageRow[];
    if (opts.threadId) {
      const sqlBefore = before
        ? `SELECT * FROM messages WHERE channel_id = ? AND (id = ? OR thread_id = ?) AND seq < ? ORDER BY seq DESC LIMIT ?`
        : `SELECT * FROM messages WHERE channel_id = ? AND (id = ? OR thread_id = ?) AND seq > ? ORDER BY seq ASC LIMIT ?`;
      rows = before
        ? (this.db.prepare(sqlBefore).all(ch.id, opts.threadId, opts.threadId, before, limit) as MessageRow[]).reverse()
        : (this.db.prepare(sqlBefore).all(ch.id, opts.threadId, opts.threadId, after, limit) as MessageRow[]);
    } else if (before) {
      rows = this.db.prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND thread_id IS NULL AND seq < ?
         ORDER BY seq DESC LIMIT ?`,
      ).all(ch.id, before, limit) as MessageRow[];
      rows.reverse();
    } else {
      rows = this.db.prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND thread_id IS NULL AND seq > ?
         ORDER BY seq DESC LIMIT ?`,
      ).all(ch.id, after, limit) as MessageRow[];
      rows.reverse();
    }
    const messages = rows.map((r) => this.mapMessage(r));
    const scope = opts.threadId
      ? this.db.prepare(
          `SELECT COALESCE(MIN(seq), 0) AS n FROM messages WHERE channel_id = ? AND (id = ? OR thread_id = ?)`,
        ).get(ch.id, opts.threadId, opts.threadId) as { n: number }
      : this.db.prepare(
          `SELECT COALESCE(MIN(seq), 0) AS n FROM messages WHERE channel_id = ? AND thread_id IS NULL`,
        ).get(ch.id) as { n: number };
    const oldest = messages[0]?.seq ?? 0;
    return { messages, hasOlder: Boolean(oldest && scope.n && scope.n < oldest) };
  }

  threadsInChannel(channelId: string): Thread[] {
    return this.db.prepare("SELECT * FROM threads WHERE channel_id = ?").all(channelId) as Thread[];
  }

  replyCounts(channelId: string): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT thread_id AS id, COUNT(*) AS n FROM messages
       WHERE channel_id = ? AND thread_id IS NOT NULL GROUP BY thread_id`,
    ).all(channelId) as { id: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.id, r.n]));
  }

  latestSeq(channelId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM messages WHERE channel_id = ?").get(
      channelId,
    ) as { n: number };
    return row.n;
  }

  setThreadStatus(actor: Agent, threadId: string, status: ThreadStatus | null): Thread {
    const row = this.db.prepare(
      `SELECT m.id, m.channel_id FROM messages m WHERE m.id = ?`,
    ).get(threadId) as { id: string; channel_id: string } | undefined;
    if (!row) throw new HiveError(404, "Thread not found");
    if (status !== null && !["open", "in_progress", "blocked", "done"].includes(status)) {
      throw new HiveError(400, "Invalid thread status");
    }
    const ch = this.getChannel(row.channel_id);
    if (!this.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot access thread");
    this.db.prepare(
      `INSERT INTO threads (id, channel_id, status) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
    ).run(threadId, row.channel_id, status);
    const thread = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as Thread;
    this.bus.emit("thread", thread);
    return thread;
  }

  markRead(actor: Agent, channelId: string, seq: number) {
    this.db.prepare(
      `INSERT INTO reads (agent_id, channel_id, last_read_seq) VALUES (?, ?, ?)
       ON CONFLICT(agent_id, channel_id) DO UPDATE SET last_read_seq = MAX(last_read_seq, excluded.last_read_seq)`,
    ).run(actor.id, channelId, seq);
  }

  readsFor(actor: Agent): Record<string, number> {
    const rows = this.db.prepare("SELECT channel_id, last_read_seq FROM reads WHERE agent_id = ?").all(actor.id) as {
      channel_id: string;
      last_read_seq: number;
    }[];
    return Object.fromEntries(rows.map((r) => [r.channel_id, r.last_read_seq]));
  }

  unreadCounts(actor: Agent): Record<string, number> {
    const channels = this.listChannels(actor);
    const reads = this.readsFor(actor);
    const out: Record<string, number> = {};
    for (const ch of channels) {
      const last = reads[ch.id] ?? 0;
      const row = this.db.prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND seq > ? AND author_id != ?`,
      ).get(ch.id, last, actor.id) as { n: number };
      out[ch.id] = row.n;
    }
    return out;
  }

  mentionInbox(actor: Agent, limit = 50): Message[] {
    const rows = this.db.prepare(
      `SELECT * FROM messages WHERE mentions LIKE ? ORDER BY seq DESC LIMIT ?`,
    ).all(`%${actor.id}%`, limit) as MessageRow[];
    return rows
      .map((r) => this.mapMessage(r))
      .filter((m) => m.mentions.includes(actor.id));
  }

  clearContext(actor: Agent, targetName: string): Message {
    if (actor.role === "worker") throw new HiveError(403, "Only a brain or Human can clear context");
    const target = this.getAgentByName(targetName);
    if (!target) throw new HiveError(404, `No agent named ${targetName}`);
    if (target.role !== "worker") throw new HiveError(400, "clear_context is for workers");
    const dm = this.openDm(actor, target.name);
    return this.postMessage(actor, {
      channel: dm.id,
      body: `CONTROL clear_context: discard all prior task memory. Keep only your Hivemind identity (${target.name}) and standing orders. Then wait.`,
      kind: "control",
      control: "clear_context",
    });
  }

  private unseen(actor: Agent): Message[] {
    const row = this.db.prepare("SELECT inbox_cursor FROM agents WHERE id = ?").get(actor.id) as {
      inbox_cursor: number;
    };
    let cursor = row?.inbox_cursor ?? 0;
    const channels = this.listChannels(actor);
    if (channels.length === 0) return [];
    const ids = channels.map((c) => c.id);
    const placeholders = ids.map(() => "?").join(",");
    const found: Message[] = [];
    let advanced = cursor;
    for (let page = 0; page < 20 && found.length === 0; page += 1) {
      const rows = this.db.prepare(
        `SELECT * FROM messages WHERE seq > ? AND channel_id IN (${placeholders}) AND author_id != ?
         ORDER BY seq ASC LIMIT 100`,
      ).all(advanced, ...ids, actor.id) as MessageRow[];
      if (rows.length === 0) break;
      advanced = rows[rows.length - 1]!.seq;
      for (const r of rows) {
        const message = this.mapMessage(r);
        if (this.isFor(actor, message)) found.push(message);
      }
    }
    if (advanced > cursor) {
      this.db.prepare("UPDATE agents SET inbox_cursor = MAX(inbox_cursor, ?) WHERE id = ?").run(advanced, actor.id);
    }
    return found;
  }

  /** Wait wakes agents only for mail addressed to them, not public chatter. */
  isFor(actor: Agent, msg: Message): boolean {
    if (msg.mentions.includes(actor.id)) return true;
    if (msg.kind === "control") return true;
    const ch = this.getChannel(msg.channelId);
    if (ch.type === "dm" || ch.type === "private") return true;
    if (ch.type === "brains" && actor.role === "brain") return true;
    if (ch.type === "public" && actor.role === "brain") return true;
    return false;
  }

  invite(actor: Agent, channelRef: string, memberNames: string[]): Channel {
    if (actor.role === "worker") throw new HiveError(403, "Workers cannot invite");
    if (memberNames.length === 0) throw new HiveError(400, "No members to invite");
    const ch = this.getChannel(channelRef);
    if (!this.canSeeChannel(actor, ch)) throw new HiveError(403, "Cannot access channel");
    if (ch.type === "dm") throw new HiveError(400, "Cannot invite to a DM");
    const added: string[] = [];
    for (const name of memberNames) {
      const member = this.getAgentByName(name);
      if (!member) throw new HiveError(404, `No agent named ${name}`);
      if (ch.type === "brains" && member.role === "worker") {
        throw new HiveError(403, "Workers cannot join brains channels");
      }
      this.addMember(ch.id, member.id);
      added.push(member.name);
    }
    this.bus.emit("channel", this.getChannel(ch.id));
    this.postSystem(ch.id, `${actor.name} invited ${added.join(", ")}`);
    return this.getChannel(ch.id);
  }

  private wakeMembers(ch: Channel, msg: Message) {
    for (const id of new Set([...ch.memberIds, HUMAN_ID])) {
      if (id === msg.authorId) continue;
      const agent = this.getAgent(id);
      const channel = this.getChannel(ch.id);
      if (!this.canSeeChannel(agent, channel)) continue;
      if (!this.isFor(agent, msg)) continue;
      const set = this.waiters.get(id);
      if (set) {
        for (const wake of set) wake();
      }
    }
  }

  async wait(actor: Agent, timeoutMs: number, signal?: AbortSignal): Promise<WaitResult> {
    this.touch(actor.id, true);
    const pack = (messages: Message[]): WaitResult => {
      const control = messages.filter((m) => m.kind === "control");
      const mentions = messages.filter((m) => m.mentions.includes(actor.id) && m.kind !== "control");
      const rest = messages.filter((m) => m.kind !== "control" && !m.mentions.includes(actor.id));
      return { idle: messages.length === 0, you: this.getAgent(actor.id), control, mentions, messages: rest };
    };

    const first = this.unseen(actor);
    if (first.length > 0) {
      return pack(first);
    }

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const set = this.waiters.get(actor.id);
        if (set) {
          set.delete(wake);
          if (set.size === 0) this.waiters.delete(actor.id);
        }
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        const messages = this.unseen(actor);
        this.touch(actor.id, !signal?.aborted);
        if (signal?.aborted) this.setOffline(actor.id);
        resolve(pack(messages));
      };
      const wake = () => finish();
      const onAbort = () => finish();
      const set = this.waiters.get(actor.id) ?? new Set();
      set.add(wake);
      this.waiters.set(actor.id, set);
      const ms = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 120_000;
      const timer = setTimeout(finish, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  sweepPresence(maxIdleMs = 90_000) {
    const cutoff = now() - maxIdleMs;
    const rows = this.db.prepare(
      `SELECT id FROM agents WHERE role != 'human' AND online = 1 AND last_seen_at < ?`,
    ).all(cutoff) as { id: string }[];
    for (const r of rows) {
      if (this.waiters.has(r.id)) {
        this.touch(r.id, true);
        continue;
      }
      this.setOffline(r.id);
    }
  }
}

export function describeAgent(agent: Agent): string {
  if (agent.role === "human") return "Human";
  if (agent.role === "brain") return agent.focus ? `brain (${agent.focus})` : "brain";
  const sen = agent.seniority ?? "mid";
  return agent.focus ? `${sen} worker (${agent.focus})` : `${sen} worker`;
}

export function channelLabel(ch: Channel): string {
  if (ch.type === "dm") return ch.name;
  return `#${ch.name}`;
}

function slugify(name: string): string {
  return name.trim().replace(/^#/, "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function dmLabel(a: Agent, b: Agent): string {
  return [a.name, b.name].sort((x, y) => x.localeCompare(y)).join(" · ");
}

export function parseMentions(body: string, agents: Agent[]): string[] {
  const ids = new Set<string>();
  const re = /@([A-Za-z][A-Za-z0-9_-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const name = m[1]!;
    const agent = agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (agent) ids.add(agent.id);
  }
  return [...ids];
}
