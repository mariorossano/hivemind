import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRequestGate } from '../src/shared/read-client.ts';
import { api } from './api.ts';
import type { Sel } from './selection.ts';
import type { Selection } from './use-selection.ts';
import type { ChannelPane } from './use-channel-pane.ts';
import type { ThreadPane } from './use-thread-pane.ts';

type Target = { channelId: string; threadId: string | null; seq: number };

/** Explicit badge navigation. Lookup is read-only; ordinary pane receipts remain unchanged. */
export function useUnreadJump({ selection, channel, thread, go, clearSearch, refreshSnap, setErr }: {
  selection: Selection; channel: ChannelPane; thread: ThreadPane;
  go: (next: Sel) => void; clearSearch: () => void;
  refreshSnap: () => Promise<unknown>; setErr: (error: string) => void;
}) {
  const lookup = useRef(createRequestGate());
  const [target, setTarget] = useState<Target | null>(null);
  const [ready, setReady] = useState<Target | null>(null);
  const { sel, selRef, threadId, threadIdRef } = selection;
  const selected = sel.kind === 'channel' ? sel.id : null;
  const matches = (t: Target) => selRef.current.kind === 'channel' && selRef.current.id === t.channelId && threadIdRef.current === t.threadId;

  const openUnread = async (channelId: string) => {
    const from = selRef.current, request = lookup.current.begin();
    setTarget(null); setReady(null);
    try {
      const { target: next } = await api.lastUnread(channelId, request.signal);
      if (!request.valid() || selRef.current !== from) return;
      if (!next) { setErr('No unread messages remain in this conversation.'); await refreshSnap(); return; }
      if (next.channelId !== channelId || !Number.isSafeInteger(next.seq) || next.seq < 1 || next.seq >= Number.MAX_SAFE_INTEGER)
        throw new Error('Invalid unread destination. Refresh and try again.');
      clearSearch();
      go({ kind: 'channel', id: channelId, thread: next.threadId });
      setTarget(next);
    } catch (error) {
      if (request.valid() && selRef.current === from && (error as Error).name !== 'AbortError') setErr(String(error));
    }
  };
  useEffect(() => () => lookup.current.cancel(), []);

  // Declared after the ordinary conversation-load hooks. Beginning the explicit
  // page load cancels their default GET through the same per-pane request gate.
  useEffect(() => {
    if (!target) return;
    if (!matches(target)) { setTarget(null); setReady(null); return; }
    let cancelled = false;
    const load = target.threadId
      ? thread.loadThread(target.channelId, target.threadId, undefined, true, target.seq)
      : channel.loadChannel(target.channelId, undefined, undefined, target.seq);
    void load.then(loaded => { if (loaded && !cancelled && matches(target)) setReady(target); })
      .catch(error => { if (!cancelled && matches(target) && error?.name !== 'AbortError') setErr(String(error)); });
    return () => { cancelled = true; (target.threadId ? thread.threadLoad : channel.channelLoad).current.cancel(); };
  }, [target, selected, threadId, channel.loadChannel, thread.loadThread]);

  // Ordinary live-bottom anchoring runs first. A held target page prevents later
  // messages from moving the Human away again, including targets in old threads.
  useLayoutEffect(() => {
    if (!ready || !matches(ready)) return;
    const stream = ready.threadId ? thread.threadStream.current : channel.channelStream.current;
    const element = stream?.querySelector<HTMLElement>(`[data-message-seq="${ready.seq}"]`);
    if (!stream || !element) return;
    const scroll = () => { stream.scrollTop += element.getBoundingClientRect().top - stream.getBoundingClientRect().top - 24; };
    element.classList.add('unread-target'); element.tabIndex = -1;
    element.focus({ preventScroll: true }); scroll();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scroll);
    for (const child of Array.from(stream.children)) resize?.observe(child);
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    const release = () => { resize?.disconnect(); for (const event of events) stream.removeEventListener(event, release); };
    for (const event of events) stream.addEventListener(event, release, { passive: true });
    const timer = window.setTimeout(() => { release(); element.classList.remove('unread-target'); }, 2500);
    return () => { release(); window.clearTimeout(timer); element.classList.remove('unread-target'); };
  }, [ready, selected, threadId]);

  return openUnread;
}
