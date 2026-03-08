import { generateKeyPair, exportPKCS8, exportSPKI } from "jose";
import type { CsarServiceKey } from "../../src/auth/types.js";

/**
 * Generates a test service key with real cryptographic material.
 */
export async function generateTestKey(
  alg: "ED25519" | "RS256",
): Promise<CsarServiceKey> {
  const joseAlg = alg === "ED25519" ? "EdDSA" : "RS256";
  const { publicKey, privateKey } = await generateKeyPair(joseAlg, {
    extractable: true,
  });

  return {
    id: `test-key-${alg.toLowerCase()}`,
    service_account_id: "sa-test-account",
    created_at: new Date().toISOString(),
    key_algorithm: alg,
    public_key: await exportSPKI(publicKey),
    private_key: await exportPKCS8(privateKey),
  };
}
