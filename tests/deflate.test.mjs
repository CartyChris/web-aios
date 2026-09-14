/**
 * The Rust/WASM DEFLATE compressor, and the ZIP writer that uses it.
 *
 * The only test that means anything for a compressor is that a real decoder
 * accepts what it produced — so every case here round-trips through Node's
 * zlib, which is the same libz every unzip on the planet links against. A
 * compressor that only its own decompressor can read is a corruption bug with
 * good PR.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { makeZip } from "../.test-build/zip.js";

const wasmBytes = fs.readFileSync(new URL("../public/deflate.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const ex = instance.exports;

/** The same call shape src/lib/deflate.ts makes in the browser. */
function deflate(bytes) {
  if (bytes.length === 0) return null;
  const cap = bytes.length + (bytes.length >> 3) + 64;
  const inPtr = ex.alloc_buf(bytes.length);
  const outPtr = ex.alloc_buf(cap);
  new Uint8Array(ex.memory.buffer, inPtr, bytes.length).set(bytes);
  const n = ex.deflate_raw(inPtr, bytes.length, outPtr, cap);
  const out = n < 0 || n >= bytes.length ? null : new Uint8Array(ex.memory.buffer, outPtr, n).slice();
  ex.dealloc_buf(inPtr, bytes.length);
  ex.dealloc_buf(outPtr, cap);
  return out;
}

const enc = (s) => new TextEncoder().encode(s);

test("every kind of input round-trips through zlib", () => {
  const cases = {
    "one byte": enc("a"),
    "short ascii": enc("hello world"),
    "highly repetitive": enc("abcabc".repeat(2000)),
    "utf-8 multibyte": enc("héllo wörld ✦ ".repeat(500)),
    "incompressible noise": Uint8Array.from({ length: 40000 }, (_, i) => (i * 2654435761) & 0xff),
    "a single repeated byte": new Uint8Array(100000).fill(0x41),
    // The match finder reads one byte past the current best match; an input
    // whose best match runs to the very end is what walked off the end of the
    // buffer the first time this was built.
    "match running to the final byte": enc("xy".repeat(64) + "xy".repeat(64)),
  };
  for (const [name, data] of Object.entries(cases)) {
    const packed = deflate(data);
    if (packed === null) continue; // legitimately not worth compressing
    const back = zlib.inflateRawSync(Buffer.from(packed));
    assert.deepEqual(new Uint8Array(back), data, `${name} did not survive the round trip`);
  }
});

test("source code compresses to well under half its size", () => {
  const src = fs.readFileSync(new URL("../src/apps/Forge3D.tsx", import.meta.url));
  const packed = deflate(new Uint8Array(src));
  assert.ok(packed, "source should compress at all");
  assert.ok(packed.length < src.length * 0.5, `expected under 50%, got ${((packed.length / src.length) * 100).toFixed(1)}%`);
});

test("the wasm crc32 agrees with the known PKZIP vector", () => {
  const data = enc("123456789");
  const ptr = ex.alloc_buf(data.length);
  new Uint8Array(ex.memory.buffer, ptr, data.length).set(data);
  const crc = ex.crc32(ptr, data.length) >>> 0;
  ex.dealloc_buf(ptr, data.length);
  assert.equal(crc, 0xcbf43926);
});

test("an undersized output buffer reports failure instead of corrupting", () => {
  const data = enc("some text that will not fit in four bytes");
  const inPtr = ex.alloc_buf(data.length);
  const outPtr = ex.alloc_buf(4);
  new Uint8Array(ex.memory.buffer, inPtr, data.length).set(data);
  const n = ex.deflate_raw(inPtr, data.length, outPtr, 4);
  ex.dealloc_buf(inPtr, data.length);
  ex.dealloc_buf(outPtr, 4);
  assert.equal(n, -1);
});

/* ── The ZIP writer's side of the deal ─────────────────────────────────── */

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

test("a compressed entry stores method 8, both sizes, and the CRC of the ORIGINAL bytes", () => {
  const text = "function hello() { return 'world'; }\n".repeat(200);
  const zip = makeZip([{ path: "a.js", content: text }], { deflate });

  assert.equal(u32(zip, 0), 0x04034b50);
  assert.equal(u16(zip, 8), 8, "method must be deflate");
  const csize = u32(zip, 18);
  const usize = u32(zip, 22);
  const raw = enc(text);
  assert.equal(usize, raw.length, "uncompressed size must be the original length");
  assert.ok(csize < usize, "the compressed body must actually be smaller");

  // The body starts after the local header, the name and the extra field.
  const body = zip.slice(30 + u16(zip, 26) + u16(zip, 28), 30 + u16(zip, 26) + u16(zip, 28) + csize);
  assert.equal(new TextDecoder().decode(zlib.inflateRawSync(Buffer.from(body))), text);

  // The CRC must be of the original bytes. Writing the compressed CRC produces
  // an archive every tool rejects, and is the classic way to get this wrong.
  let c = 0xffffffff;
  for (const b of raw) { c ^= b; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  assert.equal(u32(zip, 14), (c ^ 0xffffffff) >>> 0);
});

test("an entry deflate cannot shrink falls back to stored", () => {
  // Eight random-ish bytes: the fixed-Huffman block header alone costs more
  // than they do, so compressing would make the file bigger.
  const tiny = Uint8Array.from([31, 139, 8, 0, 200, 91, 17, 42]);
  const zip = makeZip([{ path: "x.bin", content: tiny }], { deflate });
  assert.equal(u16(zip, 8), 0, "method must fall back to stored");
  assert.equal(u32(zip, 18), u32(zip, 22), "stored sizes must match");
});

test("with no compressor supplied, every entry is stored — the archive is still valid", () => {
  const zip = makeZip([{ path: "a.txt", content: "hello" }]);
  assert.equal(u16(zip, 8), 0);
  assert.equal(u32(zip, zip.length - 22), 0x06054b50);
});

test("the central directory repeats the local header's method and sizes", () => {
  const text = "x".repeat(4000);
  const zip = makeZip([{ path: "big.txt", content: text }], { deflate });
  const cdOffset = u32(zip, zip.length - 22 + 16);
  assert.equal(u32(zip, cdOffset), 0x02014b50);
  assert.equal(u16(zip, cdOffset + 10), u16(zip, 8), "method must match the local header");
  assert.equal(u32(zip, cdOffset + 20), u32(zip, 18), "compressed size must match");
  assert.equal(u32(zip, cdOffset + 24), u32(zip, 22), "uncompressed size must match");
});
