/* ────────────────────────────────────────────────────────────────────────────
   DEFLATE, via a Rust module compiled to WebAssembly.

   The ZIP writer used to store every entry uncompressed, which made export —
   the feature that makes what you build *yours* rather than ours — the fattest
   operation in the OS. The two normal fixes are both bad here: shipping a JS
   deflate costs 40-90 KB of bundle to save bytes on a download, and doing it
   on a server means your project has to leave your machine to be zipped.

   So it is ~12 KB of wasm (source in wasm/deflate/src/lib.rs), fetched lazily
   the first time you export anything and never on the boot path.

   Every call site treats this as an *optimisation that may not be available*.
   If the fetch fails, the bytes are wrong, or the runtime has no WebAssembly,
   the caller falls back to stored entries and still produces a valid archive.
   A failed optimisation must never become a failed export.
   ──────────────────────────────────────────────────────────────────────────── */

interface DeflateExports {
  memory: WebAssembly.Memory;
  alloc_buf(len: number): number;
  dealloc_buf(ptr: number, len: number): void;
  deflate_raw(inPtr: number, inLen: number, outPtr: number, outCap: number): number;
  crc32(ptr: number, len: number): number;
}

export interface Compressor {
  /** Raw DEFLATE (no zlib or gzip wrapper) — what ZIP method 8 wants.
   *  Returns null when the result would not be smaller than the input. */
  deflate(bytes: Uint8Array): Uint8Array | null;
  crc32(bytes: Uint8Array): number;
}

let cached: Promise<Compressor | null> | null = null;

/** Load the module. Resolves to null — never rejects — when unavailable. */
export function loadCompressor(url = "/deflate.wasm"): Promise<Compressor | null> {
  if (cached) return cached;
  cached = (async () => {
    try {
      if (typeof WebAssembly === "undefined") return null;
      const res = await fetch(url);
      if (!res.ok) return null;
      const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
      const ex = instance.exports as unknown as DeflateExports;
      if (typeof ex.deflate_raw !== "function" || !ex.memory) return null;
      return makeCompressor(ex);
    } catch {
      return null;
    }
  })();
  return cached;
}

function makeCompressor(ex: DeflateExports): Compressor {
  /** Run `fn` with `bytes` copied into wasm memory, then always free.
   *
   *  The view is taken *after* every allocation, because growing wasm memory
   *  detaches the old ArrayBuffer and any view over it silently becomes a
   *  zero-length window — which would corrupt output rather than throw. */
  const withInput = <T>(bytes: Uint8Array, fn: (ptr: number, len: number) => T): T => {
    const len = bytes.length;
    const ptr = ex.alloc_buf(len || 1);
    try {
      new Uint8Array(ex.memory.buffer, ptr, len).set(bytes);
      return fn(ptr, len);
    } finally {
      ex.dealloc_buf(ptr, len || 1);
    }
  };

  return {
    deflate(bytes) {
      if (bytes.length === 0) return null;
      // Worst case for fixed-Huffman on incompressible input is ~9 bits per
      // byte plus the block header; the slack covers it with room to spare.
      const cap = bytes.length + (bytes.length >> 3) + 64;
      const inPtr = ex.alloc_buf(bytes.length);
      const outPtr = ex.alloc_buf(cap);
      try {
        new Uint8Array(ex.memory.buffer, inPtr, bytes.length).set(bytes);
        const n = ex.deflate_raw(inPtr, bytes.length, outPtr, cap);
        if (n < 0 || n >= bytes.length) return null; // overflowed, or not a win
        return new Uint8Array(ex.memory.buffer, outPtr, n).slice();
      } catch {
        return null;
      } finally {
        ex.dealloc_buf(inPtr, bytes.length);
        ex.dealloc_buf(outPtr, cap);
      }
    },
    crc32(bytes) {
      if (bytes.length === 0) return 0;
      return withInput(bytes, (ptr, len) => ex.crc32(ptr, len) >>> 0);
    },
  };
}

/** Reset the module cache. Tests only. */
export function __resetCompressor() {
  cached = null;
}
