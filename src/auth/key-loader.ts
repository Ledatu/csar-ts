import type { CsarServiceKey, CsarAuthConfig } from "./types.js";
import { CsarAuthError } from "./errors.js";

/**
 * Loads and validates a service key from config.
 * Supports `keyData` (all runtimes) and `keyFile` (Node.js only).
 */
export async function loadServiceKey(
  config: CsarAuthConfig,
): Promise<CsarServiceKey> {
  // Prevent credentials from being sent over plain HTTP
  if (
    config.stsEndpoint &&
    !config.stsEndpoint.startsWith("https://") &&
    !config.stsEndpoint.startsWith("http://localhost") &&
    !config.stsEndpoint.startsWith("http://127.0.0.1")
  ) {
    throw new CsarAuthError(
      "stsEndpoint must use HTTPS to prevent credential leakage",
      "KEY_LOAD_FAILED",
    );
  }

  if (config.keyData) {
    validateKey(config.keyData);
    return config.keyData;
  }

  if (config.keyFile) {
    let raw: string;
    try {
      // Dynamic import — works only in Node.js runtimes.
      // Uses Function constructor to prevent bundlers from statically analyzing the import.
      const fs = await (Function('return import("node:fs/promises")')() as Promise<{
        readFile(path: string, encoding: string): Promise<string>;
      }>);
      raw = await fs.readFile(config.keyFile, "utf-8");
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (
        msg.includes("ERR_MODULE_NOT_FOUND") ||
        msg.includes("Module not found") ||
        msg.includes("Cannot find module")
      ) {
        throw new CsarAuthError(
          "keyFile is not supported in this runtime. Use keyData instead.",
          "KEY_FILE_UNSUPPORTED_RUNTIME",
        );
      }
      throw new CsarAuthError(
        `Failed to load key file: ${msg}`,
        "KEY_LOAD_FAILED",
      );
    }

    let key: CsarServiceKey;
    try {
      key = JSON.parse(raw) as CsarServiceKey;
    } catch {
      throw new CsarAuthError(
        `Failed to parse key file as JSON: ${config.keyFile}`,
        "KEY_LOAD_FAILED",
      );
    }

    validateKey(key);
    return key;
  }

  throw new CsarAuthError(
    "Either keyFile or keyData must be provided in auth config",
    "KEY_LOAD_FAILED",
  );
}

function validateKey(key: CsarServiceKey): void {
  if (!key.id || !key.service_account_id || !key.private_key) {
    throw new CsarAuthError(
      "Invalid service key: missing required fields (id, service_account_id, private_key)",
      "INVALID_KEY",
    );
  }
  if (key.key_algorithm !== "ED25519" && key.key_algorithm !== "RS256") {
    throw new CsarAuthError(
      `Unsupported key algorithm: ${key.key_algorithm}. Expected ED25519 or RS256.`,
      "INVALID_KEY",
    );
  }
}
