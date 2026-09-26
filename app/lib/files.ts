// Content-addressed file store for uploaded documents. Bytes are stored once
// per sha256 at <dir>/<sha[0:2]>/<sha>, written to a temp file and renamed into
// place, and never overwritten or deleted. filesDir() is the ONE place the
// location is decided, so a serverless deployment (only the OS temp dir is
// writable) can swap it without touching anything else.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDemo } from "./demo-policy";

export function filesDir(): string {
  // The hosted demo runs serverless: only the OS temp dir is writable.
  if (isDemo()) return path.join(os.tmpdir(), "deal-desk-demo-files");
  return process.env.HARNESS_FILES_DIR || path.join(process.cwd(), "data", "files");
}

const SHA_RE = /^[0-9a-f]{64}$/;

export function blobPath(sha256: string): string {
  if (!SHA_RE.test(sha256)) throw new Error("Invalid sha256");
  return path.join(filesDir(), sha256.slice(0, 2), sha256);
}

export const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Store bytes; identical content is stored once. Returns the hash and size. */
export function putBlob(bytes: Uint8Array): { sha256: string; size: number } {
  const sha256 = sha256Of(bytes);
  const dest = blobPath(sha256);
  if (!existsSync(dest)) {
    mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    writeFileSync(tmp, bytes, { flag: "wx" });
    try {
      if (existsSync(dest)) unlinkSync(tmp); // another writer got there first; same bytes
      else renameSync(tmp, dest);
    } catch (err) {
      if (existsSync(tmp)) unlinkSync(tmp);
      throw err;
    }
  }
  return { sha256, size: bytes.byteLength };
}

/** Size on disk, or null when the file is not in this workspace (e.g. demo rows). */
export function blobSize(sha256: string): number | null {
  try {
    return statSync(blobPath(sha256)).size;
  } catch {
    return null;
  }
}
