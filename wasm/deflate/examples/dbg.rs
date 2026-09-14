//! Native smoke check for the compressor.
//!
//! Exists because a panic inside a `panic=abort` wasm module surfaces as
//! `RuntimeError: unreachable` with a stack of numbered function indices,
//! which tells you nothing. Running the same code natively turns that into
//! "index out of bounds: the len is 10800 but the index is 10800" and a line
//! number — which is exactly how the one out-of-bounds in the match finder was
//! found.
//!
//!     cargo run --example dbg
//!
//! Correctness against a real decoder is asserted from JS, in
//! tests/deflate.test.mjs, where zlib is available to inflate the result.

fn check(name: &str, data: &[u8]) {
    let mut out = vec![0u8; data.len() + data.len() / 8 + 64];
    let n = unsafe { waios_deflate::deflate_raw(data.as_ptr(), data.len(), out.as_mut_ptr(), out.len()) };
    let pct = if data.is_empty() { 0.0 } else { n as f64 / data.len() as f64 * 100.0 };
    println!("{name:<28} {:>8} -> {:>8}  {pct:>6.1}%", data.len(), n);
}

fn main() {
    check("empty", b"");
    check("one byte", b"a");
    check("highly repetitive", "abcabc".repeat(2000).as_bytes());
    check("one byte, many times", &vec![b'A'; 200_000]);
    // The match finder reads one byte past the current best match; an input
    // whose best match runs to the final byte is what walked off the end.
    check("match to the last byte", "xy".repeat(128).as_bytes());
    let noise: Vec<u8> = (0..70_000u32).map(|i| (i.wrapping_mul(2_654_435_761) & 0xff) as u8).collect();
    check("incompressible noise", &noise);
    check("this file", include_bytes!("../src/lib.rs"));
}
