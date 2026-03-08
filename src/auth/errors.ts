import { CsarError } from "../errors.js";

/**
 * Error codes for authentication failures.
 */
export type CsarAuthErrorCode =
  | "KEY_LOAD_FAILED"
  | "KEY_FILE_UNSUPPORTED_RUNTIME"
  | "INVALID_KEY"
  | "ASSERTION_SIGN_FAILED"
  | "STS_EXCHANGE_FAILED";

/**
 * Thrown when authentication fails at any stage:
 * key loading, assertion signing, or STS token exchange.
 */
export class CsarAuthError extends CsarError {
  public readonly code: CsarAuthErrorCode;

  constructor(message: string, code: CsarAuthErrorCode) {
    super(message);
    this.name = "CsarAuthError";
    this.code = code;
  }
}
