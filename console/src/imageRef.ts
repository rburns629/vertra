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
 * one product has in common (`…/app:1.2` and `…/app@sha256:…` are `…/app`). */
export function imageRepository(image: string): string {
  const normalized = normalizeImage(image);
  const at = normalized.indexOf("@");
  if (at >= 0) return normalized.slice(0, at);
  const colon = normalized.lastIndexOf(":");
  return colon > normalized.lastIndexOf("/") ? normalized.slice(0, colon) : normalized;
}
