import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  createReadStream,
  existsSync,
  mkdirSync,
  unlinkSync,
  statSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { rename, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ALLOWED_MIMES, FILE_MAX_BYTES, HiveError, IMAGE_PREVIEW_MAX_BYTES } from "../shared/types.ts";
import { hiveHome } from "./paths.ts";

export function filesDir(home = hiveHome()): string {
  return path.join(home, "files");
}

export function filePathForHash(sha256: string, home = hiveHome()): string {
  return path.join(filesDir(home), sha256);
}

export function assertAllowedMime(mime: string) {
  if (!(ALLOWED_MIMES as readonly string[]).includes(mime)) {
    throw new HiveError(400, `File type not allowed: ${mime}`);
  }
}

export function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "file";
}

export async function streamUpload(
  body: ReadableStream<Uint8Array> | null,
  mime: string,
  home = hiveHome(),
): Promise<{ tmp: string; bytes: number; sha256: string }> {
  if (!body) throw new HiveError(400, "Empty upload");
  assertAllowedMime(mime);
  mkdirSync(filesDir(home), { recursive: true });
  const tmp = path.join(filesDir(home), `part-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const node = Readable.fromWeb(body as import("node:stream/web").ReadableStream);
  node.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    hash.update(chunk);
    if (bytes > FILE_MAX_BYTES) node.destroy(new HiveError(413, "File too large (512 MB max)"));
  });
  try {
    await pipeline(node, createWriteStream(tmp));
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw err;
  }
  if (bytes === 0) {
    unlinkSync(tmp);
    throw new HiveError(400, "Empty upload");
  }
  return { tmp, bytes, sha256: hash.digest("hex") };
}

export async function commitUpload(tmp: string, sha256: string, home = hiveHome()): Promise<string> {
  const dest = filePathForHash(sha256, home);
  if (existsSync(dest)) {
    await unlink(tmp).catch(() => undefined);
    return dest;
  }
  await rename(tmp, dest);
  return dest;
}

export function openBlob(sha256: string, home = hiveHome()) {
  const dest = filePathForHash(sha256, home);
  if (!existsSync(dest)) throw new HiveError(404, "File not found");
  return { stream: createReadStream(dest), bytes: statSync(dest).size };
}

export function removeOrphanBlobs(usedHashes: Set<string>, home = hiveHome()) {
  if (!existsSync(filesDir(home))) return 0;
  let n = 0;
  for (const name of readdirSync(filesDir(home))) {
    if (name.startsWith("part-") || name.startsWith("tg-")) continue;
    if (usedHashes.has(name)) continue;
    unlinkSync(path.join(filesDir(home), name));
    n += 1;
  }
  return n;
}

/** Store keeps the original. Models get a ≤1600px / ≤1.5MB preview — never a 12 MB frame. */
export function imagePreview(filePath: string, mime: string, bytes: Buffer): { data: Buffer; mime: string } | null {
  if (!mime.startsWith("image/")) return null;
  const out = `${filePath}.thumb.jpg`;
  const jobs: Array<[string, string[]]> = [];
  if (process.platform === "darwin") {
    jobs.push(["sips", ["-Z", "1600", "-s", "format", "jpeg", filePath, "--out", out]]);
  }
  jobs.push(
    ["ffmpeg", ["-y", "-i", filePath, "-vf", "scale=1600:1600:force_original_aspect_ratio=decrease", "-q:v", "5", out]],
    ["magick", [filePath, "-resize", "1600x1600>", out]],
    ["convert", [filePath, "-resize", "1600x1600>", out]],
  );
  for (const [bin, args] of jobs) {
    try {
      execFileSync(bin, args, { stdio: "ignore" });
      if (!existsSync(out)) continue;
      const data = readFileSync(out);
      unlinkSync(out);
      if (data.length > 0 && data.length <= IMAGE_PREVIEW_MAX_BYTES) {
        return { data, mime: "image/jpeg" };
      }
    } catch {
      /* try the next encoder */
    }
  }
  if (bytes.length <= IMAGE_PREVIEW_MAX_BYTES) return { data: bytes, mime };
  return null;
}
