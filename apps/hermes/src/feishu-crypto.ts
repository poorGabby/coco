import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";

export function secretsEqual(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyFeishuEventToken(
  payload: { token?: unknown; header?: { token?: unknown } },
  expected: string,
): boolean {
  const token = payload.header?.token ?? payload.token;
  return typeof token === "string" && secretsEqual(token, expected);
}

/** 飞书 Encrypt Key 解密（AES-256-CBC，密文格式 base64(iv + ciphertext)） */
export function decryptFeishuPayload(encryptKey: string, encrypted: string): string {
  const key = createHash("sha256").update(encryptKey).digest();
  const buf = Buffer.from(encrypted, "base64");
  const iv = buf.subarray(0, 16);
  const ciphertext = buf.subarray(16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}
