/**
 * URL pattern matching for client-side RBAC permission evaluation.
 *
 * Ported from csar-authz's Go engine/matcher.go.
 *
 * Pattern syntax:
 * - Exact segments match literally: /api/v1/users matches /api/v1/users
 * - Single wildcard (*) matches exactly one path segment
 * - Double wildcard (**) matches zero or more segments
 * - A standalone "**" or "/**" matches everything
 */

/**
 * Checks if a URL path matches a resource pattern.
 */
export function matchResource(pattern: string, path: string): boolean {
  const patParts = splitPath(pattern);
  const pathParts = splitPath(path);
  return matchParts(patParts, pathParts);
}

/**
 * Checks if an action matches a permission action.
 * "*" matches any action. Otherwise, case-insensitive exact match.
 */
export function matchAction(permAction: string, reqAction: string): boolean {
  if (permAction === "*") return true;
  return permAction.toLowerCase() === reqAction.toLowerCase();
}

/** Splits a path by "/" and removes empty segments. */
function splitPath(p: string): string[] {
  return p.split("/").filter((s) => s !== "");
}

/** Recursively matches pattern parts against path parts. */
function matchParts(pattern: string[], path: string[]): boolean {
  let pi = 0;
  let pj = 0;

  while (pi < pattern.length) {
    if (pattern[pi] === "**") {
      // If ** is the last pattern segment, it matches everything remaining.
      if (pi === pattern.length - 1) return true;

      // Try matching the rest of the pattern at every possible position.
      for (let k = pj; k <= path.length; k++) {
        if (matchParts(pattern.slice(pi + 1), path.slice(k))) return true;
      }
      return false;
    }

    // No more path segments but pattern still has non-** segments.
    if (pj >= path.length) return false;

    if (pattern[pi] === "*") {
      // Single wildcard: matches exactly one segment.
      pi++;
      pj++;
      continue;
    }

    // Exact match.
    if (pattern[pi] !== path[pj]) return false;
    pi++;
    pj++;
  }

  // Pattern consumed: path must also be fully consumed.
  return pj === path.length;
}
