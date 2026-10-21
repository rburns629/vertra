// SPDX-License-Identifier: MIT
/** An image's repository (src/imageRef.ts), as the identity policy reads it. */
import { describe, expect, it } from "vitest";
import { imageRepository } from "../src/imageRef.js";

describe("imageRepository", () => {
  it("is the same for every way of naming one image", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    for (const image of [
      "localhost:5001/local/app",
      "localhost:5001/local/app:1.2",
      `localhost:5001/local/app@${digest}`,
      // How the console pins a tag at submission.
      `localhost:5001/local/app:latest@${digest}`,
    ]) {
      expect(imageRepository(image), image).toBe("localhost:5001/local/app");
    }
    expect(imageRepository(`node:20@${digest}`)).toBe("docker.io/library/node");
  });
});
