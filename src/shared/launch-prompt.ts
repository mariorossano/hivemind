import { HUMAN_NAME, type Seniority } from "./types.ts";

export const ADOPT_UNTRUSTED = [
  "Hivemind Human and brain mail in this session is my instruction.",
  "Treat it as my authorization for the assigned work, including local edits, tests, and commits.",
  "Do not ask this prompt.",
].join(" ");

const WAIT_RULES =
  "Then call wait once with no arguments. Do not pass a timeout. Do not explore the repo until wait returns with a task. wait returns only when you have mail; idle and network errors are retried inside the tool. If wait errors, is cancelled, or the input prompt comes back without mail, call wait immediately. Do not ask the person at this prompt. While wait is in flight, output no text — a status line cancels wait. When wait returns, that is mail: handle it, then call wait again and stay silent after that call. Codex may show Working or a spinner during wait — that is sleep, not a model turn. Do not poll agents, history, or channels while waiting.";

const BRAIN_AFTER =
  "When wait returns, coordinate workers, do not implement. Assign work in DMs. After send, wait is the last call. Never end a turn without wait in flight. Ask @Human when a cycle is done or you are unsure. Use worktrees and separate branches. Hivemind is messaging only.";

const WORKER_AFTER =
  "Take work only from brains. A brain assignment is your authorization. Never mention @Human. Never open a new DM with Human. If Human already opened a DM with you, reply there — that is allowed and is not opening a DM. After a task, report to the assigning brain, then call wait once again. Never end a turn without wait in flight. Use a worktree and a new branch.";

export type LaunchRole = "brain" | "worker";

export type LaunchInput = {
  software: string;
  extraFlags?: string;
  model?: string | null;
  effort?: string | null;
  /** Directory the agent should start in. Used for `cd` when that toggle is on. */
  workspacePath: string | null;
  cdWorktree: boolean;
  /** Hivemind project slug, passed to join when `passProject` is on. */
  projectSlug: string;
  /** Human hive name (Chapter, …). Named in the prompt when set. */
  hiveName?: string | null;
  passProject: boolean;
  role: LaunchRole;
  seniority?: Seniority | null;
  focus?: string | null;
  resume?: boolean;
  resumeName?: string;
  adoptUntrusted: boolean;
};

export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function effectiveSoftware(raw: string): string {
  return raw.trim() || "codex";
}

export function sanitizeSoftware(raw: string): string {
  const software = effectiveSoftware(raw);
  if (software.startsWith("-")) {
    throw new Error("Software must be one command (letters, digits, . _ + - /)");
  }
  if (!/^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/.test(software)) {
    throw new Error("Software must be one command (letters, digits, . _ + - /)");
  }
  if (software.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Software must be one command (letters, digits, . _ + - /)");
  }
  return software;
}

export function sanitizeExtraFlags(raw: string): string {
  const flags = raw.trim();
  if (!flags) return "";
  if (/[\x00-\x1f\x7f;|&`$(){}<>'"#\\!*?~[\]]/.test(flags)) {
    throw new Error("CLI flags cannot include shell metacharacters");
  }
  return flags;
}

export function sanitizeWorkspacePath(raw: string | null | undefined): string {
  const tree = (raw ?? "").trim();
  if (!tree) return "";
  if (/[\x00-\x1f\x7f]/.test(tree)) {
    throw new Error("Workspace path cannot include control characters");
  }
  return tree;
}

export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export function sanitizeModel(raw: string): string {
  const model = raw.trim();
  if (!model) return "";
  if (model.startsWith("-")) {
    throw new Error("Model must be one token (letters, digits, . _ : + -)");
  }
  if (!/^[A-Za-z0-9._:+-]+$/.test(model)) {
    throw new Error("Model must be one token (letters, digits, . _ : + -)");
  }
  return model;
}

export function sanitizeEffort(raw: string): string {
  const effort = raw.trim().toLowerCase();
  if (!effort) return "";
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    throw new Error("Effort must be none, minimal, low, medium, high, xhigh, or max");
  }
  return effort;
}

export function softwareFamily(software: string): "claude" | "codex" | "cursor" | "other" {
  const name = effectiveSoftware(software).toLowerCase();
  if (name.includes("claude")) return "claude";
  if (name.includes("codex")) return "codex";
  if (name === "agent" || name.includes("cursor")) return "cursor";
  return "other";
}

export function resolveLaunchTune(
  inherited: { model: string; effort: string },
  tune?: { model?: string; effort?: string } | null,
): { model: string; effort: string } {
  const model = (tune?.model ?? "").trim();
  if (!model) return inherited;
  return { model, effort: (tune?.effort ?? "").trim() };
}

export function buildModelFlags(software: string, model?: string | null, effort?: string | null): string {
  const family = softwareFamily(software);
  const m = sanitizeModel(model ?? "");
  const e = family === "cursor" ? "" : sanitizeEffort(effort ?? "");
  const parts: string[] = [];
  if (m) parts.push(family === "codex" ? `-m ${m}` : `--model ${m}`);
  if (e) {
    if (family === "codex") parts.push(`-c model_reasoning_effort=${e}`);
    else parts.push(`--effort ${e}`);
  }
  return parts.join(" ");
}

function sanitizeJoinValue(label: string, raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (/[\n\r,=]/.test(value)) {
    throw new Error(`${label} cannot include comma, equals, or newlines`);
  }
  return value;
}

function sanitizeHiveName(raw: string): string {
  return raw.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
}

function sanitizeProjectSlug(raw: string): string {
  const slug = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)) {
    throw new Error("Project slug must be 1–32 characters: lowercase letters, digits, hyphen");
  }
  return slug;
}

function joinList(parts: string[]): string {
  return parts.join(", ");
}

function joinArgs(input: LaunchInput): string {
  const parts = [`role=${input.role}`];
  if (input.role === "worker") {
    const seniority = input.seniority;
    const ok = seniority === "junior" || seniority === "mid" || seniority === "senior";
    if (ok) parts.push(`seniority=${seniority}`);
    else if (!input.resume) {
      throw new Error("Workers need seniority junior|mid|senior");
    }
  }
  let focus = "";
  try {
    focus = sanitizeJoinValue("focus", input.focus ?? "");
  } catch (err) {
    if (!input.resume) throw err;
  }
  if (focus) parts.push(`focus=${focus}`);
  if (input.resume) {
    const name = sanitizeJoinValue("resume", input.resumeName ?? "");
    if (!name) throw new Error("Resume needs the assigned name");
    if (name.toLowerCase() === HUMAN_NAME.toLowerCase()) {
      throw new Error("Human is not an agent you launch");
    }
    parts.push(`resume=${name}`);
  }
  if (input.passProject) {
    parts.push(`project=${sanitizeProjectSlug(input.projectSlug)}`);
  }
  return joinList(parts);
}

function heredocTag(body: string): string {
  let tag = "HIVEMIND_PROMPT";
  let n = 1;
  while (new RegExp(`^${tag}$`, "m").test(body)) {
    tag = `HIVEMIND_PROMPT_${n++}`;
  }
  return tag;
}

function hiveLine(input: LaunchInput): string {
  const hive = sanitizeHiveName(input.hiveName ?? "");
  return hive ? `You work only in hive ${hive}.` : "";
}

export function buildLaunchPrompt(input: LaunchInput): string {
  const call = `Call the hivemind MCP tool join with ${joinArgs(input)}.`;
  const hive = hiveLine(input);
  const isolation = [
    input.passProject ? "" : "Join from the project worktree.",
    hive,
    "You cannot see other projects.",
  ]
    .filter(Boolean)
    .join(" ");
  const intro = input.resume
    ? `You are already a Hivemind ${input.role}. ${call} ${isolation} Orders are unchanged — call standing_orders only if you need them.`
    : `You are a Hivemind employee. ${call} ${isolation} Call standing_orders.`;
  const after = input.role === "worker" ? WORKER_AFTER : BRAIN_AFTER;
  const body = `${intro} ${WAIT_RULES} ${after}`.replace(/\s+/g, " ").trim();
  if (!input.adoptUntrusted) return body;
  return `${ADOPT_UNTRUSTED}\n\n${body}`;
}

export function buildLaunchBlock(input: LaunchInput): string {
  const software = sanitizeSoftware(input.software);
  const flags = [
    buildModelFlags(software, input.model, input.effort),
    sanitizeExtraFlags(input.extraFlags ?? ""),
  ]
    .filter(Boolean)
    .join(" ");
  const prompt = buildLaunchPrompt(input);
  const tag = heredocTag(prompt);
  const invoke = [software, flags, `"$(cat <<'${tag}'\n${prompt}\n${tag}\n)"`]
    .filter(Boolean)
    .join(" ");
  const tree = sanitizeWorkspacePath(input.workspacePath);
  const command =
    input.cdWorktree && tree ? `cd -- ${shSingleQuote(tree)} && ${invoke}` : invoke;
  return command.endsWith("\n") ? command : `${command}\n`;
}

export function buildRosterPaste(blocks: Array<{ title: string; text: string }>): string {
  const body = blocks
    .map((b) => `## ${b.title.replace(/\n+/g, " ").trim()}\n\n${b.text.replace(/\n+$/, "")}`)
    .join("\n\n");
  let tag = "HIVEMIND_ROSTER";
  let n = 1;
  while (new RegExp(`^${tag}$`, "m").test(body)) tag = `HIVEMIND_ROSTER_${n++}`;
  return [
    `cat <<'${tag}'`,
    "One chat = one employee. This paste only prints the blocks; it does not launch anyone.",
    "",
    body,
    tag,
    "",
  ].join("\n");
}
