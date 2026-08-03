import { createDecipheriv, createHash } from "node:crypto";

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
