//! A DEFLATE encoder, compiled to WebAssembly.
//!
//! Why this exists
//! ---------------
//! Web-AIOS lets you export anything you build — a widget, a full-stack
//! project, a game — as a .zip. That writer used the "stored" method, which is
//! to say it did not compress at all: a 400 KB project left as 400 KB. Export
//! is the feature that makes what you build *yours*, so it should not be the
//! slowest, fattest thing in the OS.
//!
//! The obvious fix is a JS deflate library, which costs 40-90 KB of bundle to
//! save bytes on a download. This is the other answer: a few hundred lines of
//! Rust that compile to a ~12 KB wasm module, fetched once, lazily, and only
//! when someone actually exports something.
//!
//! What it implements
//! ------------------
//! LZ77 over a 32 KiB window with hash-chain match finding, emitted as
//! fixed-Huffman DEFLATE blocks (RFC 1951 §3.2.6). Fixed Huffman rather than
//! dynamic: the code tables are constant, so there is no second pass and no
//! tree serialisation, and on source code — long shared substrings, lots of
//! ASCII — it already lands in the 60-75% range. Dynamic Huffman would buy
//! maybe another 8%, at several times the complexity and a second pass over
//! every buffer.
//!
//! The ABI is deliberately raw — no wasm-bindgen, no glue, no build step
//! beyond `cargo build`. The host allocates, writes bytes, calls one function,
//! reads bytes back.

use std::alloc::{alloc, dealloc, Layout};

/// Hand back a block of linear memory for the host to write into.
///
/// # Safety
/// The host must pass the same `len` back to `dealloc_buf`.
#[no_mangle]
pub extern "C" fn alloc_buf(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::null_mut();
    }
    // align 1: these are byte buffers and nothing reads them as wider types.
    unsafe { alloc(Layout::from_size_align_unchecked(len, 1)) }
}

/// Release a block obtained from `alloc_buf`.
///
/// # Safety
/// `ptr` must come from `alloc_buf` with the same `len`.
#[no_mangle]
pub unsafe extern "C" fn dealloc_buf(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len != 0 {
        dealloc(ptr, Layout::from_size_align_unchecked(len, 1));
    }
}

/// Compress `in_len` bytes at `in_ptr` into the buffer at `out_ptr`.
///
/// Returns the number of bytes written, or `-1` if the output buffer was too
/// small. Returning rather than panicking matters: a panic in a `panic=abort`
/// wasm module poisons the instance, and the host would have to rebuild it.
///
/// # Safety
/// Both pointers must be valid for their stated lengths.
#[no_mangle]
pub unsafe extern "C" fn deflate_raw(
    in_ptr: *const u8,
    in_len: usize,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i32 {
    let input = std::slice::from_raw_parts(in_ptr, in_len);
    let out = std::slice::from_raw_parts_mut(out_ptr, out_cap);
    match compress(input, out) {
        Some(n) => n as i32,
        None => -1,
    }
}

/// The CRC-32 the ZIP central directory needs, computed here so a caller that
/// is already crossing the wasm boundary does not also walk the buffer in JS.
///
/// # Safety
/// `ptr` must be valid for `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn crc32(ptr: *const u8, len: usize) -> u32 {
    let data = std::slice::from_raw_parts(ptr, len);
    let mut c: u32 = 0xffff_ffff;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            // Branchless-ish: the compiler turns this into a conditional move.
            c = (c >> 1) ^ (0xedb8_8320 & (0u32.wrapping_sub(c & 1)));
        }
    }
    !c
}

/* ── Bit writer ──────────────────────────────────────────────────────────────
   DEFLATE packs bits into bytes starting at the least-significant bit, but
   Huffman codes are defined most-significant-bit first. Getting those two
   conventions backwards is the classic way to produce a stream that every
   decoder rejects, so they are separate methods here rather than one with a
   flag. */
struct BitWriter<'a> {
    out: &'a mut [u8],
    pos: usize,
    bit_buf: u32,
    bit_cnt: u32,
    overflow: bool,
}

impl<'a> BitWriter<'a> {
    fn new(out: &'a mut [u8]) -> Self {
        BitWriter { out, pos: 0, bit_buf: 0, bit_cnt: 0, overflow: false }
    }

    /// Write `n` bits of `v`, least-significant bit first. Used for the block
    /// header and for every "extra bits" field.
    fn bits(&mut self, v: u32, n: u32) {
        self.bit_buf |= (v & ((1u32 << n) - 1)) << self.bit_cnt;
        self.bit_cnt += n;
        while self.bit_cnt >= 8 {
            if self.pos >= self.out.len() {
                self.overflow = true;
                return;
            }
            self.out[self.pos] = (self.bit_buf & 0xff) as u8;
            self.pos += 1;
            self.bit_buf >>= 8;
            self.bit_cnt -= 8;
        }
    }

    /// Write a Huffman code: `n` bits of `code`, most-significant bit first.
    fn code(&mut self, code: u32, n: u32) {
        for i in (0..n).rev() {
            self.bits((code >> i) & 1, 1);
        }
    }

    fn finish(mut self) -> Option<usize> {
        if self.bit_cnt > 0 {
            if self.pos >= self.out.len() {
                return None;
            }
            self.out[self.pos] = (self.bit_buf & 0xff) as u8;
            self.pos += 1;
        }
        if self.overflow {
            None
        } else {
            Some(self.pos)
        }
    }
}

/* ── Fixed Huffman tables (RFC 1951 §3.2.6) ───────────────────────────────── */

/// Literal/length symbol → (code, bit length).
#[inline]
fn lit_code(sym: u32) -> (u32, u32) {
    match sym {
        0..=143 => (0x30 + sym, 8),
        144..=255 => (0x190 + (sym - 144), 9),
        256..=279 => (sym - 256, 7),
        _ => (0xc0 + (sym - 280), 8),
    }
}

/// Match lengths 3..=258 map onto symbols 257..=285, most with extra bits.
const LEN_BASE: [u16; 29] = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
    163, 195, 227, 258,
];
const LEN_EXTRA: [u8; 29] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE: [u16; 30] = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
    2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA: [u8; 30] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13,
];

fn len_slot(len: u16) -> usize {
    // Linear from the top: 258 is by far the most common emitted length, and
    // the table is 29 entries, so a binary search buys nothing measurable.
    let mut i = 28;
    while i > 0 && LEN_BASE[i] > len {
        i -= 1;
    }
    i
}

fn dist_slot(dist: u16) -> usize {
    let mut i = 29;
    while i > 0 && DIST_BASE[i] > dist {
        i -= 1;
    }
    i
}

/* ── LZ77 ────────────────────────────────────────────────────────────────── */

const WINDOW: usize = 32768;
const MIN_MATCH: usize = 3;
const MAX_MATCH: usize = 258;
const HASH_BITS: usize = 15;
const HASH_SIZE: usize = 1 << HASH_BITS;
/// Cap on how far down a hash chain to walk. Unbounded chains are the
/// difference between "compresses a 2 MB project instantly" and "locks the tab
/// up for four seconds on pathological input" — highly repetitive data makes
/// every chain thousands deep for a handful of extra bytes.
const MAX_CHAIN: usize = 128;

#[inline]
fn hash3(a: u8, b: u8, c: u8) -> usize {
    let v = ((a as u32) << 16) | ((b as u32) << 8) | (c as u32);
    ((v.wrapping_mul(0x9E37_79B1)) >> (32 - HASH_BITS)) as usize
}

fn compress(input: &[u8], out: &mut [u8]) -> Option<usize> {
    let mut w = BitWriter::new(out);
    // One final fixed-Huffman block: BFINAL=1, BTYPE=01.
    w.bits(1, 1);
    w.bits(1, 2);

    let n = input.len();
    let mut head = vec![u32::MAX; HASH_SIZE];
    let mut prev = vec![u32::MAX; n.max(1)];
    let mut i = 0usize;

    while i < n {
        let mut best_len = 0usize;
        let mut best_dist = 0usize;

        if i + MIN_MATCH <= n {
            let h = hash3(input[i], input[i + 1], input[i + 2]);
            let mut cand = head[h];
            let limit = i.saturating_sub(WINDOW);
            let mut chain = 0;

            while cand != u32::MAX && (cand as usize) >= limit && chain < MAX_CHAIN {
                let c = cand as usize;
                let max = MAX_MATCH.min(n - i);
                // Nothing left to improve on: the best match already runs to
                // the end of the input. (Reading input[i + best_len] here
                // without this guard walks one byte off the end — the one
                // out-of-bounds this loop can actually produce.)
                if best_len >= max {
                    break;
                }
                // Cheap reject before the real compare: if the byte that would
                // extend the current best does not even match, nothing here can
                // beat it.
                if best_len == 0 || input[c + best_len] == input[i + best_len] {
                    let mut l = 0usize;
                    while l < max && input[c + l] == input[i + l] {
                        l += 1;
                    }
                    if l > best_len {
                        best_len = l;
                        best_dist = i - c;
                        if l >= MAX_MATCH {
                            break;
                        }
                    }
                }
                cand = prev[c];
                chain += 1;
            }

            prev[i] = head[h];
            head[h] = i as u32;
        }

        if best_len >= MIN_MATCH {
            let slot = len_slot(best_len as u16);
            let (c, b) = lit_code(257 + slot as u32);
            w.code(c, b);
            let eb = LEN_EXTRA[slot] as u32;
            if eb > 0 {
                w.bits(best_len as u32 - LEN_BASE[slot] as u32, eb);
            }
            let ds = dist_slot(best_dist as u16);
            // Distance codes are 5-bit fixed, also MSB-first.
            w.code(ds as u32, 5);
            let de = DIST_EXTRA[ds] as u32;
            if de > 0 {
                w.bits(best_dist as u32 - DIST_BASE[ds] as u32, de);
            }

            // Insert every position the match covers into the hash chains, or
            // the next match search starts blind and compression falls apart.
            for k in (i + 1)..(i + best_len).min(n.saturating_sub(MIN_MATCH - 1)) {
                let h = hash3(input[k], input[k + 1], input[k + 2]);
                prev[k] = head[h];
                head[h] = k as u32;
            }
            i += best_len;
        } else {
            let (c, b) = lit_code(input[i] as u32);
            w.code(c, b);
            i += 1;
        }

        if w.overflow {
            return None;
        }
    }

    // End-of-block.
    let (c, b) = lit_code(256);
    w.code(c, b);
    w.finish()
}
