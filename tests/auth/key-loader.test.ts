import { describe, it, expect } from "vitest";
import { loadServiceKey } from "../../src/auth/key-loader.js";
import { CsarAuthError } from "../../src/auth/errors.js";
import { generateTestKey } from "./fixtures.js";

describe("loadServiceKey", () => {
  it("returns keyData directly when provided", async () => {
    const key = await generateTestKey("ED25519");
    const result = await loadServiceKey({
      stsEndpoint: "https://sts.example.com/token",
      keyData: key,
    });
    expect(result).toBe(key);
  });

  it("validates ED25519 keyData successfully", async () => {
    const key = await generateTestKey("ED25519");
    const result = await loadServiceKey({
      stsEndpoint: "https://sts.example.com/token",
      keyData: key,
    });
    expect(result.key_algorithm).toBe("ED25519");
  });

  it("validates RS256 keyData successfully", async () => {
    const key = await generateTestKey("RS256");
    const result = await loadServiceKey({
      stsEndpoint: "https://sts.example.com/token",
      keyData: key,
    });
    expect(result.key_algorithm).toBe("RS256");
  });

  it("throws INVALID_KEY when id is missing", async () => {
    const key = await generateTestKey("ED25519");
    const broken = { ...key, id: "" };
    await expect(
      loadServiceKey({
        stsEndpoint: "https://sts.example.com/token",
        keyData: broken,
      }),
    ).rejects.toThrow(CsarAuthError);

    try {
      await loadServiceKey({
        stsEndpoint: "https://sts.example.com/token",
        keyData: broken,
      });
    } catch (err) {
      expect((err as CsarAuthError).code).toBe("INVALID_KEY");
    }
  });

  it("throws INVALID_KEY when service_account_id is missing", async () => {
    const key = await generateTestKey("ED25519");
    const broken = { ...key, service_account_id: "" };
    await expect(
      loadServiceKey({
        stsEndpoint: "https://sts.example.com/token",
        keyData: broken,
      }),
    ).rejects.toThrow(CsarAuthError);
  });

  it("throws INVALID_KEY when private_key is missing", async () => {
    const key = await generateTestKey("ED25519");
    const broken = { ...key, private_key: "" };
    await expect(
      loadServiceKey({
        stsEndpoint: "https://sts.example.com/token",
        keyData: broken,
      }),
    ).rejects.toThrow(CsarAuthError);
  });

  it("throws INVALID_KEY for unsupported algorithm", async () => {
    const key = await generateTestKey("ED25519");
    const broken = { ...key, key_algorithm: "UNSUPPORTED" as "ED25519" };
    await expect(
      loadServiceKey({
        stsEndpoint: "https://sts.example.com/token",
        keyData: broken,
      }),
    ).rejects.toThrow(/Unsupported key algorithm/);
  });

  it("throws KEY_LOAD_FAILED when neither keyFile nor keyData is provided", async () => {
    await expect(
      loadServiceKey({ stsEndpoint: "https://sts.example.com/token" }),
    ).rejects.toThrow(CsarAuthError);

    try {
      await loadServiceKey({ stsEndpoint: "https://sts.example.com/token" });
    } catch (err) {
      expect((err as CsarAuthError).code).toBe("KEY_LOAD_FAILED");
    }
  });

  it("throws KEY_LOAD_FAILED for non-existent key file", async () => {
    await expect(
      loadServiceKey({
        stsEndpoint: "https://sts.example.com/token",
        keyFile: "/tmp/non-existent-key-file.json",
      }),
    ).rejects.toThrow(CsarAuthError);
  });
});
