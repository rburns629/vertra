// SPDX-License-Identifier: MIT
/** Turning database rows into messages: the conversions every service shares. */
import { timestampFromDate, type Timestamp } from "@bufbuild/protobuf/wkt";

/** A row's date (or ISO string), or unset when it has none. */
export function timestamp(value: Date | string | null | undefined): Timestamp | undefined {
  if (value === null || value === undefined) return undefined;
  return timestampFromDate(typeof value === "string" ? new Date(value) : value);
}

/** A protobuf "unset" ("" or 0) as undefined, for optional query fields. */
export function unsetIfEmpty<T extends string | number>(value: T): T | undefined {
  return value === "" || value === 0 ? undefined : value;
}
