// SPDX-License-Identifier: MIT
/**
 * A refusal from the console's own logic (src/core/), the same for both
 * ways of calling it:
 *
 * - REST routes let it propagate: the global error handler (index.ts)
 *   answers any error with a status below 500 as {error: code, message},
 *   exactly what the routes used to send themselves.
 * - Connect services let it propagate too: rpc/interceptors.ts turns it
 *   into a ConnectError with the matching code and the stable `code` as a
 *   Failure detail.
 *
 * Only for expected refusals. A real failure (the database, the cluster)
 * stays an ordinary error, which both paths log and answer generically.
 */
import { Code } from "@connectrpc/connect";

export class ApiError extends Error {
  constructor(
    /** The HTTP status a REST route answers with (4xx). */
    readonly statusCode: number,
    /** A stable code: FORBIDDEN, TEAM_RETIRED, LAST_MEMBER, ... */
    readonly code: string,
    message: string,
    /** The Connect code, when the status's usual one doesn't fit. */
    readonly connectCode: Code = connectCodeFor(statusCode),
    /** More fields for a REST error body (a failed scan's findings, say). */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function connectCodeFor(statusCode: number): Code {
  switch (statusCode) {
    case 400:
    case 422:
      return Code.InvalidArgument;
    case 401:
      return Code.Unauthenticated;
    case 403:
      return Code.PermissionDenied;
    case 404:
      return Code.NotFound;
    case 409:
      return Code.FailedPrecondition;
    case 429:
      return Code.ResourceExhausted;
    case 503:
      return Code.Unavailable;
    default:
      return Code.Unknown;
  }
}

export const forbiddenUnlessAdmin = (caller: { isAdmin: boolean } | undefined, message = "Admin access required."): void => {
  if (!caller?.isAdmin) throw new ApiError(403, "FORBIDDEN", message);
};
