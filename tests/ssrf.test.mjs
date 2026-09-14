/**
 * SSRF guard tests. The proxy is the one route that takes a URL from a user
 * and fetches it, so its address checks are security-critical and must fail
 * loudly if anyone loosens them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateAddress } from "../.test-build/ssrf.js";

const BLOCKED = [
  "127.0.0.1", "127.53.1.9", "0.0.0.0", "10.0.0.1", "10.255.255.254",
  "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
  "100.64.0.1", "224.0.0.1", "255.255.255.255",
  "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1",
  "::ffff:169.254.169.254", "::ffff:10.0.0.1",
];
const ALLOWED = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.0.1", "2606:4700::1111"];

test("every private, loopback, link-local and metadata address is refused", () => {
  for (const ip of BLOCKED) assert.equal(isPrivateAddress(ip), true, `${ip} must be blocked`);
});

test("public addresses are allowed", () => {
  for (const ip of ALLOWED) assert.equal(isPrivateAddress(ip), false, `${ip} must be allowed`);
});

test("malformed input fails closed", () => {
  for (const junk of ["", "not-an-ip", "1.2.3", "999.1.1.1"]) {
    assert.equal(isPrivateAddress(junk), true, `${junk} must fail closed`);
  }
});
