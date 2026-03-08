import { SignJWT, importPKCS8 } from "jose";
import type { CsarServiceKey } from "./types.js";
import { CsarAuthError } from "./errors.js";

/**
 * Creates a short-lived JWT assertion for the STS token exchange.
 *
 * The assertion is signed with the service key and has a 60-second lifetime.
 */
export async function createAssertion(
  key: CsarServiceKey,
  audience: string,
): Promise<string> {
  const alg = key.key_algorithm === "ED25519" ? "EdDSA" : "RS256";

  let privateKey: CryptoKey;
  try {
    privateKey = await importPKCS8(key.private_key, alg);
  } catch {
    throw new CsarAuthError(
      "Failed to import private key: invalid or unsupported PEM format",
      "ASSERTION_SIGN_FAILED",
    );
  }

  const jti =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : fallbackUUID();

  const now = Math.floor(Date.now() / 1000);

  try {
    return await new SignJWT({
      iss: key.service_account_id,
      sub: key.service_account_id,
      aud: audience,
      jti,
    })
      .setProtectedHeader({ alg, kid: key.id })
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(privateKey);
  } catch (err) {
    throw new CsarAuthError(
      `Failed to sign assertion: ${(err as Error).message}`,
      "ASSERTION_SIGN_FAILED",
    );
  }
}

function fallbackUUID(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  // Set version 4 (bits 12-15 of time_hi_and_version)
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  // Set variant (bits 6-7 of clock_seq_hi_and_reserved)
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
