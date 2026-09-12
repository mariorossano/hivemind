import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

test("MCP initialize and tools/list expose the hive", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "src/cli.ts"), "mcp"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks: string[] = [];
  const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  try {
    const text = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout: ${chunks.join("")}`)), 8000);
      child.stdout.on("data", (buf: Buffer) => {
        chunks.push(String(buf));
        const all = chunks.join("");
        if (all.includes("tools") && all.includes("join") && all.includes("wait")) {
          clearTimeout(timer);
          resolve(all);
        }
      });
      child.on("error", reject);
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "hivemind-test", version: "0" },
        },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    });
    assert.match(text, /"name"\s*:\s*"join"/);
    assert.match(text, /"name"\s*:\s*"wait"/);
    assert.match(text, /"name"\s*:\s*"send"/);
  } finally {
    child.kill("SIGTERM");
  }
});
