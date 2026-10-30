import dns from "node:dns/promises";
import net from "node:net";

const BLOCKED_V4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
] as const;

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function isPrivateV4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  );
}

/**
 * 只允许 http/https 的公网地址。
 * DNS 解析后逐个地址检查，防止 localhost / 内网 / 云元数据地址被访问。
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL 格式不合法");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("只允许 http/https");
  }
  if (url.username || url.password) {
    throw new Error("URL 不能带账号密码");
  }

  const host = url.hostname;
  if (net.isIP(host)) {
    const blocked = net.isIPv4(host) ? isPrivateV4(host) : isPrivateV6(host);
    if (blocked) throw new Error("拒绝访问内网地址");
    return url;
  }

  const addresses = await dns.lookup(host, { all: true });
  for (const address of addresses) {
    const blocked = address.family === 4 ? isPrivateV4(address.address) : isPrivateV6(address.address);
    if (blocked) throw new Error("拒绝访问内网地址");
  }
  return url;
}

export async function fetchPublicText(raw: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
  const url = await assertPublicUrl(raw);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "RelationshipAgent/0.1" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/(html|plain)|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error(`不支持的 content-type: ${contentType || "unknown"}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("响应没有 body");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("响应超过 2MB");
      }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return buffer.toString("utf8");
  } finally {
    clearTimeout(timeout);
  }
}
