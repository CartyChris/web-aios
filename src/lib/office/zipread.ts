/* ────────────────────────────────────────────────────────────────────────────
   Reading zip archives: the other half of lib/zip.ts, for importing office
   files.

   Reads the central directory (the authoritative list; local headers can lie
   about sizes when data descriptors are used), then each entry. Stored entries
   are returned as-is; deflated ones go through an inflate function the caller
   supplies -- in the browser, DecompressionStream("deflate-raw"); in tests,
   node:zlib. That keeps this file pure and the codec swappable.

   Guards: entry count, per-entry and total uncompressed size are capped before
   anything is inflated (a zip bomb states its sizes in the directory), and an
   inflated entry larger than it claimed is rejected.
   ──────────────────────────────────────────────────────────────────────────── */

export type Inflate = (bytes: Uint8Array) => Promise<Uint8Array>;

export interface ZipReadLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

export interface ZipFileInfo {
  path: string;
  method: number;
  size: number;
  csize: number;
  offset: number;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function listZip(bytes: Uint8Array, limits: ZipReadLimits = {}): ZipFileInfo[] {
  const maxEntries = limits.maxEntries ?? 5000;
  // End of central directory: scan back over a possible comment (max 65535).
  let eocd = -1;
  for (let o = bytes.length - 22; o >= Math.max(0, bytes.length - 22 - 65535); o--) {
    if (u32(bytes, o) === 0x06054b50) { eocd = o; break; }
  }
  if (eocd < 0) throw new Error("Not a zip file (no end-of-directory record).");
  const count = u16(bytes, eocd + 10);
  const cdOffset = u32(bytes, eocd + 16);
  if (count > maxEntries) throw new Error(`Zip has ${count} entries; the limit is ${maxEntries}.`);
  const out: ZipFileInfo[] = [];
  let p = cdOffset;
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (p + 46 > bytes.length || u32(bytes, p) !== 0x02014b50) throw new Error("Corrupt zip directory.");
    const method = u16(bytes, p + 10);
    const csize = u32(bytes, p + 20);
    const size = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28), extraLen = u16(bytes, p + 30), commentLen = u16(bytes, p + 32);
    const offset = u32(bytes, p + 42);
    const path = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.push({ path, method, size, csize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Read every file (not directories) into a path -> bytes map. */
export async function readZip(bytes: Uint8Array, inflate: Inflate, limits: ZipReadLimits = {}): Promise<Map<string, Uint8Array>> {
  const maxEntry = limits.maxEntryBytes ?? 50 * 1024 * 1024;
  const maxTotal = limits.maxTotalBytes ?? 200 * 1024 * 1024;
  const files = listZip(bytes, limits).filter((f) => !f.path.endsWith("/"));
  let total = 0;
  for (const f of files) {
    if (f.size > maxEntry) throw new Error(`${f.path} is ${f.size} bytes uncompressed; the limit is ${maxEntry}.`);
    total += f.size;
  }
  if (total > maxTotal) throw new Error(`The archive expands to ${total} bytes; the limit is ${maxTotal}.`);
  const out = new Map<string, Uint8Array>();
  for (const f of files) {
    const lh = f.offset;
    if (u32(bytes, lh) !== 0x04034b50) throw new Error(`Corrupt local header for ${f.path}.`);
    const start = lh + 30 + u16(bytes, lh + 26) + u16(bytes, lh + 28);
    const data = bytes.subarray(start, start + f.csize);
    let content: Uint8Array;
    if (f.method === 0) content = data.slice();
    else if (f.method === 8) content = await inflate(data);
    else throw new Error(`${f.path} uses compression method ${f.method}, which is not supported.`);
    if (content.length > f.size + 16) throw new Error(`${f.path} inflated larger than it claimed.`);
    out.set(f.path, content);
  }
  return out;
}

export const utf8 = (b: Uint8Array | undefined): string => (b ? new TextDecoder().decode(b) : "");
