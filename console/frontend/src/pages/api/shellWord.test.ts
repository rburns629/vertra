// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { shellWord } from "./ApiOverview";

// Node's, without the app's types knowing Node: the test runs in Node.
const childProcess = "node:child_process";
const { execFileSync } = (await import(/* @vite-ignore */ childProcess)) as {
  execFileSync: (file: string, args: string[], options: { encoding: "utf8" }) => string;
};

describe("shellWord", () => {
  it("gives a shell the text back, whatever a catalog path holds", () => {
    for (const text of ["https://gw/team/orders/orders/<orderId>", "/x'$(touch /tmp/pwned)'", "/a`id`b", "/it's \"quoted\" $HOME\\n"]) {
      // A real shell reads the word: it prints the text, and runs nothing in it.
      expect(execFileSync("sh", ["-c", `printf %s ${shellWord(text)}`], { encoding: "utf8" })).toBe(text);
    }
  });
});
