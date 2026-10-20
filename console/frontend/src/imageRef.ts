// SPDX-License-Identifier: MIT
/**
 * Reading an image reference for display: registry/path/name, then an
 * optional :tag, then an optional @sha256:digest (a registry's port, as in
 * localhost:5001, isn't a tag).
 */

function split(image: string): { path: string; tag: string | null; digest: string | null } {
  const at = image.indexOf("@");
  const digest = at === -1 ? null : image.slice(at + 1);
  const rest = at === -1 ? image : image.slice(0, at);
  const lastSlash = rest.lastIndexOf("/");
  const colon = rest.indexOf(":", lastSlash + 1);
  return colon === -1
    ? { path: rest, tag: null, digest }
    : { path: rest.slice(0, colon), tag: rest.slice(colon + 1), digest };
}

/** "registry/path/name:tag@sha256:…" → "name". */
export function imageName(image: string): string {
  const { path } = split(image);
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Which version: its tag, else a short digest ("sha256:eb1daf82"), else "". */
export function imageVersion(image: string): string {
  const { tag, digest } = split(image);
  if (tag) return tag;
  if (digest) return digest.slice(0, digest.indexOf(":") + 9);
  return "";
}
