import { describe, expect, test } from "bun:test";
import { isHostAllowed, parseAllowedHosts } from "./http-transport.js";

describe("http transport host validation", () => {
  test("uses loopback defaults when no allow-list is set", () => {
    const allowedHosts = parseAllowedHosts(undefined, "127.0.0.1");

    expect(allowedHosts.has("127.0.0.1")).toBe(true);
    expect(allowedHosts.has("localhost")).toBe(true);
    expect(allowedHosts.has("[::1]")).toBe(true);
  });

  test("accepts exact host matches and normalized host headers", () => {
    const allowedHosts = parseAllowedHosts("example.com,localhost", "127.0.0.1");

    expect(isHostAllowed("example.com", allowedHosts)).toBe(true);
    expect(isHostAllowed("example.com:3000", allowedHosts)).toBe(true);
    expect(isHostAllowed("localhost:3000", allowedHosts)).toBe(true);
    expect(isHostAllowed("malicious.example", allowedHosts)).toBe(false);
  });
});
