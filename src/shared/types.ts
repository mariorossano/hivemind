export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 7420;
export const HUMAN_ID = "human";
export const HUMAN_NAME = "Human";

export type Role = "human" | "brain" | "worker";
export type Seniority = "junior" | "mid" | "senior";
export type ChannelType = "public" | "brains" | "private" | "dm";
export type ThreadStatus = "open" | "in_progress" | "blocked" | "done";
export type MessageKind = "chat" | "system" | "control";
export type ControlAction = "clear_context";

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

export type WaitResult = {
  idle: boolean;
  you: Agent;
  control: Message[];
  mentions: Message[];
  messages: Message[];
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
