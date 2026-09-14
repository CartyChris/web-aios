/**
 * ZIP writer tests.
 *
 * Export is what makes a user's work portable out of this OS, so a malformed
 * archive is a data-loss bug wearing a download button. These assert the two
 * things that actually break hand-rolled writers — CRC-32 correctness and
 * byte-exact central-directory offsets — by parsing the bytes back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeZip, crc32 } from "../.test-build/zip.js";

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, EOCD = 0x06054b50;
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

test("crc32 matches the known PKZIP vector", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("an empty archive is still a valid archive", () => {
  const z = makeZip([]);
  assert.equal(u32(z, z.length - 22), EOCD);
  assert.equal(u16(z, z.length - 22 + 10), 0, "entry count must be 0");
});

test("every local header carries the right signature, size and CRC", () => {
  const enc = new TextEncoder();
  const entries = [
    { path: "a.txt", content: "hello" },
    { path: "nested/dir/b.json", content: '{"k":1}' },
    { path: "empty", content: "" },
  ];
  const z = makeZip(entries);
  let at = 0;
  for (const e of entries) {
    assert.equal(u32(z, at), LOCAL, `local header for ${e.path}`);
    const data = enc.encode(e.content);
    assert.equal(u32(z, at + 14), crc32(data), `crc for ${e.path}`);
    assert.equal(u32(z, at + 18), data.length, `compressed size for ${e.path}`);
    assert.equal(u32(z, at + 22), data.length, `uncompressed size for ${e.path}`);
    const nameLen = u16(z, at + 26);
    assert.equal(new TextDecoder().decode(z.slice(at + 30, at + 30 + nameLen)), e.path);
    at += 30 + nameLen + u16(z, at + 28) + data.length;
  }
  assert.equal(u32(z, at), CENTRAL, "central directory must follow the last entry");
});

test("central directory offsets point at real local headers", () => {
  const entries = [
    { path: "one.txt", content: "1".repeat(100) },
    { path: "two.txt", content: "2".repeat(7) },
    { path: "three.txt", content: "3" },
  ];
  const z = makeZip(entries);
  const eocd = z.length - 22;
  assert.equal(u32(z, eocd), EOCD);
  assert.equal(u16(z, eocd + 10), entries.length);

  let cd = u32(z, eocd + 16);
  for (let i = 0; i < entries.length; i++) {
    assert.equal(u32(z, cd), CENTRAL, `central record ${i}`);
    const offset = u32(z, cd + 42);
    assert.equal(u32(z, offset), LOCAL, `central record ${i} must point at a local header`);
    cd += 46 + u16(z, cd + 28) + u16(z, cd + 30) + u16(z, cd + 32);
  }
});

test("non-ASCII paths and content survive as UTF-8", () => {
  const z = makeZip([{ path: "café/日本語.md", content: "— ✓ café" }]);
  const nameLen = u16(z, 26);
  assert.equal(new TextDecoder().decode(z.slice(30, 30 + nameLen)), "café/日本語.md");
  assert.equal(u16(z, 6) & 0x0800, 0x0800, "UTF-8 flag bit 11 must be set");
});

test("leading slashes and backslashes are normalised", () => {
  const z = makeZip([{ path: "/win\\path\\file.txt", content: "x" }]);
  const nameLen = u16(z, 26);
  assert.equal(new TextDecoder().decode(z.slice(30, 30 + nameLen)), "win/path/file.txt");
});

test("binary content is written through untouched", () => {
  const bin = new Uint8Array([0, 1, 2, 255, 128, 0, 77]);
  const z = makeZip([{ path: "b.bin", content: bin }]);
  const nameLen = u16(z, 26);
  assert.deepEqual(z.slice(30 + nameLen, 30 + nameLen + bin.length), bin);
  assert.equal(u32(z, 14), crc32(bin));
});
