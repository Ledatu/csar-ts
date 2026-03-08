import { describe, it, expect } from "vitest";
import { createAssertion } from "../../src/auth/assertion.js";
import { CsarAuthError } from "../../src/auth/errors.js";
import { generateTestKey } from "./fixtures.js";
import { decodeJwt, decodeProtectedHeader } from "jose";

describe("createAssertion", () => {
  it("creates a valid JWT for ED25519 key", async () => {
    const key = await generateTestKey("ED25519");
    const token = await createAssertion(key, "https://sts.example.com/token");

    expect(token).toBeTruthy();
    expect(token.split(".")).toHaveLength(3);

    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe("EdDSA");
    expect(header.kid).toBe(key.id);

    const payload = decodeJwt(token);
    expect(payload.iss).toBe(key.service_account_id);
    expect(payload.sub).toBe(key.service_account_id);
    expect(payload.aud).toBe("https://sts.example.com/token");
    expect(payload.jti).toBeTruthy();
    expect(payload.exp).toBeDefined();
    expect(payload.iat).toBeDefined();
  });

  it("creates a valid JWT for RS256 key", async () => {
    const key = await generateTestKey("RS256");
    const token = await createAssertion(key, "https://sts.example.com/token");

    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe("RS256");
    expect(header.kid).toBe(key.id);

    const payload = decodeJwt(token);
    expect(payload.iss).toBe(key.service_account_id);
    expect(payload.sub).toBe(key.service_account_id);
  });

  it("sets expiration to 60 seconds after issued-at", async () => {
    const key = await generateTestKey("ED25519");
    const token = await createAssertion(key, "https://sts.example.com/token");

    const payload = decodeJwt(token);
    expect(payload.exp! - payload.iat!).toBe(60);
  });

  it("generates unique jti for each assertion", async () => {
    const key = await generateTestKey("ED25519");
    const token1 = await createAssertion(key, "https://sts.example.com/token");
    const token2 = await createAssertion(key, "https://sts.example.com/token");

    const payload1 = decodeJwt(token1);
    const payload2 = decodeJwt(token2);
    expect(payload1.jti).not.toBe(payload2.jti);
  });

  it("throws ASSERTION_SIGN_FAILED for invalid private key", async () => {
    const key = await generateTestKey("ED25519");
    const broken = { ...key, private_key: "not-a-valid-pem" };

    await expect(
      createAssertion(broken, "https://sts.example.com/token"),
    ).rejects.toThrow(CsarAuthError);

    try {
      await createAssertion(broken, "https://sts.example.com/token");
    } catch (err) {
      expect((err as CsarAuthError).code).toBe("ASSERTION_SIGN_FAILED");
    }
  });
});
