import type { Channel, Message } from "../src/shared/types.ts";

const KEY = "hivemind-for-you-log";
const CAP = 400;

export function loadMailLog(): Message[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m): m is Message => Boolean(m && typeof m.id === "string" && typeof m.seq === "number"));
  } catch {
    return [];
  }
}

export function saveMailLog(messages: Message[]) {
  localStorage.setItem(KEY, JSON.stringify(messages.slice(0, CAP)));
}

export function isForYouMail(msg: Message, channels: Channel[]): boolean {
  if (msg.authorId === "human" || msg.authorRole === "human") return false;
  if (msg.mentions?.includes("human")) return true;
  if (msg.authorRole !== "brain") return false;
  const ch = channels.find((c) => c.id === msg.channelId);
  return Boolean(ch && ch.type === "dm" && ch.memberIds.includes("human"));
}

export function mergeMailLog(prev: Message[], incoming: Message[], channels: Channel[]): Message[] {
  const extra = incoming.filter((m) => isForYouMail(m, channels));
  if (extra.length === 0) return prev;
  const byId = new Map(prev.map((m) => [m.id, m]));
  let changed = false;
  for (const msg of extra) {
    if (!byId.has(msg.id)) {
      byId.set(msg.id, msg);
      changed = true;
    }
  }
  if (!changed) return prev;
  return [...byId.values()].sort((a, b) => b.seq - a.seq).slice(0, CAP);
}
