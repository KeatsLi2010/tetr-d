import { isIP } from "node:net";

const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export function normalizeOrigins(
  origins: readonly string[]
): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const origin of origins) {
    const value = normalizeOrigin(origin);
    if (value === null) {
      throw new TypeError("WebSocket allowlist entries must be exact origins.");
    }
    normalized.add(value);
  }
  return normalized;
}

export function normalizeOrigin(value: string): string | null {
  if (value.includes(",") || /\s/.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function validPort(value: string): boolean {
  return /^[1-9]\d{0,4}$/.test(value) && Number(value) <= 65_535;
}

export function normalizeHost(value: string): string | null {
  if (value.length === 0 || value.trim() !== value) return null;
  if (value.startsWith("[")) {
    const closing = value.indexOf("]");
    if (closing < 0 || isIP(value.slice(1, closing)) !== 6) return null;
    const suffix = value.slice(closing + 1);
    if (
      suffix !== "" &&
      (!suffix.startsWith(":") || !validPort(suffix.slice(1)))
    ) {
      return null;
    }
    return `[${value.slice(1, closing).toLowerCase()}]${suffix}`;
  }
  const separator = value.lastIndexOf(":");
  if (separator !== value.indexOf(":")) return null;
  const hostname = separator < 0 ? value : value.slice(0, separator);
  const port = separator < 0 ? "" : value.slice(separator + 1);
  if (separator >= 0 && !validPort(port)) return null;
  if (
    isIP(hostname) !== 4 &&
    !hostname.split(".").every((label) => DNS_LABEL.test(label))
  ) {
    return null;
  }
  return hostname.toLowerCase() + (separator < 0 ? "" : `:${port}`);
}

export function normalizeHosts(hosts: readonly string[]): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const host of hosts) {
    const value = normalizeHost(host);
    if (value === null) {
      throw new TypeError("Invalid WebSocket Host allowlist entry.");
    }
    normalized.add(value);
  }
  return normalized;
}

export function normalizeRemoteAddress(
  value: string | undefined
): string | null {
  if (value === undefined) return null;
  const normalized = value.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    const ipv4 = normalized.slice(7);
    if (isIP(ipv4) === 4) return ipv4;
  }
  return isIP(normalized) === 0 ? null : normalized;
}
