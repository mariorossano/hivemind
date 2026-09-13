import { ALLOWED_MIMES } from "./types.ts";

const BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
};

export function guessMime(name: string): string {
  const ext = name.includes(".") ? `.${name.split(".").pop()?.toLowerCase()}` : "";
  return BY_EXT[ext] ?? "application/octet-stream";
}

export function resolveUploadMime(mime: string | undefined | null, name: string): string {
  const trimmed = (mime ?? "").trim();
  if (trimmed && (ALLOWED_MIMES as readonly string[]).includes(trimmed)) return trimmed;
  return guessMime(name || "paste.png");
}
