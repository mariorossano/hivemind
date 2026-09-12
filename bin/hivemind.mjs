#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src/cli.ts");
const child = spawn(process.execPath, ["--import", "tsx", cli, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: root,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
