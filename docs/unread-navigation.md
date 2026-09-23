# Jump to the latest unread message

The unread-count badge beside a channel or direct conversation is a separate
button. Click it (or focus it and press Enter/Space) to open the **newest** unread
message in that conversation. Replies open their thread, including old threads
and replies beyond the initial page. The destination is briefly highlighted and
receives keyboard focus. Clicking the conversation name keeps normal navigation.

The jump loads a bounded historical page ending at the destination; it does not
load the whole conversation. Use Return to live or Refresh thread to resume live
navigation. New messages cannot displace the destination while viewing history.
Repeat the badge action to reach remaining unread messages. If another window
already read them, the UI reports that none remain and refreshes the counts.

## Read state and compatibility

`GET /api/ui/channels/:id/last-unread` is Human-session protected and returns
`{ target: { channelId, threadId, seq } }`, or `{ target: null }`. It applies the
same visibility, author exclusion, legacy read-through and individual receipt
rules as the badge count. It returns ordinary unread messages, not only mentions.
The lookup creates no read receipts and does not move a channel's read cursor.

Existing receipt semantics remain: only pages actually committed to the current
conversation/thread are acknowledged. This is not Mark all read. Other pages,
unopened threads and later live arrivals remain unread. Requests are cancelled
or ignored after navigation, including a second badge action or a delayed page.

No schema migration, agent restart, permission change or monitor change is
required by this feature. Deploy the UI and server endpoint together; a frontend
asset refresh alone cannot add the endpoint to an already-running server.

## Verification

Regression coverage includes ordinary roots, old-thread replies, sparse and
legacy receipts, self-message exclusion, visibility, read-only GETs, historical
pages, full live-arrival windows, repeated same-thread jumps, keyboard activation,
navigation races and empty/failed lookups. Tests use isolated fixtures, not real
Human receipts. Full suite: 1,260 passed, one pre-existing skip; browser: 47 passed.
