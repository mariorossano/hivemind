# Agent resume

Three identifiers have different jobs: the employee's Hivemind identity, the native Codex/Claude conversation UUID,
and the tmux session label. A tmux label or employee name cannot restore a model conversation.

## Resume a fixed employee or a mixed roster

1. Open **Launch agent → Resume same employees**, or the fixed employee's **Resume** action.
2. Review each card's software, model and effort. Reported Codex/Claude launch settings pre-fill the cards independently;
   Human's per-employee overrides are remembered in this browser by immutable agent ID, so a rename does not lose them.
3. Choose **Resume original conversation** and check the exact conversation UUID. This builds `codex resume UUID`
   or `claude --resume UUID`, with that employee's model/effort. It never uses `--last`, a name-based picker or another
   provider's ID. CLI flags containing competing session selectors are rejected.
4. Include the employees to restart, then copy the selected commands or launch the selected native sessions together.
   Online/verified-running employees are blocked. Removed, archived, pending and task-bound identities are not in this
   roster. A browser without native process evidence cannot prove that an offline agent's old process has exited;
   check it before launching. The native broker retains its existing session-reuse safeguards.

Use **Employee launch options** for each employee's CLI flags and environment. Software accepts the existing launcher
aliases (for example `codex-work` or `claude-work`); defaults recovered from reported metadata identify the provider,
not a custom executable or account. Select the original installation/alias and profile/home when needed. Environment
defaults belong to the exact software string; changing provider clears that card's native ID, model/effort, flags and
environment edits. Other cards are unaffected. No account authentication or credential migration is performed.
Per-card environment edits and manually entered UUIDs live only while this sheet is open, not in browser storage;
environment values do appear in copied shell commands. Do not enter secrets there.

Native resume depends on the original provider's saved session being accessible under the selected profile/home.
An unavailable session is a CLI error, not permission to silently create a new conversation. Launch acknowledgement
only proves that the terminal process started, not that the CLI restored the transcript or joined Hivemind.

## Recording conversation IDs

Generated Codex/Claude prompts ask the agent to include `nativeSession` in its real MCP join: provider, exact conversation
UUID (or null), requested model and effort. The host may expose `CODEX_THREAD_ID` or `CLAUDE_CODE_SESSION_ID` to its shell
tool; the prompt asks to read only that variable, never scan transcripts or guess an ID. This is best-effort reporting:
hosts that do not expose an ID still join normally and show checkpoint recovery instead. Older sessions have no automatic
backfill; Human may enter their known UUID. Changing a model inside the CLI does not update the recorded launch choice.

Migration 41 adds a separate metadata table without changing identities, tasks or credentials. Only Human's project-scoped
launch context exposes these records; agent rosters and UI snapshots do not include conversation IDs. The metadata is
self-reported, not authentication, task authority or verified process liveness. A new join without metadata clears the
previous record so it cannot silently reuse a stale conversation. A repeated authenticated join that omits it preserves
the current record. No transcript or secret is stored here.

## Task-bound workers and changing provider

Task-bound workers resume through the existing task controls, including hard-pause approval and the native kill/launch
acknowledgements. The task launcher uses the saved UUID only if its provider matches the current template. It retains
the current template's executable, flags, environment, model and effort; it does not let a saved report replace executable
configuration or bypass task lifecycle checks.

**New conversation · recover Hivemind checkpoints** starts a new host conversation with the same employee identity.
The generated prompt calls for reading `get_handoffs`, all relevant pages and current task checkpoints/contracts before
acting. This also covers an explicit provider change. Existing task controls decide whether work may resume; old context
does not override stops or replay completed actions. Saved checkpoints can be absent or stale, and unsaved decisions or
work outside Hivemind are not automatically reconstructed. There is no provider-to-provider transcript conversion or
model-generated summarization service. Missing context is reported rather than invented.

CLI references: [Codex resume](https://developers.openai.com/codex/cli/reference/#codex-resume),
[Claude Code CLI](https://code.claude.com/docs/en/cli-reference).
