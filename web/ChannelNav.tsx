import type { Channel } from "../src/shared/types.ts";

export function ChannelItem({
  ch,
  unread,
  active,
  onClick,
  onUnread,
}: {
  ch: Channel;
  unread: number;
  active: boolean;
  onClick: () => void;
  onUnread: () => void;
}) {
  return (
    <div className={`nav ${active ? "active" : ""} ${unread ? "unread" : ""}`}>
      <button type="button" className="nav-open" onClick={onClick}>
        <span>{ch.type === "dm" ? ch.name : `# ${ch.name}`}</span>
      </button>
      {unread > 0 && <button type="button" className="unread-jump" onClick={onUnread}
        title="Jump to last unread message"
        aria-label={`Jump to last unread message in ${ch.name} (${unread} unread)`}>
        <em>{unread}</em>
      </button>}
    </div>
  );
}

export function DmRow({
  ch,
  unread,
  active,
  menuOpen,
  onClick,
  onMenu,
  onClose,
  onUnread,
}: {
  ch: Channel;
  unread: number;
  active: boolean;
  menuOpen: boolean;
  onClick: () => void;
  onMenu: () => void;
  onClose: () => void;
  onUnread: () => void;
}) {
  return (
    <div className={`dm-row ${ch.memberIds.includes("human") ? "with-human" : "between-agents"}`}>
      <ChannelItem ch={ch} unread={unread} active={active} onClick={onClick} onUnread={onUnread} />
      <button
        type="button"
        className={`kebab ${menuOpen ? "on" : ""}`}
        title="Conversation actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={onMenu}
      >
        ⋯
      </button>
      {menuOpen && (
        <div className="person-menu" role="menu">
          <button type="button" role="menuitem" onClick={onClose}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
