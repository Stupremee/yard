import { assert, describe, it } from "@effect/vitest";
import { commandLabel } from "../src/dev/config.ts";

describe("dev configuration", () => {
  it("derives useful command labels", () => {
    assert.strictEqual(commandLabel("pnpm run dev:web"), "dev:web");
    assert.strictEqual(commandLabel("bun dev"), "dev");
    assert.strictEqual(commandLabel("node server.js"), "node");
  });
});
