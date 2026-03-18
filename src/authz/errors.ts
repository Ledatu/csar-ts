import { CsarError } from "../errors.js";

/**
 * Error codes for authorization/permissions failures.
 */
export type CsarAuthzErrorCode =
  | "PERMISSIONS_FETCH_FAILED"
  | "PERMISSIONS_PARSE_ERROR";

/**
 * Thrown when fetching or parsing permissions fails.
 */
export class CsarAuthzError extends CsarError {
  public readonly code: CsarAuthzErrorCode;

  constructor(message: string, code: CsarAuthzErrorCode) {
    super(message);
    this.name = "CsarAuthzError";
    this.code = code;
  }
}
