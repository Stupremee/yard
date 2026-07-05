import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { EnvLinker } from "../src/services/EnvLinker.ts";

const testLayer = EnvLinker.layer.pipe(Layer.provide(NodeServices.layer));

const withRoots = <A, E, R>(
  effect: (roots: { readonly primary: string; readonly linked: string }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped();
    const primary = path.join(dir, "primary");
    const linked = path.join(dir, "linked");
    yield* fs.makeDirectory(primary);
    yield* fs.makeDirectory(linked);
    return yield* effect({ primary, linked });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("EnvLinker", () => {
  it.effect("is a no-op for primary worktrees", () =>
    withRoots(({ primary }) =>
      Effect.gen(function* () {
        const linker = yield* EnvLinker;
        expect(
          yield* linker.linkForWorktree({ primaryRoot: primary, worktreeRoot: primary }),
        ).toEqual([{ type: "primary-noop" }]);
      }).pipe(Effect.provide(testLayer)),
    ),
  );

  it.effect("backs up a wrong regular file and links env files idempotently", () =>
    withRoots(({ primary, linked }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${primary}/.env`, "PRIMARY=1\n");
        yield* fs.writeFileString(`${linked}/.env`, "WRONG=1\n");

        const linker = yield* EnvLinker;
        const first = yield* linker.linkForWorktree({ primaryRoot: primary, worktreeRoot: linked });
        expect(first.map((action) => action.type)).toEqual([
          "backed-up",
          "linked",
          "missing-source",
        ]);
        expect(yield* fs.readFileString(`${linked}/.env.yard-backup`)).toBe("WRONG=1\n");
        expect(yield* fs.readLink(`${linked}/.env`)).toBe(`${primary}/.env`);

        const second = yield* linker.linkForWorktree({
          primaryRoot: primary,
          worktreeRoot: linked,
        });
        expect(second.map((action) => action.type)).toEqual(["already-linked", "missing-source"]);
        expect(yield* fs.readLink(`${linked}/.env`)).toBe(`${primary}/.env`);
      }).pipe(Effect.provide(testLayer)),
    ),
  );

  it.effect("copies copyOnce files only when missing", () =>
    withRoots(({ primary, linked }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${primary}/.env`, "PRIMARY=1\n");
        yield* fs.writeFileString(`${primary}/.env.local`, "SECRET=primary\n");
        yield* fs.writeFileString(`${linked}/.env.local`, "SECRET=linked\n");

        const linker = yield* EnvLinker;
        const actions = yield* linker.linkForWorktree({
          primaryRoot: primary,
          worktreeRoot: linked,
        });

        expect(actions.map((action) => action.type)).toEqual(["linked", "already-exists"]);
        expect(yield* fs.readFileString(`${linked}/.env.local`)).toBe("SECRET=linked\n");
      }).pipe(Effect.provide(testLayer)),
    ),
  );

  it.effect("skips missing sources and copies present copyOnce files", () =>
    withRoots(({ primary, linked }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${primary}/.env.local`, "LOCAL=1\n");

        const linker = yield* EnvLinker;
        const actions = yield* linker.linkForWorktree({
          primaryRoot: primary,
          worktreeRoot: linked,
        });

        expect(actions.map((action) => action.type)).toEqual(["missing-source", "copied"]);
        expect(yield* fs.exists(`${linked}/.env`)).toBe(false);
        expect(yield* fs.readFileString(`${linked}/.env.local`)).toBe("LOCAL=1\n");
      }).pipe(Effect.provide(testLayer)),
    ),
  );
});
