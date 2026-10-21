// SPDX-License-Identifier: MIT
/**
 * Reading an image reference the way the kubelet does. Pure, so the
 * database layer (image repository ownership) can use it as well as the
 * image policy. Keep in step with image-policy.yaml's and
 * identity-policy.yaml's CEL.
 */

/** An image as the kubelet reads it: `node:20` is
 * `docker.io/library/node:20`, `team/app` is `docker.io/team/app`. */
export function normalizeImage(image: string): string {
  const first = image.split("/")[0] ?? "";
  const hasHost = image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  if (hasHost) return image;
  return image.includes("/") ? `docker.io/${image}` : `docker.io/library/${image}`;
}

/** An image without its tag or digest, normalized: what every release of
 * one product has in common (`…/app:1.2`, `…/app@sha256:…` and a pinned
 * `…/app:1.2@sha256:…` are `…/app`). The digest comes off, then the tag, as
 * the identity policy's CEL does. */
export function imageRepository(image: string): string {
  const normalized = normalizeImage(image);
  const at = normalized.indexOf("@");
  const unpinned = at >= 0 ? normalized.slice(0, at) : normalized;
  const colon = unpinned.lastIndexOf(":");
  return colon > unpinned.lastIndexOf("/") ? unpinned.slice(0, colon) : unpinned;
}
