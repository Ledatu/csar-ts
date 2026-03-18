export type { AuthzConfig, Permission, ScopedPermissions, PermissionsApiResponse } from "./types.js";
export { CsarAuthzError } from "./errors.js";
export type { CsarAuthzErrorCode } from "./errors.js";
export { PermissionManager } from "./permission-manager.js";
export { PermissionSnapshot } from "./permission-snapshot.js";
export { matchResource, matchAction } from "./matcher.js";
