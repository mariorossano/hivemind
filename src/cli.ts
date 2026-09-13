#!/usr/bin/env node
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "./shared/types.ts";
import {
  agentRequest,
  currentToken,
  hiveUrl,
  identitiesDir,
  loadIdentityByName,
  saveIdentity,
} from "./client/http.ts";
import { readdirSync, existsSync } from "node:fs";
import type { Agent, Channel, Message, WaitResult } from "./shared/types.ts";
import { parseJoinArgs } from "./shared/join-args.ts";

function help() {
  console.log(`hivemind — local hive for Human, brains, and workers

  hivemind serve [--port ${DEFAULT_PORT}]
  hivemind join --as worker junior|mid|senior [--focus …] [--resume Name]
  hivemind join --as worker --seniority junior|mid|senior
  hivemind join --as brain [--focus …] [--resume Name]
  hivemind wait [--timeout 120]
  hivemind send --channel NAME --body TEXT [--thread ID]
  hivemind send --to NAME --body TEXT
  hivemind history --channel NAME [--thread ID]
  hivemind agents
  hivemind channels
  hivemind whoami
  hivemind clear-context --agent NAME
  hivemind invite --channel NAME --member NAME
  hivemind identities
  hivemind doctor
  hivemind leave
  hivemind mcp
  hivemind mcp-config

Environment: HIVEMIND_URL (default ${hiveUrl()})  HIVEMIND_TOKEN  HIVEMIND_HOME
`);
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function argRest(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const parts: string[] = [];
  for (let j = i + 1; j < args.length; j += 1) {
    const next = args[j]!;
    if (next.startsWith("--")) break;
    parts.push(next);
  }
  return parts.join(" ") || undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    help();
    return;
  }

  if (cmd === "serve") {
    const { startServer } = await import("./server/serve.ts");
    startServer({ port: Number(arg(argv, "--port") ?? process.env.HIVEMIND_PORT ?? DEFAULT_PORT) });
    return;
  }

  if (cmd === "mcp") {
    const { startMcp } = await import("./mcp/index.ts");
    await startMcp();
    return;
  }

  if (cmd === "mcp-config") {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const entry = resolve(root, "src/cli.ts");
    const config = {
      mcpServers: {
        hivemind: {
          command: "npx",
          args: ["tsx", entry, "mcp"],
          env: {
            HIVEMIND_URL: hiveUrl(),
          },
          tool_timeout_sec: 28800,
        },
      },
    };
    console.log(JSON.stringify(config, null, 2));
    console.error("This repo already has .cursor/mcp.json and .mcp.json. For Codex, paste the JSON above.");
    console.error(`Then in the agent: join as worker or brain. Server must be running at ${hiveUrl()}`);
    return;
  }

  if (cmd === "join") {
    const parsed = parseJoinArgs(argv);
    const as = parsed.role;
    const seniority = parsed.seniority;
    const focus = parsed.focus ?? arg(argv, "--focus") ?? null;
    const resume = parsed.resume;
    const token =
      parsed.token ??
      (resume ? loadIdentityByName(resume)?.token : undefined) ??
      (resume ? undefined : process.env.HIVEMIND_TOKEN);
    const result = await agentRequest<{
      agent: Agent;
      token: string;
      created: boolean;
      standingOrders: string;
      describe: string;
    }>("POST", "/api/agent/join", {
      role: as,
      seniority: seniority ?? null,
      focus,
      resume,
    }, token ?? null);
    saveIdentity({
      id: result.agent.id,
      name: result.agent.name,
      role: result.agent.role,
      seniority: result.agent.seniority,
      focus: result.agent.focus,
      token: result.token,
    });
    console.log(`${result.created ? "Joined" : "Back"} as ${result.agent.name} · ${result.describe}`);
    console.log(`export HIVEMIND_TOKEN=${result.token}`);
    console.log("");
    console.log(result.standingOrders);
    return;
  }

  if (cmd === "doctor") {
    const res = await fetch(`${hiveUrl()}/api/health`);
    if (!res.ok) throw new Error(`server not healthy (${res.status})`);
    console.log(`ok ${hiveUrl()}`);
    return;
  }

  if (cmd === "identities") {
    const dir = identitiesDir();
    if (!existsSync(dir)) {
      console.log("no saved identities");
      return;
    }
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      console.log(file.replace(/\.json$/, ""));
    }
    return;
  }

  const token = arg(argv, "--token") ?? currentToken();
  if (!token) {
    throw new Error("No token. Join first, or set HIVEMIND_TOKEN.");
  }

  if (cmd === "wait") {
    const timeout = Number(arg(argv, "--timeout") ?? 120) * 1000;
    const result = await agentRequest<WaitResult>(
      "POST",
      "/api/agent/wait",
      { timeoutMs: timeout },
      token,
      timeout + 10_000,
    );
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "send") {
    const body = argRest(argv, "--body");
    if (!body) throw new Error("send --body TEXT");
    const thread = arg(argv, "--thread");
    const to = arg(argv, "--to");
    let channel = arg(argv, "--channel");
    if (to) {
      const dm = await agentRequest<{ channel: Channel }>("POST", "/api/agent/dms", { name: to }, token);
      channel = dm.channel.id;
    }
    if (!channel) throw new Error("send --channel NAME  or  --to NAME");
    const result = await agentRequest<{ message: Message }>(
      "POST",
      `/api/agent/channels/${encodeURIComponent(channel)}/messages`,
      { body, threadId: thread ?? null },
      token,
    );
    console.log(`sent ${result.message.id} as ${result.message.authorName}`);
    return;
  }

  if (cmd === "history") {
    const channel = arg(argv, "--channel");
    if (!channel) throw new Error("history --channel NAME");
    const thread = arg(argv, "--thread");
    const result = await agentRequest<{ messages: Message[] }>(
      "GET",
      `/api/agent/channels/${encodeURIComponent(channel)}/messages?limit=80${thread ? `&threadId=${thread}` : ""}`,
      undefined,
      token,
    );
    for (const m of result.messages) {
      const when = new Date(m.createdAt).toISOString().slice(11, 19);
      console.log(`[${when}] ${m.authorName}: ${m.body}`);
    }
    return;
  }

  if (cmd === "agents") {
    const result = await agentRequest<{ agents: Agent[] }>("GET", "/api/agent/agents", undefined, token);
    for (const a of result.agents) {
      const tag = a.online ? "online" : "offline";
      const extra = [a.role, a.seniority, a.focus].filter(Boolean).join(" ");
      console.log(`${tag.padEnd(8)} ${a.name.padEnd(12)} ${extra}`);
    }
    return;
  }

  if (cmd === "channels") {
    const result = await agentRequest<{ channels: Channel[] }>("GET", "/api/agent/channels", undefined, token);
    for (const ch of result.channels) {
      console.log(`${ch.type.padEnd(8)} ${ch.type === "dm" ? ch.name : "#" + ch.name}`);
    }
    return;
  }

  if (cmd === "whoami") {
    const result = await agentRequest<{ you: Agent; standingOrders: string }>(
      "GET",
      "/api/agent/me",
      undefined,
      token,
    );
    console.log(JSON.stringify(result.you, null, 2));
    console.log("");
    console.log(result.standingOrders);
    return;
  }

  if (cmd === "clear-context") {
    const name = arg(argv, "--agent") ?? arg(argv, "--to");
    if (!name) throw new Error("clear-context --agent NAME");
    const result = await agentRequest<{ message: Message }>(
      "POST",
      "/api/agent/clear-context",
      { name },
      token,
    );
    console.log(`clear_context sent to ${name} (${result.message.id})`);
    return;
  }

  if (cmd === "invite") {
    const channel = arg(argv, "--channel");
    const member = arg(argv, "--member") ?? arg(argv, "--name");
    if (!channel || !member) throw new Error("invite --channel NAME --member NAME");
    const result = await agentRequest<{ channel: Channel }>(
      "POST",
      `/api/agent/channels/${encodeURIComponent(channel)}/invite`,
      { names: [member] },
      token,
    );
    console.log(`invited ${member} to ${result.channel.type === "dm" ? result.channel.name : "#" + result.channel.name}`);
    return;
  }

  if (cmd === "leave") {
    await agentRequest("POST", "/api/agent/leave", {}, token);
    console.log("offline");
    return;
  }

  help();
  throw new Error(`unknown command ${cmd}`);
}

main().catch((err) => {
  console.error(String(err.message || err));
  process.exit(1);
});
