import * as crypto from "crypto";

export function generateSecretToken(bytes: number, prefix = "") {
  return prefix + crypto.randomBytes(bytes).toString("base64url");
}

export function hashSecretToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const UNSAFE_FILENAME_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Turns a user supplied file name into something safe to store and to use as
 * part of a storage key: no path components, no control characters, bounded
 * length.
 */
export function sanitizeFileName(name: string | undefined) {
  let clean = (name ?? "")
    .normalize("NFC")
    .split(/[\\/]/)
    .pop()
    // Control characters (C0, DEL, C1), bidi overrides/isolates and
    // zero-width characters, which can be used to disguise file names
    .replace(UNSAFE_FILENAME_CHARS, "")
    .trim();

  if (clean === "." || clean === "..") clean = "";
  if (!clean) clean = "file";

  if (Buffer.byteLength(clean) > 200) {
    const dot = clean.lastIndexOf(".");
    const ext = dot > 0 ? clean.slice(dot).slice(0, 20) : "";
    let base = dot > 0 ? clean.slice(0, dot) : clean;
    while (Buffer.byteLength(base + ext) > 200) base = base.slice(0, -1);
    clean = base + ext;
  }
  return clean;
}
