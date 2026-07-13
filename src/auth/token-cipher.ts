import { Injectable } from "@nestjs/common";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { ConfigService } from "../config/config.service";

@Injectable()
export class TokenCipher {
  constructor(private readonly config: ConfigService) {}

  hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.config.value.tokenEncryptionKey,
      iv,
    );
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
      "base64url",
    );
  }

  decrypt(value: string): string {
    const payload = Buffer.from(value, "base64url");
    if (payload.length < 29) throw new Error("Encrypted token is invalid");
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const ciphertext = payload.subarray(28);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.config.value.tokenEncryptionKey,
      iv,
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  }
}
