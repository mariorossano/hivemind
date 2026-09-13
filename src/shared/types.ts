export const PROTOCOL_VERSION = 2;
export const DEFAULT_PORT = 7420;
export const HUMAN_ID = "human";
export const HUMAN_NAME = "Human";
/** Server-side wait sleep. Long so agents do not burn a model turn every minute. */
export const DEFAULT_WAIT_MS = 1_500_000;
export const BODY_MAX = 4_000;
export const WAIT_MAIL_CAP = 8;
export const PRESENCE_IDLE_MS = 10 * 60 * 1000;
export const MCP_HEARTBEAT_MS = 150_000;
export const FILE_MAX_BYTES = 512 * 1024 * 1024;
export const IMAGE_PREVIEW_MAX_BYTES = 1_500_000;
export const FILES_PER_MESSAGE = 4;
export const WAIT_NEXT =
  "Handle this mail. Then call wait again with no arguments before you stop. Never end a turn without wait in flight.";

export const REACTION_EMOJIS = ["👍", "👎", "👀", "🚩", "✅", "❓"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export const ALLOWED_MIMES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
  "application/zip",
] as const;

export type Role = "human" | "brain" | "worker";
export type Seniority = "junior" | "mid" | "senior";
export type ChannelType = "public" | "brains" | "private" | "dm";
export type ThreadStatus = "open" | "in_progress" | "blocked" | "done";
export type MessageKind = "chat" | "system" | "control";
export type ControlAction = "clear_context";
export type MessageSource = "hive" | "telegram";

export type Agent = {
  id: string;
  name: string;
  role: Role;
  seniority: Seniority | null;
  focus: string | null;
  online: boolean;
  lastSeenAt: number;
  createdAt: number;
};

export type Channel = {
  id: string;
  name: string;
  type: ChannelType;
  topic: string | null;
  createdBy: string;
  createdAt: number;
  memberIds: string[];
};

export type AttachmentMeta = {
  id: string;
  name: string;
  mime: string;
  bytes: number;
};

export type ReactionCount = {
  emoji: string;
  count: number;
  mine?: boolean;
};

export type Message = {
  id: string;
  seq: number;
  channelId: string;
  threadId: string | null;
  authorId: string;
  authorName: string;
  authorRole: Role;
  body: string;
  kind: MessageKind;
  control: ControlAction | null;
  mentions: string[];
  createdAt: number;
  source?: MessageSource;
  attachments?: AttachmentMeta[];
  reactions?: ReactionCount[];
};

export type Thread = {
  id: string;
  channelId: string;
  status: ThreadStatus | null;
};

export type Identity = {
  id: string;
  name: string;
  role: Role;
  seniority: Seniority | null;
  focus: string | null;
  token: string;
};

export type WaitControlItem = {
  seq: number;
  from: string;
  action: ControlAction;
  body: string;
};

export type WaitMailItem = {
  seq: number;
  ch: string;
  from: string;
  body?: string;
  excerpt?: string;
  count?: number;
  threadId?: string | null;
  attachments?: AttachmentMeta[];
};

export type WaitYou = Pick<Agent, "name" | "role" | "seniority" | "focus" | "online">;

export type WaitResult = {
  idle: boolean;
  next: string;
  you: WaitYou;
  control: Message[] | WaitControlItem[];
  mentions: Message[];
  messages: Message[];
  mail?: WaitMailItem[];
  more?: number;
};

export class HiveError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "HiveError";
  }
}
