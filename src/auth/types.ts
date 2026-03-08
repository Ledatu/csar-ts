/**
 * Structure of the authorized_key.json file issued by csar-helper.
 */
export interface CsarServiceKey {
  /** Key ID — used as `kid` in the JWT header. */
  id: string;

  /** Service account identifier — used as `iss` and `sub` in the JWT payload. */
  service_account_id: string;

  /** ISO-8601 timestamp of key creation. */
  created_at: string;

  /** Signing algorithm. */
  key_algorithm: "ED25519" | "RS256";

  /** PEM-encoded public key. */
  public_key: string;

  /** PEM-encoded private key (sensitive). */
  private_key: string;
}

/**
 * Authentication configuration for the CSAR STS flow.
 */
export interface CsarAuthConfig {
  /** URL of the Security Token Service endpoint. */
  stsEndpoint: string;

  /** Path to a JSON key file (Node.js only). */
  keyFile?: string;

  /** Key data object — works in all runtimes (Node.js, Edge, browser). */
  keyData?: CsarServiceKey;

  /** Audience claim for the JWT assertion. Defaults to `stsEndpoint`. */
  audience?: string;

  /** Max retries for STS token exchange failures (default: 2). */
  maxStsRetries?: number;
}

/**
 * STS token exchange response.
 */
export interface TokenResponse {
  access_token: string;
  token_type: string;
  /** Token lifetime in seconds. */
  expires_in: number;
}

/**
 * In-memory cached token.
 */
export interface CachedToken {
  accessToken: string;
  /** Absolute expiry timestamp in milliseconds. */
  expiresAt: number;
}
