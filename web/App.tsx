import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { Agent, Channel, Message, ThreadStatus } from "../src/shared/types.ts";
import { api, connectWs, type ChannelPayload, type Snapshot } from "./api.ts";
import { renderBody } from "./markdown.tsx";

type Sel = { kind: "inbox" } | { kind: "channel"; id: string };

const STATUSES: ThreadStatus[] = ["open", "in_progress", "blocked", "done"];

function parseHash(): Sel {
  const raw = location.hash.replace(/^#/, "") || "/c/general";
  const parts = raw.split("/").filter(Boolean);
  if (parts[0] === "inbox") return { kind: "inbox" };
  if (parts[1]) return { kind: "channel", id: decodeURIComponent(parts[1]) };
  return { kind: "channel", id: "general" };
}

function setHash(sel: Sel) {
  location.hash = sel.kind === "inbox" ? "/inbox" : `/c/${encodeURIComponent(sel.id)}`;
}

function seniorityBars(agent: Agent): number {
  if (agent.role !== "worker") return 0;
  if (agent.seniority === "senior") return 3;
  if (agent.seniority === "mid") return 2;
  return 1;
}

function channelTitle(ch: Channel): string {
  return ch.type === "dm" ? ch.name : `#${ch.name}`;
}

function memberNames(ch: Channel, agents: Agent[]): string {
  const names = ch.memberIds
    .map((id) => agents.find((a) => a.id === id)?.name)
    .filter(Boolean);
  if (names.length === 0) return "No members";
  return names.join(", ");
}

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [sel, setSel] = useState<Sel>(parseHash);
  const [pane, setPane] = useState<ChannelPayload | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [threadPane, setThreadPane] = useState<ChannelPayload | null>(null);
  const [draft, setDraft] = useState("");
  const [threadDraft, setThreadDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newTopic, setNewTopic] = useState("");
  const [newType, setNewType] = useState<"public" | "private">("public");
  const [newMembers, setNewMembers] = useState<string[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteNames, setInviteNames] = useState<string[]>([]);
  const [confirmClear, setConfirmClear] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("hivemind-theme");
    return saved === "dark" ? "dark" : "light";
  });
  const [openGroups, setOpenGroups] = useState({ channels: true, dms: true, other: true });
  const stickBottom = useRef(true);
  const themePainted = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const threadBottomRef = useRef<HTMLDivElement>(null);

  const refreshSnap = useCallback(async () => {
    const next = await api.snapshot();
    setSnap(next);
    return next;
  }, []);

  const loadChannel = useCallback(async (id: string) => {
    const data = await api.messages(id);
    setPane(data);
  }, []);

  useEffect(() => {
    refreshSnap().catch((e) => setErr(String(e.message || e)));
    const off = connectWs((ev) => {
      if (ev.type === "hello") return;
      refreshSnap().catch(() => undefined);
      setSel((current) => {
        if (current.kind === "channel") {
          loadChannel(current.id).catch(() => undefined);
        }
        return current;
      });
      setThreadId((tid) => {
        if (tid) {
          setSel((current) => {
            if (current.kind === "channel") {
              api.messages(current.id, tid).then(setThreadPane).catch(() => undefined);
            }
            return current;
          });
        }
        return tid;
      });
    }, setLive);
    const onHash = () => {
      setSel(parseHash());
      setThreadId(null);
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      off();
      window.removeEventListener("hashchange", onHash);
    };
  }, [loadChannel, refreshSnap]);

  useEffect(() => {
    if (sel.kind !== "channel") {
      setPane(null);
      return;
    }
    loadChannel(sel.id).catch((e) => setErr(String(e.message || e)));
  }, [sel, loadChannel]);

  useEffect(() => {
    if (!threadId || sel.kind !== "channel") {
      setThreadPane(null);
      return;
    }
    api.messages(sel.id, threadId).then(setThreadPane).catch((e) => setErr(String(e.message || e)));
  }, [threadId, sel]);

  useEffect(() => {
    const apply = () => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      localStorage.setItem("hivemind-theme", theme);
    };
    if (!themePainted.current) {
      themePainted.current = true;
      apply();
      return;
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
    if (!reduce && doc.startViewTransition) doc.startViewTransition(apply);
    else apply();
  }, [theme]);

  useEffect(() => {
    if (stickBottom.current) bottomRef.current?.scrollIntoView({ block: "end" });
    stickBottom.current = true;
  }, [pane?.messages.length]);
  useEffect(() => {
    threadBottomRef.current?.scrollIntoView({ block: "end" });
  }, [threadPane?.messages.length]);

  const go = (next: Sel) => {
    setThreadId(null);
    setSel(next);
    setHash(next);
  };

  const channels = snap?.channels ?? [];
  const q = query.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);
  const publics = channels.filter(
    (c) => (c.type === "public" || c.type === "brains" || c.type === "private") && match(c.name),
  );
  const myDms = channels.filter((c) => c.type === "dm" && c.memberIds.includes("human") && match(c.name));
  const otherDms = channels.filter((c) => c.type === "dm" && !c.memberIds.includes("human") && match(c.name));
  const roomAgents = (snap?.agents ?? []).filter((a) => {
    if (!q) return true;
    return match(a.name) || match(a.focus ?? "") || match(a.role);
  });

  const activeChannel = sel.kind === "channel" ? channels.find((c) => c.id === sel.id) : undefined;
  const mentionTotal = snap?.mentions.length ?? 0;
  const roomIds = new Set(activeChannel?.memberIds ?? []);

  const send = async (body: string, tid?: string | null) => {
    if (sel.kind !== "channel" || !body.trim()) return;
    await api.send(sel.id, body.trim(), tid);
    if (tid) setThreadDraft("");
    else setDraft("");
    await loadChannel(sel.id);
    if (tid) setThreadPane(await api.messages(sel.id, tid));
    await refreshSnap();
  };

  const onCreate = async () => {
    if (!newName.trim()) return;
    const { channel } = await api.createChannel(
      newName.trim(),
      newType,
      newTopic.trim() || undefined,
      newType === "private" ? newMembers : undefined,
    );
    setCreating(false);
    setNewName("");
    setNewTopic("");
    setNewMembers([]);
    await refreshSnap();
    go({ kind: "channel", id: channel.id });
  };

  const onAgent = async (agent: Agent) => {
    if (agent.id === "human") return;
    const { channel } = await api.openDm(agent.name);
    await refreshSnap();
    go({ kind: "channel", id: channel.id });
  };

  const onClear = async (name: string) => {
    await api.clearContext(name);
    setConfirmClear(null);
    await refreshSnap();
  };

  if (!snap && err) {
    return (
      <div className="boot-fail">
        <p>Hivemind is not responding.</p>
        <p className="muted">Start the server with <code>npm run dev</code>, then open http://127.0.0.1:7420</p>
        <p className="muted">{err}</p>
      </div>
    );
  }

  if (!snap) {
    return (
      <div className="boot-fail">
        <p>Opening the hive…</p>
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <img className="mark" src="/icon.png" alt="Hivemind" />
          <div>
            <div className="word">hivemind</div>
            <div className="you">you are Human</div>
          </div>
          <div className="brand-tools">
            <button
              type="button"
              className="icon-btn"
              title={theme === "dark" ? "Light" : "Dark"}
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <button type="button" className="icon-btn" title="How to join" onClick={() => setHelpOpen(true)}>
              ?
            </button>
            <span className={`pulse ${live ? "on" : ""}`} title={live ? "live" : "waiting"} />
          </div>
        </div>
        <input
          className="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the hive"
        />

        <button className={`nav ${sel.kind === "inbox" ? "active" : ""}`} onClick={() => go({ kind: "inbox" })}>
          <span>For you</span>
          {mentionTotal > 0 && <em>{mentionTotal}</em>}
        </button>

        <div className="group">
          <div className="group-h">
            <button
              type="button"
              className="twist"
              onClick={() => setOpenGroups((g) => ({ ...g, channels: !g.channels }))}
              aria-expanded={openGroups.channels}
            >
              {openGroups.channels ? "▾" : "▸"}
            </button>
            <span>Channels</span>
            <button type="button" className="plus" onClick={() => setCreating(true)} title="New channel">
              +
            </button>
          </div>
          {openGroups.channels &&
            publics.map((ch) => (
              <ChannelItem
                key={ch.id}
                ch={ch}
                unread={snap.unread[ch.id] ?? 0}
                active={sel.kind === "channel" && sel.id === ch.id}
                onClick={() => go({ kind: "channel", id: ch.id })}
              />
            ))}
        </div>

        <div className="group">
          <div className="group-h">
            <button
              type="button"
              className="twist"
              onClick={() => setOpenGroups((g) => ({ ...g, dms: !g.dms }))}
              aria-expanded={openGroups.dms}
            >
              {openGroups.dms ? "▾" : "▸"}
            </button>
            <span>Direct messages</span>
          </div>
          {openGroups.dms && myDms.length === 0 && <div className="empty-mini">No direct messages</div>}
          {openGroups.dms &&
            myDms.map((ch) => (
              <ChannelItem
                key={ch.id}
                ch={ch}
                unread={snap.unread[ch.id] ?? 0}
                active={sel.kind === "channel" && sel.id === ch.id}
                onClick={() => go({ kind: "channel", id: ch.id })}
              />
            ))}
        </div>

        {otherDms.length > 0 && (
          <div className="group">
            <div className="group-h">
              <button
                type="button"
                className="twist"
                onClick={() => setOpenGroups((g) => ({ ...g, other: !g.other }))}
                aria-expanded={openGroups.other}
              >
                {openGroups.other ? "▾" : "▸"}
              </button>
              <span>Other directs</span>
            </div>
            {openGroups.other &&
              otherDms.map((ch) => (
                <ChannelItem
                  key={ch.id}
                  ch={ch}
                  unread={snap.unread[ch.id] ?? 0}
                  active={sel.kind === "channel" && sel.id === ch.id}
                  onClick={() => go({ kind: "channel", id: ch.id })}
                />
              ))}
          </div>
        )}
      </aside>

      <main className="desk">
        {sel.kind === "inbox" ? (
          <Inbox mentions={snap.mentions} agents={snap.agents} onOpen={(id) => go({ kind: "channel", id })} />
        ) : (
          <>
            <header className="desk-h">
              <div>
                <h1>{activeChannel ? channelTitle(activeChannel) : sel.id}</h1>
                {activeChannel?.topic && <p>{activeChannel.topic}</p>}
                {activeChannel && (
                  <p className="members">
                    {memberNames(activeChannel, snap.agents)}
                  </p>
                )}
              </div>
              {activeChannel?.type === "private" && (
                <button type="button" className="text-btn" onClick={() => setInviteOpen(true)}>
                  Invite
                </button>
              )}
            </header>
            <div className="stream">
              {pane?.hasOlder && (
                <button
                  type="button"
                  className="older"
                  onClick={() => {
                    const oldest = pane.messages[0]?.seq;
                    if (!oldest || sel.kind !== "channel") return;
                    stickBottom.current = false;
                    api.messages(sel.id, null, oldest).then((older) => {
                      setPane({
                        ...older,
                        messages: [...older.messages, ...pane.messages],
                        hasOlder: older.hasOlder,
                      });
                    });
                  }}
                >
                  Load older
                </button>
              )}
              {(pane?.messages ?? []).map((m) => (
                <Msg
                  key={m.id}
                  m={m}
                  replies={pane?.replyCounts[m.id] ?? 0}
                  status={pane?.threads.find((t) => t.id === m.id)?.status ?? null}
                  onThread={() => setThreadId(m.id)}
                />
              ))}
              <div ref={bottomRef} />
            </div>
            <Composer
              agents={snap.agents}
              value={draft}
              onChange={setDraft}
              placeholder={
                activeChannel
                  ? `Message ${channelTitle(activeChannel)}`
                  : "Write…"
              }
              onSend={() => send(draft)}
            />
          </>
        )}
        {err && (
          <div className="err" onClick={() => setErr(null)}>
            {err}
          </div>
        )}
      </main>

      {threadId && threadPane && sel.kind === "channel" && (
        <aside className="thread">
          <header className="desk-h">
            <div>
              <h1>Thread</h1>
              <p>replies on this message</p>
            </div>
            <div className="thread-tools">
              <select
                value={threadPane.threads.find((t) => t.id === threadId)?.status ?? "open"}
                onChange={(e) => {
                  const status = e.target.value as ThreadStatus;
                  api.setStatus(threadId, status).then(() =>
                    api.messages(sel.id, threadId).then(setThreadPane),
                  );
                }}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace("_", " ")}
                  </option>
                ))}
              </select>
              <button type="button" className="plus" onClick={() => setThreadId(null)}>
                ×
              </button>
            </div>
          </header>
          <div className="stream">
            {threadPane.messages.map((m) => (
              <Msg key={m.id} m={m} replies={0} status={null} />
            ))}
            <div ref={threadBottomRef} />
          </div>
          <Composer
            agents={snap.agents}
            value={threadDraft}
            onChange={setThreadDraft}
            placeholder="Reply in thread…"
            onSend={() => send(threadDraft, threadId)}
          />
        </aside>
      )}

      <aside className="hive">
        <div className="group-h">Hive</div>
        <AgentList
          agents={roomAgents}
          presentIds={roomIds}
          onOpen={onAgent}
          confirmClear={confirmClear}
          setConfirmClear={setConfirmClear}
          onClear={onClear}
        />
      </aside>

      {creating && (
        <div className="modal" onClick={() => setCreating(false)}>
          <form
            className="sheet"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              onCreate().catch((ex) => setErr(String(ex.message || ex)));
            }}
          >
            <h2>New channel</h2>
            <label>
              Name
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="frontend" autoFocus />
            </label>
            <label>
              Topic
              <input value={newTopic} onChange={(e) => setNewTopic(e.target.value)} placeholder="optional" />
            </label>
            <label>
              Visibility
              <select value={newType} onChange={(e) => setNewType(e.target.value as "public" | "private")}>
                <option value="public">public — everyone</option>
                <option value="private">private — invited</option>
              </select>
            </label>
            {newType === "private" && (
              <fieldset className="checks">
                <legend>Members</legend>
                {snap.agents.filter((a) => a.role !== "human").map((a) => (
                  <label key={a.id} className="check">
                    <input
                      type="checkbox"
                      checked={newMembers.includes(a.name)}
                      onChange={(e) =>
                        setNewMembers((cur) =>
                          e.target.checked ? [...cur, a.name] : cur.filter((n) => n !== a.name),
                        )
                      }
                    />
                    {a.name}
                  </label>
                ))}
              </fieldset>
            )}
            <div className="row">
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button type="submit" className="primary">
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {inviteOpen && activeChannel && (
        <div className="modal" onClick={() => setInviteOpen(false)}>
          <form
            className="sheet"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              api
                .invite(activeChannel.id, inviteNames)
                .then(async () => {
                  setInviteOpen(false);
                  setInviteNames([]);
                  await refreshSnap();
                  if (sel.kind === "channel") await loadChannel(sel.id);
                })
                .catch((ex) => setErr(String(ex.message || ex)));
            }}
          >
            <h2>Invite to #{activeChannel.name}</h2>
            <fieldset className="checks">
              <legend>Agents</legend>
              {snap.agents
                .filter((a) => a.role !== "human" && !activeChannel.memberIds.includes(a.id))
                .map((a) => (
                  <label key={a.id} className="check">
                    <input
                      type="checkbox"
                      checked={inviteNames.includes(a.name)}
                      onChange={(e) =>
                        setInviteNames((cur) =>
                          e.target.checked ? [...cur, a.name] : cur.filter((n) => n !== a.name),
                        )
                      }
                    />
                    {a.name} · {a.role}
                  </label>
                ))}
            </fieldset>
            <div className="row">
              <button type="button" onClick={() => setInviteOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="primary">
                Invite
              </button>
            </div>
          </form>
        </div>
      )}

      {helpOpen && (
        <div className="modal" onClick={() => setHelpOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>How to join</h2>
            <p className="help-p">
              You open Codex, Claude, or Cursor yourself, pick the model, then register that terminal. Hivemind never wakes a closed session.
            </p>
            <pre>{`npx tsx src/cli.ts mcp-config
npx tsx src/cli.ts join --as brain
npx tsx src/cli.ts join --as worker --seniority senior
export HIVEMIND_TOKEN=hm_…
npx tsx src/cli.ts wait`}</pre>
            <p className="help-p">
              Workers talk to brains only. Brains ask @Human here. Click an agent to DM them — including workers.
            </p>
            <div className="row">
              <button type="button" className="primary" onClick={() => setHelpOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ChannelItem({
  ch,
  unread,
  active,
  onClick,
}: {
  ch: Channel;
  unread: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`nav ${active ? "active" : ""} ${unread ? "unread" : ""}`} onClick={onClick}>
      <span>{ch.type === "dm" ? ch.name : `# ${ch.name}`}</span>
      {unread > 0 && <em>{unread}</em>}
    </button>
  );
}

function Inbox({
  mentions,
  agents,
  onOpen,
}: {
  mentions: Message[];
  agents: Agent[];
  onOpen: (channelId: string) => void;
}) {
  return (
    <>
      <header className="desk-h">
        <div>
          <h1>For you</h1>
          <p>@Human mentions. Brains ask you here when a cycle is done or when they are stuck.</p>
        </div>
      </header>
      <div className="stream">
        {mentions.length === 0 && (
          <div className="empty">
            No mentions. When a brain needs you, it shows up here.
          </div>
        )}
        {mentions.map((m) => (
          <button key={m.id} className="inbox-item" onClick={() => onOpen(m.channelId)}>
            <Msg m={m} replies={0} status={null} />
            <span className="open-link">open conversation</span>
          </button>
        ))}
      </div>
      <div className="hint">
        {agents.filter((a) => a.role !== "human").length === 0
          ? "Nobody in the hive yet. Open a Codex, Claude, or Cursor terminal and join."
          : "You set the goals. Brains dispatch. Workers execute."}
      </div>
    </>
  );
}

function Msg({
  m,
  replies,
  status,
  onThread,
}: {
  m: Message;
  replies: number;
  status: ThreadStatus | null;
  onThread?: () => void;
}) {
  const time = new Date(m.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return (
    <article className={`msg role-${m.authorRole} kind-${m.kind}`}>
      <Avatar name={m.authorName} role={m.authorRole} />
      <div>
        <div className="msg-h">
          <strong>{m.authorName}</strong>
          <span className="role">{m.authorRole}</span>
          <time>{time}</time>
          {status && <span className={`st st-${status}`}>{status.replace("_", " ")}</span>}
        </div>
        <div className="msg-b">{renderBody(m.body)}</div>
        {onThread && m.kind === "chat" && (
          <button type="button" className="replies" onClick={onThread}>
            {replies > 0 ? `${replies} ${replies === 1 ? "reply" : "replies"}` : "Thread"}
          </button>
        )}
      </div>
    </article>
  );
}

function Composer({
  agents,
  value,
  onChange,
  onSend,
  placeholder,
}: {
  agents: Agent[];
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  placeholder: string;
}) {
  const [hint, setHint] = useState<Agent[]>([]);
  const names = useMemo(() => agents, [agents]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const onInput = (v: string) => {
    onChange(v);
    const at = v.split(/\s/).pop() ?? "";
    if (at.startsWith("@") && at.length > 1) {
      const q = at.slice(1).toLowerCase();
      setHint(names.filter((a) => a.name.toLowerCase().startsWith(q)).slice(0, 6));
    } else setHint([]);
  };

  return (
    <div className="composer">
      {hint.length > 0 && (
        <ul className="hints">
          {hint.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => {
                  onChange(value.replace(/@\w*$/, `@${a.name} `));
                  setHint([]);
                }}
              >
                @{a.name}
                <small>{a.role}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer-box">
        <textarea
          rows={2}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onKey}
        />
        <button type="button" className="send" onClick={onSend} disabled={!value.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}

function avatarHue(name: string): number {
  return [...name].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 360;
}

function Avatar({ name, role, online, small }: { name: string; role?: string; online?: boolean; small?: boolean }) {
  return (
    <span
      className={`avatar ${small ? "sm" : ""} role-${role ?? ""}`}
      style={{ "--h": String(avatarHue(name)) } as CSSProperties}
      data-on={online ? "1" : undefined}
      title={name}
    >
      {name.slice(0, 2)}
    </span>
  );
}

function AgentList({
  agents,
  presentIds,
  onOpen,
  confirmClear,
  setConfirmClear,
  onClear,
}: {
  agents: Agent[];
  presentIds: Set<string>;
  onOpen: (a: Agent) => void;
  confirmClear: string | null;
  setConfirmClear: (n: string | null) => void;
  onClear: (n: string) => void;
}) {
  const human = agents.find((a) => a.role === "human");
  const brains = agents.filter((a) => a.role === "brain");
  const workers = agents.filter((a) => a.role === "worker");
  const rank = { senior: 0, mid: 1, junior: 2 } as const;
  workers.sort((a, b) => (rank[a.seniority ?? "mid"] ?? 3) - (rank[b.seniority ?? "mid"] ?? 3) || a.name.localeCompare(b.name));
  const away = (id: string) => presentIds.size > 0 && !presentIds.has(id);

  return (
    <div className="agents">
      {human && <PersonRow agent={human} onOpen={() => undefined} self away={away(human.id)} />}
      {brains.length > 0 && <div className="subh">brain</div>}
      {brains.map((a) => (
        <PersonRow key={a.id} agent={a} onOpen={() => onOpen(a)} away={away(a.id)} />
      ))}
      {workers.length > 0 && <div className="subh">worker</div>}
      {workers.map((a) => (
        <PersonRow
          key={a.id}
          agent={a}
          onOpen={() => onOpen(a)}
          away={away(a.id)}
          confirmClear={confirmClear}
          setConfirmClear={setConfirmClear}
          onClear={onClear}
        />
      ))}
      {brains.length + workers.length === 0 && (
        <p className="empty-mini">
          Open Codex, Claude, or Cursor, then <code>hivemind join --as brain</code> or{" "}
          <code>--as worker --seniority senior</code>
        </p>
      )}
    </div>
  );
}

function PersonRow({
  agent,
  onOpen,
  self,
  away,
  confirmClear,
  setConfirmClear,
  onClear,
}: {
  agent: Agent;
  onOpen: () => void;
  self?: boolean;
  away?: boolean;
  confirmClear?: string | null;
  setConfirmClear?: (n: string | null) => void;
  onClear?: (n: string) => void;
}) {
  const bars = seniorityBars(agent);
  return (
    <div className={`person ${agent.online ? "on" : "off"} ${away ? "away" : ""}`}>
      <button type="button" className="person-main" onClick={onOpen} disabled={self}>
        <Avatar name={agent.name} role={agent.role} online={agent.online} small />
        <span className="pn">{agent.name}</span>
        {bars > 0 && (
          <span className="stripes" title={agent.seniority ?? ""}>
            {Array.from({ length: bars }, (_, i) => (
              <i key={i} />
            ))}
          </span>
        )}
        {agent.seniority && <span className="sen">{agent.seniority}</span>}
        {agent.focus && <span className="focus">{agent.focus}</span>}
      </button>
      {agent.role === "worker" && setConfirmClear && onClear && (
        confirmClear === agent.name ? (
          <span className="clear-ask">
            <button type="button" onClick={() => onClear(agent.name)}>
              clear
            </button>
            <button type="button" onClick={() => setConfirmClear(null)}>
              no
            </button>
          </span>
        ) : (
          <button type="button" className="ghost" title="clear context" onClick={() => setConfirmClear(agent.name)}>
            ⌧
          </button>
        )
      )}
    </div>
  );
}
