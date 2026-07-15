import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import { discoverDevScripts } from "../src/dev/config.ts";
import { buildDevDefinition, InitError, runInit } from "../src/dev/init.ts";

describe("discoverDevScripts", () => {
  it("returns empty for undefined", () => {
    assert.deepStrictEqual(discoverDevScripts(undefined), []);
  });

  it("returns empty for unrelated scripts only", () => {
    assert.deepStrictEqual(discoverDevScripts({ build: "tsc", test: "vitest" }), []);
  });

  it("includes plain dev", () => {
    const res = discoverDevScripts({ dev: "vite", build: "tsc" });
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0]!.script, "dev");
    assert.strictEqual(res[0]!.label, "dev");
  });

  it("extracts labels for dev:* and skips others", () => {
    const res = discoverDevScripts({ "dev:web": "vite", "dev:api": "node server", build: "tsc" });
    assert.strictEqual(res.length, 2);
    assert.strictEqual(res[0]!.label, "web");
    assert.strictEqual(res[1]!.label, "api");
    assert.strictEqual(res[0]!.script, "dev:web");
  });

  it("places dev first even on mixed ordering", () => {
    const res = discoverDevScripts({ "dev:api": "a", dev: "d", "dev:web": "w", build: "b" });
    assert.strictEqual(res.length, 3);
    assert.strictEqual(res[0]!.script, "dev");
    assert.strictEqual(res[1]!.script, "dev:api");
    assert.strictEqual(res[2]!.script, "dev:web");
  });

  it("keeps labels unique for dev and dev:dev", () => {
    const res = discoverDevScripts({ dev: "vite", "dev:dev": "node server" });
    assert.deepStrictEqual(
      res.map(({ label }) => label),
      ["dev", "dev:dev"],
    );
  });
});

describe("buildDevDefinition", () => {
  it("returns string form only for lone plain dev", () => {
    const def = buildDevDefinition([{ script: "dev", label: "dev", body: "vite" }], "pnpm");
    assert.strictEqual(def, "pnpm run dev");
    assert.strictEqual(typeof def, "string");
  });

  it("returns record form for lone dev:*", () => {
    const def = buildDevDefinition([{ script: "dev:web", label: "web", body: "vite" }], "bun");
    assert.deepStrictEqual(def, { web: "bun run dev:web" });
  });

  it("returns record form for multiple", () => {
    const def = buildDevDefinition(
      [
        { script: "dev", label: "dev", body: "x" },
        { script: "dev:web", label: "web", body: "y" },
      ],
      "vp",
    );
    assert.deepStrictEqual(def, { dev: "vp run dev", web: "vp run dev:web" });
  });

  it("interpolates the provided package manager", () => {
    const def = buildDevDefinition([{ script: "dev", label: "dev", body: "" }], "yarn");
    assert.strictEqual(def, "yarn run dev");
  });
});

describe("runInit", () => {
  it.effect("non-interactive happy path writes yard.json and supports force", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();

        // Setup minimal package.json with dev:*
        yield* fs.writeFileString(
          dir + "/package.json",
          JSON.stringify(
            {
              name: "demo",
              scripts: { "dev:web": "vite", build: "tsc" },
            },
            null,
            2,
          ) + "\n",
        );

        // First run: --script dev:web --target yard (non-int)
        const flags1 = {
          script: ["dev:web"],
          target: Option.some("yard" as const),
          yes: false,
          force: false,
        };
        yield* runInit(dir, flags1);

        const yardContent = yield* fs.readFileString(dir + "/yard.json");
        assert.match(yardContent, /"web": "npm run dev:web"/);
        assert.ok(yardContent.endsWith("\n"));

        // Rerun without force -> InitError
        const err = yield* runInit(dir, { ...flags1, force: false }).pipe(Effect.flip);
        assert(err instanceof InitError);
        assert.match(err.message, /Existing yard configuration/);

        // With force succeeds (overwrites)
        yield* runInit(dir, { ...flags1, force: true });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("package target write preserves unrelated keys, format, and adds yard", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();

        const original = {
          name: "exotic",
          version: "1.0.0",
          scripts: { dev: "node index.js", "dev:web": "vite" },
          "exotic-key": { nested: true },
          private: true,
          yard: { name: "custom" },
        };
        yield* fs.writeFileString(dir + "/package.json", JSON.stringify(original, null, 2) + "\n");

        const flags = {
          script: ["dev", "dev:web"],
          target: Option.some("package" as const),
          yes: false,
          force: true,
        };
        yield* runInit(dir, flags);

        const raw = yield* fs.readFileString(dir + "/package.json");
        assert.ok(raw.endsWith("\n"), "should have trailing newline");
        // 2-space indent check (simple heuristic)
        assert.ok(raw.includes('  "name"'), "should use 2-space indent");
        // preserves exotic
        assert.ok(raw.includes('"exotic-key"'));
        // has yard
        const parsed = JSON.parse(raw);
        assert.ok(parsed.yard);
        assert.ok(parsed.yard.dev);
        assert.strictEqual(parsed.yard.name, "custom");
        // original top level preserved
        assert.strictEqual(parsed.name, "exotic");
        assert.strictEqual(parsed["exotic-key"].nested, true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("force replaces a malformed yard.json", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(
          dir + "/package.json",
          JSON.stringify({ scripts: { dev: "vite" } }) + "\n",
        );
        yield* fs.writeFileString(dir + "/yard.json", "not json\n");

        yield* runInit(dir, {
          script: ["dev"],
          target: Option.some("yard" as const),
          yes: false,
          force: true,
        });

        assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(dir + "/yard.json")), {
          dev: "npm run dev",
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("errors on missing package.json (no prompts)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const err = yield* runInit(dir, {
          script: [],
          target: Option.none(),
          yes: true,
          force: false,
        }).pipe(Effect.flip);
        assert(err instanceof InitError);
        assert.match(err.message, /No package.json found/);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("errors on unknown --script (no prompts)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(
          dir + "/package.json",
          JSON.stringify({ scripts: { dev: "x" } }) + "\n",
        );
        const err = yield* runInit(dir, {
          script: ["dev:ghost"],
          target: Option.none(),
          yes: false,
          force: false,
        }).pipe(Effect.flip);
        assert(err instanceof InitError);
        assert.match(err.message, /Unknown script/);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("errors when no dev or dev:* scripts (no prompts)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(
          dir + "/package.json",
          JSON.stringify({ scripts: { build: "tsc" } }) + "\n",
        );
        const err = yield* runInit(dir, {
          script: [],
          target: Option.none(),
          yes: true,
          force: false,
        }).pipe(Effect.flip);
        assert(err instanceof InitError);
        assert.match(err.message, /No "dev" or "dev:\*"/);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
