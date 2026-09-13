import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { agentRequest, currentToken, saveIdentity } from "../client/http.ts";
import { waitUntilMail } from "./wait-loop.ts";
import { DEFAULT_WAIT_MS, type Agent, type Channel, type Identity, type Message, type WaitResult } from "../shared/types.ts";

let sessionToken = process.env.HIVEMIND_TOKEN;

function token(): string {
  const t = sessionToken ?? currentToken();
  if (!t) throw new Error("Join first with the join tool.");
  return t;
}

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

export async function startMcp() {
  const server = new McpServer({ name: "hivemind", version: "0.1.0" });

  server.tool(
    "join",
    "Register this terminal as a Hivemind employee. Call once per session. Role cannot change later. Workers must pick seniority junior, mid, or senior. Use resume with your assigned name to come back to work.",
    {
      role: z.enum(["brain", "worker"]),
      seniority: z.enum(["junior", "mid", "senior"]).optional(),
      focus: z.string().optional(),
      resume: z.string().optional(),
    },
    async ({ role, seniority, focus, resume }) => {
      const auth = resume
        ? (sessionToken ?? currentToken())
        : process.env.HIVEMIND_TOKEN;
      const result = await agentRequest<{
        agent: Agent;
        token: string;
        created: boolean;
        standingOrders: string;
        describe: string;
      }>(
        "POST",
        "/api/agent/join",
        { role, seniority: seniority ?? null, focus: focus ?? null, resume: resume ?? null },
        auth ?? null,
      );
      sessionToken = result.token;
      saveIdentity({
        id: result.agent.id,
        name: result.agent.name,
        role: result.agent.role,
        seniority: result.agent.seniority,
        focus: result.agent.focus,
        token: result.token,
      } satisfies Identity);
      return text({
        name: result.agent.name,
        describe: result.describe,
        created: result.created,
        token: result.token,
        standingOrders: result.standingOrders,
        next: "Call wait once with no arguments when idle. It returns only when you have mail. Do not pass a timeout.",
      });
    },
  );

  server.tool("whoami", "Your Hivemind identity and standing orders.", async () => {
    return text(await agentRequest("GET", "/api/agent/me", undefined, token()));
  });

  server.tool("agents", "List Human, brains, and workers with online/offline and seniority.", async () => {
    return text(await agentRequest("GET", "/api/agent/agents", undefined, token()));
  });

  server.tool("channels", "List channels and DMs you can see.", async () => {
    return text(await agentRequest("GET", "/api/agent/channels", undefined, token()));
  });

  server.tool(
    "history",
    "Read recent messages in a channel or DM. Workers may read public channel history when they need context.",
    {
      channel: z.string().describe("Channel name, #slug, or id"),
      threadId: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ channel, threadId, limit }) => {
      const q = new URLSearchParams();
      if (threadId) q.set("threadId", threadId);
      if (limit) q.set("limit", String(limit));
      const suffix = q.toString() ? `?${q}` : "";
      return text(
        await agentRequest(
          "GET",
          `/api/agent/channels/${encodeURIComponent(channel)}/messages${suffix}`,
          undefined,
          token(),
        ),
      );
    },
  );

  server.tool(
    "send",
    "Post a message. Use channel for #general etc, or to for a DM by agent name. Workers cannot mention @Human or DM Human (unless Human already opened that DM).",
    {
      body: z.string(),
      channel: z.string().optional(),
      to: z.string().optional().describe("Agent name for a DM"),
      threadId: z.string().optional(),
    },
    async ({ body, channel, to, threadId }) => {
      let channelId = channel;
      if (to) {
        const dm = await agentRequest<{ channel: Channel }>("POST", "/api/agent/dms", { name: to }, token());
        channelId = dm.channel.id;
      }
      if (!channelId) throw new Error("Provide channel or to");
      return text(
        await agentRequest<{ message: Message }>(
          "POST",
          `/api/agent/channels/${encodeURIComponent(channelId)}/messages`,
          { body, threadId: threadId ?? null },
          token(),
        ),
      );
    },
  );

  server.tool(
    "wait",
    "Sleep at your desk. Call once with no arguments. This tool does not return until you have mail — idle and transient network errors are retried inside the tool, not by you. Codex may show Working; that is sleep, not a model turn. Do not pass a timeout. Do not call wait in a loop. Do not call other Hivemind tools while waiting. Handle control clear_context first when it returns.",
    {},
    async () => {
      const result = await waitUntilMail(() =>
        agentRequest<WaitResult>(
          "POST",
          "/api/agent/wait",
          { timeoutMs: DEFAULT_WAIT_MS },
          token(),
          DEFAULT_WAIT_MS + 10_000,
        ),
      );
      return text(result);
    },
  );

  server.tool(
    "create_channel",
    "Brains and Human only. Create a public or private channel.",
    {
      name: z.string(),
      type: z.enum(["public", "private"]).optional(),
      topic: z.string().optional(),
      members: z.array(z.string()).optional(),
    },
    async ({ name, type, topic, members }) => {
      return text(
        await agentRequest(
          "POST",
          "/api/agent/channels",
          { name, type: type ?? "public", topic, memberNames: members },
          token(),
        ),
      );
    },
  );

  server.tool(
    "set_thread_status",
    "Optional ticket-style status on a thread: open, in_progress, blocked, done.",
    {
      threadId: z.string(),
      status: z.enum(["open", "in_progress", "blocked", "done"]),
    },
    async ({ threadId, status }) => {
      return text(await agentRequest("POST", `/api/agent/threads/${threadId}/status`, { status }, token()));
    },
  );

  server.tool(
    "invite",
    "Brain or Human only. Invite agents into a private channel.",
    {
      channel: z.string(),
      members: z.array(z.string()),
    },
    async ({ channel, members }) => {
      return text(
        await agentRequest(
          "POST",
          `/api/agent/channels/${encodeURIComponent(channel)}/invite`,
          { names: members },
          token(),
        ),
      );
    },
  );

  server.tool(
    "clear_context",
    "Brain or Human only. Tell a worker to discard task memory and wait.",
    { agent: z.string() },
    async ({ agent }) => {
      return text(await agentRequest("POST", "/api/agent/clear-context", { name: agent }, token()));
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const launchedDirectly = process.argv[1]?.endsWith("mcp/index.ts") || process.argv[1]?.endsWith("mcp/index.js");
if (launchedDirectly) {
  startMcp().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
