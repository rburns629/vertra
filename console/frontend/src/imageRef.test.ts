// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { imageName, imageVersion } from "./imageRef";

const digest = `sha256:eb1daf82${"0".repeat(56)}`;

describe("reading an image reference", () => {
  it.each([
    ["registry.example/team/app:1.2", "app", "1.2"],
    [`localhost:5001/local/upper-case@${digest}`, "upper-case", "sha256:eb1daf82"],
    [`localhost:5001/local/upper-case:latest@${digest}`, "upper-case", "latest"],
    ["localhost:5001/local/upper-case", "upper-case", ""],
    ["app", "app", ""],
  ])("%s is %s, version %j", (image, name, version) => {
    expect(imageName(image)).toBe(name);
    expect(imageVersion(image)).toBe(version);
  });
});
