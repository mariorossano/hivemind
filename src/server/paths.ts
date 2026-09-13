import { homedir } from "node:os";
import path from "node:path";

export function hiveHome(): string {
  return process.env.HIVEMIND_HOME ?? path.join(homedir(), ".hivemind");
}
