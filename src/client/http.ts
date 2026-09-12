import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { hiveHome } from "../server/hive.ts";
import type { Identity } from "../shared/types.ts";

export function identitiesDir(): string {
  return path.join(hiveHome(), "identities");
}

export function identityPath(name: string): string {
  return path.join(identitiesDir(), `${name}.json`);
}

export function saveIdentity(id: Identity) {
  mkdirSync(identitiesDir(), { recursive: true });
  writeFileSync(identityPath(id.name), JSON.stringify(id, null, 2));
  writeFileSync(path.join(hiveHome(), "last-join.json"), JSON.stringify(id, null, 2));
}

export function loadIdentityFile(file: string): Identity {
  return JSON.parse(readFileSync(file, "utf8")) as Identity;
}

export function loadIdentityByName(name: string): Identity | null {
  const file = identityPath(name);
  if (!existsSync(file)) return null;
  return loadIdentityFile(file);
}

export function currentToken(cliToken?: string): string | undefined {
  if (cliToken) return cliToken;
  if (process.env.HIVEMIND_TOKEN) return process.env.HIVEMIND_TOKEN;
  const last = path.join(hiveHome(), "last-join.json");
  if (existsSync(last)) {
    const id = loadIdentityFile(last);
    return id.token;
  }
  return undefined;
}

export function hiveUrl(): string {
  return process.env.HIVEMIND_URL ?? "http://127.0.0.1:7420";
}

export async function agentRequest<T>(
  method: string,
  pathname: string,
  body?: unknown,
  token?: string | null,
  timeoutMs?: number,
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const t = token === null ? undefined : (token ?? currentToken());
  if (t) headers.authorization = `Bearer ${t}`;
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(`${hiveUrl()}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
