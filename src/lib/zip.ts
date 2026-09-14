/* ────────────────────────────────────────────────────────────────────────────
   A ZIP writer in ~120 lines, with no dependency.

   Export is the feature that makes everything else in this OS yours rather
   than ours, so it should not cost 90 KB of library to leave. This writes the
   "stored" (uncompressed) variant of the format, which every unzip
   implementation has supported since 1989 — the tradeoff is file size, and a
   project of source files is small enough that it does not matter.

   Two details that quietly break naive implementations are handled here: the
   CRC-32 of every entry must be correct or archives fail verification, and the
   local-header offsets in the central directory must be byte-exact.
   ──────────────────────────────────────────────────────────────────────────── */

export interface ZipEntry {
  /** Path inside the archive. Forward slashes; no leading slash. */
  path: string;
  /** File contents. Strings are written as UTF-8. */
  content: string | Uint8Array;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed date/time, which is what the format stores. */
function dosDateTime(d: Date): { date: number; time: number } {
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
    // Years are counted from 1980 and clamp at the epoch, not below it.
    date: ((Math.max(0, d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  length = 0;

  raw(bytes: Uint8Array) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }
  u16(n: number) {
    this.raw(new Uint8Array([n & 0xff, (n >>> 8) & 0xff]));
  }
  u32(n: number) {
    this.raw(new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]));
  }
  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

/** Build a ZIP archive from a list of entries. */
export function makeZip(entries: ZipEntry[], when = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const { date, time } = dosDateTime(when);
  const out = new ByteWriter();
  const central: Array<{ name: Uint8Array; crc: number; size: number; offset: number }> = [];

  for (const entry of entries) {
    const name = enc.encode(
      entry.path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+/, ""),
    );
    const data = typeof entry.content === "string" ? enc.encode(entry.content) : entry.content;
    const crc = crc32(data);
    const offset = out.length;

    // ── Local file header ──
    out.u32(0x04034b50);
    out.u16(20);            // version needed
    out.u16(0x0800);        // flags: bit 11 = UTF-8 names
    out.u16(0);             // method 0 = stored
    out.u16(time);
    out.u16(date);
    out.u32(crc);
    out.u32(data.length);   // compressed size == uncompressed when stored
    out.u32(data.length);
    out.u16(name.length);
    out.u16(0);             // extra field length
    out.raw(name);
    out.raw(data);

    central.push({ name, crc, size: data.length, offset });
  }

  // ── Central directory ──
  const cdStart = out.length;
  for (const e of central) {
    out.u32(0x02014b50);
    out.u16(20);            // version made by
    out.u16(20);            // version needed
    out.u16(0x0800);
    out.u16(0);
    out.u16(time);
    out.u16(date);
    out.u32(e.crc);
    out.u32(e.size);
    out.u32(e.size);
    out.u16(e.name.length);
    out.u16(0);             // extra
    out.u16(0);             // comment
    out.u16(0);             // disk number
    out.u16(0);             // internal attrs
    out.u32(0o100644 << 16); // external attrs: regular file, rw-r--r--
    out.u32(e.offset);
    out.raw(e.name);
  }
  const cdSize = out.length - cdStart;

  // ── End of central directory ──
  out.u32(0x06054b50);
  out.u16(0);
  out.u16(0);
  out.u16(central.length);
  out.u16(central.length);
  out.u32(cdSize);
  out.u32(cdStart);
  out.u16(0);

  return out.concat();
}

/** Build a ZIP and hand it to the browser as a download. */
export function downloadZip(filename: string, entries: ZipEntry[]) {
  const bytes = makeZip(entries);
  // A fresh ArrayBuffer copy: some browsers refuse a Blob built over a view
  // with a non-zero byteOffset.
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".zip") ? filename : `${filename}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export { crc32 };
