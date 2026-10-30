import { createHash, randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
