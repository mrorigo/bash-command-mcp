import type { IncomingMessage, ServerResponse } from "node:http";

export function parseAllowedHosts(
  value: string | undefined,
  fallbackHost: string,
): Set<string> {
  if (!value) {
    return new Set([fallbackHost, "localhost", "127.0.0.1", "[::1]"]);
  }

  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

export function isHostAllowed(
  hostHeader: string | undefined,
  allowedHosts: Set<string>,
): boolean {
  if (!hostHeader) {
    return false;
  }

  const host = hostHeader.toLowerCase();
  const normalizedHost = host.split(":")[0] ?? host;
  return (
    allowedHosts.has(host) ||
    allowedHosts.has(normalizedHost) ||
    allowedHosts.has(hostHeader)
  );
}

export function validateHostHeader(
  req: IncomingMessage,
  res: ServerResponse,
  httpHost: string,
  allowedHosts: Set<string>,
): boolean {
  if (httpHost === "0.0.0.0" || httpHost === "::") {
    return true;
  }

  if (isHostAllowed(req.headers.host, allowedHosts)) {
    return true;
  }

  res.statusCode = 403;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end("Forbidden");
  return false;
}
