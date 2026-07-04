import { createServer } from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { NoFreePort } from "../domain/errors.js";
import { StateStore } from "./StateStore.js";

type AllocateOptions = {
  readonly override?: number;
  readonly range?: readonly [number, number];
};

const canBind = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const server = createServer();
    const cleanup = () => {
      server.removeAllListeners();
    };
    server.once("error", () => {
      cleanup();
      resume(Effect.succeed(false));
    });
    server.once("listening", () => {
      server.close(() => {
        cleanup();
        resume(Effect.succeed(true));
      });
    });
    server.listen(port, "127.0.0.1");
  });

export class Ports extends Context.Service<
  Ports,
  {
    readonly isUsable: (port: number) => Effect.Effect<boolean>;
    readonly allocate: (
      instanceSlug: string,
      routeName: string,
      options?: AllocateOptions,
    ) => Effect.Effect<number, NoFreePort>;
  }
>()("yard/services/Ports") {
  static readonly layer = Layer.effect(
    Ports,
    Effect.gen(function* () {
      const stateStore = yield* StateStore;
      return {
        isUsable: Effect.fn("Ports.isUsable")(function* (port: number) {
          return yield* canBind(port);
        }),
        allocate: Effect.fn("Ports.allocate")(function* (
          instanceSlug: string,
          routeName: string,
          options: AllocateOptions = {},
        ) {
          const range =
            options.range ??
            (yield* stateStore.loadGlobalConfig().pipe(
              Effect.map((config) => config.portRange),
              Effect.orDie,
            ));
          const [from, to] = range;
          if (options.override !== undefined) {
            if (
              options.override < from ||
              options.override > to ||
              !(yield* canBind(options.override))
            ) {
              return yield* new NoFreePort({ from, to });
            }
            return options.override;
          }

          const state = yield* stateStore.loadInstances().pipe(Effect.orDie);
          const instance = state.instances[instanceSlug];
          const existing = instance?.ports[routeName];
          if (
            existing !== undefined &&
            existing >= from &&
            existing <= to &&
            (yield* canBind(existing))
          ) {
            return existing;
          }

          const recorded = new Set<number>();
          for (const other of Object.values(state.instances)) {
            for (const port of Object.values(other.ports)) {
              recorded.add(port);
            }
          }

          for (let port = from; port <= to; port += 1) {
            if (recorded.has(port)) continue;
            if (yield* canBind(port)) return port;
          }
          return yield* new NoFreePort({ from, to });
        }),
      };
    }),
  );
}
