import type { Agent, Channel, Message, Thread, ThreadStatus } from "../src/shared/types.ts";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

export type Snapshot = {
  you: Agent;
  agents: Agent[];
  channels: Channel[];
  unread: Record<string, number>;
  mentions: Message[];
};

export type ChannelPayload = {
  channel: Channel;
  messages: Message[];
  hasOlder?: boolean;
  threads: Thread[];
  replyCounts: Record<string, number>;
};

export const api = {
  snapshot: () => req<Snapshot>("/api/ui/snapshot"),
  messages: (id: string, threadId?: string | null, beforeSeq?: number) => {
    const q = new URLSearchParams();
    if (threadId) q.set("threadId", threadId);
    if (beforeSeq) q.set("beforeSeq", String(beforeSeq));
    const suffix = q.toString() ? `?${q}` : "";
    return req<ChannelPayload>(`/api/ui/channels/${encodeURIComponent(id)}/messages${suffix}`);
  },
  send: (id: string, body: string, threadId?: string | null) =>
    req<{ message: Message }>(`/api/ui/channels/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ body, threadId: threadId ?? null }),
    }),
  createChannel: (name: string, type: "public" | "private", topic?: string, memberNames?: string[]) =>
    req<{ channel: Channel }>("/api/ui/channels", {
      method: "POST",
      body: JSON.stringify({ name, type, topic, memberNames }),
    }),
  openDm: (name: string) =>
    req<{ channel: Channel }>("/api/ui/dms", { method: "POST", body: JSON.stringify({ name }) }),
  setStatus: (threadId: string, status: ThreadStatus) =>
    req<{ thread: Thread }>(`/api/ui/threads/${threadId}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
  invite: (channelId: string, names: string[]) =>
    req<{ channel: Channel }>(`/api/ui/channels/${encodeURIComponent(channelId)}/invite`, {
      method: "POST",
      body: JSON.stringify({ names }),
    }),
  clearContext: (name: string) =>
    req<{ message: Message }>("/api/ui/clear-context", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
};

export function connectWs(
  onEvent: (ev: { type: string; payload: unknown }) => void,
  onLive?: (ok: boolean) => void,
): () => void {
  let closed = false;
  let socket: WebSocket | null = null;
  let timer = 0;
  const connect = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}/ws`);
    socket.onopen = () => onLive?.(true);
    socket.onmessage = (e) => {
      try {
        onEvent(JSON.parse(String(e.data)));
      } catch {
        /* ignore */
      }
    };
    socket.onclose = () => {
      onLive?.(false);
      if (!closed) timer = window.setTimeout(connect, 1500);
    };
  };
  connect();
  return () => {
    closed = true;
    window.clearTimeout(timer);
    socket?.close();
  };
}
