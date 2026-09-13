import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { Agent, Channel, Message, Thread, ThreadStatus } from "../src/shared/types.ts";
import { REACTION_EMOJIS } from "../src/shared/types.ts";
import { api, connectWs, type ChannelPayload, type Snapshot, type TelegramSettings } from "./api.ts";
import { LaunchSheet } from "./LaunchSheet.tsx";
import { renderBody } from "./markdown.tsx";

type Sel = { kind: "inbox"; project: string } | { kind: "channel"; id: string };

const STATUSES: ThreadStatus[] = ["open", "in_progress", "blocked", "done"];

function parseHash(): Sel {
  const raw = location.hash.replace(/^#/, "") || "/c/general";
  const parts = raw.split("/").filter(Boolean);
  if (parts[0] === "inbox") return { kind: "inbox", project: parts[1] ? decodeURIComponent(parts[1]) : "" };
  if (parts[1]) return { kind: "channel", id: decodeURIComponent(parts[1]) };
  return { kind: "channel", id: "general" };
}

function patchPane(pane: ChannelPayload | null, msg: Message, viewingThread: string | null = null): ChannelPayload | null {
  if (!pane || pane.channel.id !== msg.channelId) return pane;
  if (pane.messages.some((m) => m.id === msg.id)) return pane;
  if (viewingThread) {
    if (msg.threadId === viewingThread || msg.id === viewingThread) {
      return { ...pane, messages: [...pane.messages, msg] };
    }
    return pane;
  }
  if (msg.threadId) {
    return {
      ...pane,
      replyCounts: { ...pane.replyCounts, [msg.threadId]: (pane.replyCounts[msg.threadId] ?? 0) + 1 },
    };
  }
  return { ...pane, messages: [...pane.messages, msg] };
}

function replaceMessage(pane: ChannelPayload | null, msg: Message): ChannelPayload | null {
  if (!pane) return pane;
  if (!pane.messages.some((m) => m.id === msg.id)) return pane;
  return { ...pane, messages: pane.messages.map((m) => (m.id === msg.id ? msg : m)) };
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  if (list.some((x) => x.id === item.id)) return list.map((x) => (x.id === item.id ? item : x));
  return [...list, item];
}

function applyMessageToSnap(snap: Snapshot, msg: Message, viewingId: string | null): Snapshot {
  const unread = { ...snap.unread };
  if (msg.authorId !== snap.you.id && msg.channelId !== viewingId) {
    unread[msg.channelId] = (unread[msg.channelId] ?? 0) + 1;
  }
  let mentions = snap.mentions;
  if (msg.mentions.includes("human") && msg.channelId !== viewingId) {
    mentions = [msg, ...mentions.filter((m) => m.id !== msg.id)].slice(0, 30);
  }
  return { ...snap, unread, mentions };
}

function setHash(sel: Sel) {
  location.hash =
    sel.kind === "inbox"
      ? sel.project
        ? `/inbox/${encodeURIComponent(sel.project)}`
        : "/inbox"
      : `/c/${encodeURIComponent(sel.id)}`;
}

function repairSel(sel: Sel, snap: Snapshot): Sel | null {
  if (sel.kind === "inbox") {
    if (!sel.project) return snap.projects[0] ? { kind: "inbox", project: snap.projects[0].slug } : null;
    if (snap.projects.some((p) => p.slug === sel.project)) return null;
    const fallback = snap.projects[0];
    return fallback ? { kind: "inbox", project: fallback.slug } : { kind: "inbox", project: "" };
  }
  if (snap.channels.some((c) => c.id === sel.id)) return null;
  const fallback = snap.projects[0];
  return fallback ? { kind: "inbox", project: fallback.slug } : { kind: "inbox", project: "" };
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
  const [launchOpen, setLaunchOpen] = useState(false);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [telegram, setTelegram] = useState<TelegramSettings | null>(null);
  const [tgToken, setTgToken] = useState("");
  const [tgUsers, setTgUsers] = useState("");
  const [tgGroups, setTgGroups] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("hivemind-theme");
    return saved === "dark" ? "dark" : "light";
  });
  const [openProjects, setOpenProjects] = useState<Record<string, boolean>>({});
  const [creatingProject, setCreatingProject] = useState(false);
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectSlug, setNewProjectSlug] = useState("");
  const [newProjectTree, setNewProjectTree] = useState("");
  const [projectDeleteConfirm, setProjectDeleteConfirm] = useState("");
  const [deletingProject, setDeletingProject] = useState(false);
  const [createIn, setCreateIn] = useState<string | null>(null);
  const stickBottom = useRef(true);
  const themePainted = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const threadBottomRef = useRef<HTMLDivElement>(null);
  const selRef = useRef(sel);
  selRef.current = sel;
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const refreshSnap = useCallback(async () => {
    const next = await api.snapshot();
    setSnap(next);
    return next;
  }, []);

  const loadChannel = useCallback(async (id: string) => {
    const data = await api.messages(id);
    setPane(data);
    setSnap((s) =>
      s
        ? {
            ...s,
            unread: { ...s.unread, [id]: 0 },
            mentions: s.mentions.filter((m) => m.channelId !== id),
          }
        : s,
    );
  }, []);

  useEffect(() => {
    refreshSnap().catch((e) => setErr(String(e.message || e)));
    const off = connectWs((ev) => {
      if (ev.type === "hello") {
        refreshSnap().catch(() => undefined);
        return;
      }
      if (ev.type === "message") {
        const msg = ev.payload as Message;
        setPane((p) => patchPane(p, msg, null));
        setThreadPane((p) => patchPane(p, msg, threadIdRef.current));
        const viewing = selRef.current.kind === "channel" ? selRef.current.id : null;
        setSnap((s) => (s ? applyMessageToSnap(s, msg, viewing) : s));
        return;
      }
      if (ev.type === "reaction") {
        const payload = ev.payload as { message?: Message };
        if (payload.message) {
          setPane((p) => replaceMessage(p, payload.message!));
          setThreadPane((p) => replaceMessage(p, payload.message!));
        }
        return;
      }
      if (ev.type === "agent") {
        const agent = ev.payload as Agent;
        setSnap((s) => (s ? { ...s, agents: upsertById(s.agents, agent) } : s));
        return;
      }
      if (ev.type === "channel") {
        const ch = ev.payload as Channel;
        setSnap((s) => (s ? { ...s, channels: upsertById(s.channels, ch) } : s));
        return;
      }
      if (ev.type === "thread") {
        const thread = ev.payload as Thread;
        setPane((p) => {
          if (!p || p.channel.id !== thread.channelId) return p;
          return { ...p, threads: upsertById(p.threads, thread) };
        });
        return;
      }
      if (ev.type === "queued") {
        const q = ev.payload as { agentId: string; n: number };
        setSnap((s) => (s ? { ...s, queued: { ...s.queued, [q.agentId]: q.n } } : s));
        return;
      }
      if (ev.type === "project") {
        refreshSnap().catch(() => undefined);
        return;
      }
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

  const missingChannel = Boolean(snap && sel.kind === "channel" && !snap.channels.some((c) => c.id === sel.id));

  useEffect(() => {
    if (!snap) return;
    const next = repairSel(sel, snap);
    if (!next) return;
    setThreadId(null);
    setSel(next);
    setHash(next);
  }, [snap, sel]);

  useEffect(() => {
    if (!snap) return;
    if (editingProject && !snap.projects.some((p) => p.slug === editingProject)) {
      setEditingProject(null);
      setProjectDeleteConfirm("");
      setDeletingProject(false);
    }
    if (createIn && !snap.projects.some((p) => p.slug === createIn)) setCreateIn(null);
  }, [snap, editingProject, createIn]);

  useEffect(() => {
    if (sel.kind !== "channel") {
      setPane(null);
      return;
    }
    if (missingChannel) {
      setPane(null);
      return;
    }
    loadChannel(sel.id).catch((e) => setErr(String(e.message || e)));
  }, [sel, loadChannel, missingChannel]);

  useEffect(() => {
    if (!threadId || sel.kind !== "channel" || missingChannel) {
      setThreadPane(null);
      return;
    }
    api.messages(sel.id, threadId).then(setThreadPane).catch((e) => setErr(String(e.message || e)));
  }, [threadId, sel, missingChannel]);

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
  const projects = snap?.projects ?? [];
  const q = query.trim().toLowerCase();
  const match = (name: string) => !q || name.toLowerCase().includes(q);
  const activeChannel = sel.kind === "channel" ? channels.find((c) => c.id === sel.id) : undefined;
  const selectedProject =
    sel.kind === "inbox" ? sel.project : (activeChannel?.project ?? projects[0]?.slug ?? "chapter");
  const editingBusy = editingProject
    ? (snap?.agents ?? []).filter((a) => a.role !== "human" && a.project === editingProject && a.online)
    : [];
  const canDeleteProject =
    Boolean(editingProject) &&
    !deletingProject &&
    projectDeleteConfirm.trim().toLowerCase() === editingProject &&
    editingBusy.length === 0;
  const roomAgents = (snap?.agents ?? []).filter((a) => {
    if (a.role !== "human" && a.project && a.project !== selectedProject) return false;
    if (!q) return true;
    return match(a.name) || match(a.focus ?? "") || match(a.role);
  });
  const mentionTotal = (slug: string) =>
    (snap?.mentions ?? []).filter((m) => channels.find((c) => c.id === m.channelId)?.project === slug).length;
  const inboxMentions = (snap?.mentions ?? []).filter(
    (m) => channels.find((c) => c.id === m.channelId)?.project === (sel.kind === "inbox" ? sel.project : selectedProject),
  );

  const send = async (body: string, tid?: string | null, files?: File[]) => {
    if (sel.kind !== "channel") return;
    const attachmentIds: string[] = [];
    for (const file of files ?? []) {
      attachmentIds.push((await api.upload(file)).id);
    }
    if (!body.trim() && attachmentIds.length === 0) return;
    await api.send(sel.id, body.trim(), tid, attachmentIds);
    if (tid) setThreadDraft("");
    else setDraft("");
    if (tid) setThreadPane(await api.messages(sel.id, tid));
  };

  const onCreate = async () => {
    if (!newName.trim()) return;
    const project = createIn ?? activeChannel?.project ?? snap?.projects[0]?.slug;
    const { channel } = await api.createChannel(
      newName.trim(),
      newType,
      newTopic.trim() || undefined,
      newType === "private" ? newMembers : undefined,
      project,
    );
    setCreating(false);
    setCreateIn(null);
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
            <button
              type="button"
              className="icon-btn"
              title="Telegram"
              onClick={() => {
                api
                  .telegram()
                  .then((t) => {
                    setTelegram(t);
                    setTgToken("");
                    setTgUsers(t.allowUserIds.join(", "));
                    setTgGroups(
                      Object.fromEntries(
                        (snap?.projects ?? []).map((p) => [
                          p.slug,
                          t.projects[p.slug] != null ? String(t.projects[p.slug]) : "",
                        ]),
                      ),
                    );
                    setTelegramOpen(true);
                  })
                  .catch((e) => setErr(String(e.message || e)));
              }}
            >
              {snap.telegram?.running ? "✈" : "⌬"}
            </button>
            <button type="button" className="icon-btn" title="Launch agent" onClick={() => setLaunchOpen(true)}>
              ▶
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

        <div className="group-h">
          <span>Projects</span>
          <button type="button" className="plus" onClick={() => setCreatingProject(true)} title="New project">
            +
          </button>
        </div>

        {projects.length === 0 && <p className="help-p">No projects.</p>}
        {projects.map((project) => {
          const open = openProjects[project.slug] ?? project.slug === selectedProject;
          const publics = channels.filter(
            (c) =>
              c.project === project.slug &&
              (c.type === "public" || c.type === "brains" || c.type === "private") &&
              match(c.name),
          );
          const myDms = channels.filter(
            (c) => c.project === project.slug && c.type === "dm" && c.memberIds.includes("human") && match(c.name),
          );
          const otherDms = channels.filter(
            (c) => c.project === project.slug && c.type === "dm" && !c.memberIds.includes("human") && match(c.name),
          );
          const hiveAgents = (snap.agents ?? []).filter(
            (a) => a.role === "human" || a.project === project.slug,
          ).filter((a) => !q || match(a.name) || match(a.focus ?? "") || match(a.role));
          const n = mentionTotal(project.slug);
          return (
            <div key={project.id} className="project-sec">
              <div className="group-h">
                <button
                  type="button"
                  className="twist"
                  onClick={() => setOpenProjects((g) => ({ ...g, [project.slug]: !open }))}
                  aria-expanded={open}
                >
                  {open ? "▾" : "▸"}
                </button>
                <span>{project.name}</span>
                {n > 0 && <em className="sec-badge">{n}</em>}
                <button
                  type="button"
                  className="plus"
                  title="Project settings"
                  onClick={() => {
                    setEditingProject(project.slug);
                    setNewProjectName(project.name);
                    setNewProjectTree(project.worktree ?? "");
                    setProjectDeleteConfirm("");
                  }}
                >
                  …
                </button>
              </div>
              {open && (
                <>
                  <button
                    className={`nav ${sel.kind === "inbox" && sel.project === project.slug ? "active" : ""}`}
                    onClick={() => go({ kind: "inbox", project: project.slug })}
                  >
                    <span>For you</span>
                    {n > 0 && <em>{n}</em>}
                  </button>
                  <div className="group">
                    <div className="group-h">
                      <span>Channels</span>
                      <button
                        type="button"
                        className="plus"
                        onClick={() => {
                          setCreateIn(project.slug);
                          setCreating(true);
                        }}
                        title="New channel"
                      >
                        +
                      </button>
                    </div>
                    {publics.map((ch) => (
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
                      <span>Direct messages</span>
                    </div>
                    {myDms.length === 0 && <div className="empty-mini">No direct messages</div>}
                    {myDms.map((ch) => (
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
                        <span>Other directs</span>
                      </div>
                      {otherDms.map((ch) => (
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
                  <div className="group">
                    <div className="group-h">
                      <span>Hive</span>
                    </div>
                    <AgentList
                      agents={hiveAgents}
                      queued={snap.queued ?? {}}
                      onOpen={onAgent}
                      confirmClear={confirmClear}
                      setConfirmClear={setConfirmClear}
                      onClear={onClear}
                    />
                  </div>
                </>
              )}
            </div>
          );
        })}
      </aside>

      <main className="desk">
        {projects.length === 0 ? (
          <header className="desk-h">
            <div>
              <h1>No projects</h1>
              <p>Create one from the sidebar. The worktree on disk is never deleted.</p>
            </div>
          </header>
        ) : sel.kind === "inbox" ? (
          <Inbox
            mentions={inboxMentions}
            hasMore={Boolean(snap.mentionsHasMore)}
            agents={snap.agents.filter((a) => a.role === "human" || a.project === sel.project)}
            onOpen={(id) => go({ kind: "channel", id })}
            onOlder={() => {
              const oldest = inboxMentions[inboxMentions.length - 1]?.seq;
              if (!oldest || !projects.some((p) => p.slug === sel.project)) return;
              api.mentions(oldest, sel.project).then((page) => {
                setSnap((s) =>
                  s
                    ? {
                        ...s,
                        mentions: [...s.mentions, ...page.messages.filter((m) => !s.mentions.some((x) => x.id === m.id))],
                        mentionsHasMore: page.hasMore,
                      }
                    : s,
                );
              }).catch((e) => setErr(String(e.message || e)));
            }}
            onMarkSeen={() => {
              if (!projects.some((p) => p.slug === sel.project)) return;
              api.markMentionsSeen(sel.project).then((page) => {
                setSnap((s) =>
                  s
                    ? {
                        ...s,
                        mentions: [
                          ...s.mentions.filter((m) => channels.find((c) => c.id === m.channelId)?.project !== sel.project),
                          ...page.messages,
                        ],
                        mentionsHasMore: page.hasMore,
                        unread: page.unread,
                      }
                    : s,
                );
              }).catch((e) => setErr(String(e.message || e)));
            }}
          />
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
                  onReact={(emoji) => api.react(m.seq, emoji).then((r) => setPane((p) => replaceMessage(p, r.message)))}
                />
              ))}
              <div ref={bottomRef} />
            </div>
            <Composer
              agents={roomAgents}
              value={draft}
              onChange={setDraft}
              placeholder={
                activeChannel
                  ? `Message ${channelTitle(activeChannel)}`
                  : "Write…"
              }
              onSend={(files) => send(draft, undefined, files)}
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
              <Msg
                key={m.id}
                m={m}
                replies={0}
                status={null}
                onReact={(emoji) => api.react(m.seq, emoji).then((r) => setThreadPane((p) => replaceMessage(p, r.message)))}
              />
            ))}
            <div ref={threadBottomRef} />
          </div>
          <Composer
            agents={roomAgents}
            value={threadDraft}
            onChange={setThreadDraft}
            placeholder="Reply in thread…"
            onSend={(files) => send(threadDraft, threadId, files)}
          />
        </aside>
      )}

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
                {snap.agents
                  .filter((a) => a.role !== "human" && (!createIn || a.project === createIn))
                  .map((a) => (
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
                .filter(
                  (a) =>
                    a.role !== "human" &&
                    a.project === activeChannel.project &&
                    !activeChannel.memberIds.includes(a.id),
                )
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

      {editingProject && (
        <div
          className="modal"
          onClick={() => {
            setEditingProject(null);
            setProjectDeleteConfirm("");
          }}
        >
          <form
            className="sheet"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              api
                .updateProject(editingProject, {
                  name: newProjectName.trim(),
                  worktree: newProjectTree.trim() || null,
                })
                .then(async () => {
                  setEditingProject(null);
                  setProjectDeleteConfirm("");
                  await refreshSnap();
                })
                .catch((ex) => setErr(String(ex.message || ex)));
            }}
          >
            <h2>Project {editingProject}</h2>
            <label>
              Name
              <input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} autoFocus />
            </label>
            <label>
              Worktree
              <input value={newProjectTree} onChange={(e) => setNewProjectTree(e.target.value)} placeholder="absolute path" />
            </label>
            <p className="help-p">Join from this path, or pass project={editingProject}. Agents cannot see other projects.</p>
            <div className="row">
              <button
                type="button"
                onClick={() => {
                  setEditingProject(null);
                  setProjectDeleteConfirm("");
                }}
              >
                Cancel
              </button>
              <button type="submit" className="primary">
                Save
              </button>
            </div>
            <div className="danger-block">
              <p className="help-p">
                Deletes this hive (channels, mail, roster, Telegram map). Does not touch the worktree.
              </p>
              {editingBusy.length > 0 && (
                <p className="help-p">
                  Cannot delete while {editingBusy.map((a) => a.name).join(", ")}{" "}
                  {editingBusy.length === 1 ? "is" : "are"} still online or waiting.
                </p>
              )}
              <label>
                Type {editingProject} to delete
                <input
                  value={projectDeleteConfirm}
                  onChange={(e) => setProjectDeleteConfirm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.preventDefault();
                  }}
                  autoComplete="off"
                />
              </label>
              <div className="row">
                <button
                  type="button"
                  className="danger"
                  disabled={!canDeleteProject}
                  onClick={() => {
                    setDeletingProject(true);
                    api
                      .deleteProject(editingProject)
                      .then(async () => {
                        setEditingProject(null);
                        setProjectDeleteConfirm("");
                        await refreshSnap();
                      })
                      .catch((ex) => setErr(String(ex.message || ex)))
                      .finally(() => setDeletingProject(false));
                  }}
                >
                  Delete project
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {creatingProject && (
        <div className="modal" onClick={() => setCreatingProject(false)}>
          <form
            className="sheet"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              api
                .createProject(newProjectName.trim(), newProjectSlug.trim() || undefined, newProjectTree.trim() || undefined)
                .then(async ({ project }) => {
                  setCreatingProject(false);
                  setNewProjectName("");
                  setNewProjectSlug("");
                  setNewProjectTree("");
                  await refreshSnap();
                  setOpenProjects((g) => ({ ...g, [project.slug]: true }));
                })
                .catch((ex) => setErr(String(ex.message || ex)));
            }}
          >
            <h2>New project</h2>
            <label>
              Name
              <input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="Another" autoFocus />
            </label>
            <label>
              Slug
              <input value={newProjectSlug} onChange={(e) => setNewProjectSlug(e.target.value)} placeholder="altro" />
            </label>
            <label>
              Worktree
              <input value={newProjectTree} onChange={(e) => setNewProjectTree(e.target.value)} placeholder="absolute path" />
            </label>
            <div className="row">
              <button type="button" onClick={() => setCreatingProject(false)}>
                Cancel
              </button>
              <button type="submit" className="primary">
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {telegramOpen && telegram && (
        <div className="modal" onClick={() => setTelegramOpen(false)}>
          <form
            className="sheet"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const known = new Set(projects.map((p) => p.slug));
              const mapped: Record<string, { groupChatId: string }> = {};
              for (const [slug, raw] of Object.entries(tgGroups)) {
                if (!known.has(slug) || !raw.trim()) continue;
                mapped[slug] = { groupChatId: raw.trim() };
              }
              api
                .saveTelegram({
                  botToken: tgToken.trim() || undefined,
                  allowUserIds: tgUsers.split(/[,\s]+/).filter(Boolean),
                  projects: mapped,
                })
                .then((t) => {
                  setTelegram(t);
                  setTgToken("");
                  setSnap((s) => (s ? { ...s, telegram: { running: t.running, configured: t.configured } } : s));
                })
                .catch((ex) => setErr(String(ex.message || ex)));
            }}
          >
            <h2>Telegram</h2>
            <p className="help-p">
              One bot, one forum group per project. The bot needs admin and Manage Topics. {telegram.running ? "Bridge is on." : "Bridge is off."}
            </p>
            <label>
              Bot token
              <input
                type="password"
                value={tgToken}
                onChange={(e) => setTgToken(e.target.value)}
                placeholder={telegram.tokenHint ? `saved ${telegram.tokenHint}` : "from BotFather"}
                autoComplete="off"
              />
            </label>
            <label>
              Allowed user ids
              <input
                value={tgUsers}
                onChange={(e) => setTgUsers(e.target.value)}
                placeholder="123456789"
              />
            </label>
            {projects.map((p) => (
              <label key={p.id}>
                {p.name} group chat id
                <input
                  value={tgGroups[p.slug] ?? ""}
                  onChange={(e) => setTgGroups((cur) => ({ ...cur, [p.slug]: e.target.value }))}
                  placeholder="-100…"
                />
              </label>
            ))}
            <p className="help-p">Unmapped groups are ignored. Saved next to the hive db, never in git.</p>
            <div className="row">
              <button type="button" onClick={() => setTelegramOpen(false)}>
                Close
              </button>
              <button type="submit" className="primary">
                Save
              </button>
            </div>
          </form>
        </div>
      )}

      {launchOpen && (
        <LaunchSheet
          projects={projects}
          agents={snap.agents}
          defaultProject={selectedProject}
          onClose={() => setLaunchOpen(false)}
        />
      )}

      {helpOpen && (
        <div className="modal" onClick={() => setHelpOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>How to join</h2>
            <p className="help-p">
              You open Codex, Claude, or Cursor yourself, pick the model, then register that terminal. Hivemind never wakes a closed session. Or use Launch to copy a command plus prompt.
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
  hasMore,
  agents,
  onOpen,
  onOlder,
  onMarkSeen,
}: {
  mentions: Message[];
  hasMore: boolean;
  agents: Agent[];
  onOpen: (channelId: string) => void;
  onOlder: () => void;
  onMarkSeen: () => void;
}) {
  return (
    <>
      <header className="desk-h">
        <div>
          <h1>For you</h1>
          <p>@Human mentions. Brains ask you here when a cycle is done or when they are stuck.</p>
        </div>
        {mentions.length > 0 && (
          <button type="button" className="text-btn" onClick={onMarkSeen}>
            Mark seen
          </button>
        )}
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
        {hasMore && (
          <button type="button" className="older" onClick={onOlder}>
            Older mentions
          </button>
        )}
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
  onReact,
}: {
  m: Message;
  replies: number;
  status: ThreadStatus | null;
  onThread?: () => void;
  onReact?: (emoji: string) => void;
}) {
  const time = new Date(m.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const placed = (m.reactions ?? []).filter((r) => r.count > 0);
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
        {m.body && <div className="msg-b">{renderBody(m.body)}</div>}
        {(m.attachments?.length ?? 0) > 0 && (
          <div className="atts">
            {m.attachments!.map((a) =>
              a.mime.startsWith("image/") ? (
                <a key={a.id} href={api.fileUrl(a.id)} target="_blank" rel="noreferrer">
                  <img className="att-img" src={api.fileUrl(a.id)} alt={a.name} />
                </a>
              ) : (
                <a key={a.id} className="att-chip" href={api.fileUrl(a.id)} target="_blank" rel="noreferrer">
                  {a.name}
                  <small>{Math.max(1, Math.round(a.bytes / 1024))} KB</small>
                </a>
              ),
            )}
          </div>
        )}
        {m.kind === "chat" && placed.length > 0 && (
          <div className="reacts">
            {placed.map((hit) => (
              <button
                key={hit.emoji}
                type="button"
                className={`react ${hit.mine ? "mine" : ""}`}
                disabled={!onReact}
                onClick={() => onReact?.(hit.emoji)}
              >
                {hit.emoji}
                <em>{hit.count}</em>
              </button>
            ))}
          </div>
        )}
        {onThread && m.kind === "chat" && (
          <button type="button" className="replies" onClick={onThread}>
            {replies > 0 ? `${replies} ${replies === 1 ? "reply" : "replies"}` : "Thread"}
          </button>
        )}
        {m.kind === "chat" && onReact && (
          <div className="react-pick" role="toolbar" aria-label="Add reaction">
            {REACTION_EMOJIS.map((emoji) => {
              const hit = m.reactions?.find((r) => r.emoji === emoji);
              return (
                <button
                  key={emoji}
                  type="button"
                  className={`react-pick-btn ${hit?.mine ? "mine" : ""}`}
                  title={emoji}
                  onClick={() => onReact(emoji)}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
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
  onSend: (files?: File[]) => void;
  placeholder: string;
}) {
  const [hint, setHint] = useState<Agent[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const names = useMemo(() => agents, [agents]);
  const pick = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | File[]) => {
    const next = [...files, ...Array.from(list)].slice(0, 4);
    setFiles(next);
  };

  const flush = () => {
    onSend(files);
    setFiles([]);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      flush();
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
    <div
      className="composer"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
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
      {files.length > 0 && (
        <ul className="pending-files">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              {f.name}
              <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer-box">
        <input
          ref={pick}
          type="file"
          hidden
          multiple
          accept="image/*,.pdf,.txt,.csv,.json,.zip"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button type="button" className="clip" title="Attach" onClick={() => pick.current?.click()}>
          📎
        </button>
        <textarea
          rows={2}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onKey}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.items]
              .filter((item) => item.kind === "file")
              .map((item) => item.getAsFile())
              .filter((f): f is File => Boolean(f));
            if (pasted.length) {
              e.preventDefault();
              addFiles(pasted);
            }
          }}
        />
        <button type="button" className="send" onClick={flush} disabled={!value.trim() && files.length === 0}>
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
  queued,
  onOpen,
  confirmClear,
  setConfirmClear,
  onClear,
}: {
  agents: Agent[];
  queued: Record<string, number>;
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

  return (
    <div className="agents">
      {human && <PersonRow agent={human} onOpen={() => undefined} self />}
      {brains.length > 0 && <div className="subh">brain</div>}
      {brains.map((a) => (
        <PersonRow key={a.id} agent={a} queued={queued[a.id] ?? 0} onOpen={() => onOpen(a)} />
      ))}
      {workers.length > 0 && <div className="subh">worker</div>}
      {workers.map((a) => (
        <PersonRow
          key={a.id}
          agent={a}
          queued={queued[a.id] ?? 0}
          onOpen={() => onOpen(a)}
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
  queued,
  onOpen,
  self,
  confirmClear,
  setConfirmClear,
  onClear,
}: {
  agent: Agent;
  queued?: number;
  onOpen: () => void;
  self?: boolean;
  confirmClear?: string | null;
  setConfirmClear?: (n: string | null) => void;
  onClear?: (n: string) => void;
}) {
  const bars = seniorityBars(agent);
  return (
    <div className={`person ${agent.online ? "on" : "off"}`}>
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
        {queued ? (
          <em className="queue-badge" title={`${queued} waiting`}>
            {queued > 99 ? "99+" : queued}
          </em>
        ) : null}
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
