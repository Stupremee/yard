import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Path from "effect/Path";

export type XdgPaths = {
  readonly configFile: string;
  readonly configDir: string;
  readonly stateDir: string;
  readonly instancesFile: string;
  readonly lockFile: string;
  readonly shareBinDir: string;
};

const envOrDefault = (value: string | undefined, fallback: string): string =>
  value === undefined || value === "" ? fallback : value;

const homeDir = () => envOrDefault(process.env.HOME, "/tmp");

export class Xdg extends Context.Service<
  Xdg,
  {
    readonly paths: () => Effect.Effect<XdgPaths>;
  }
>()("yard/services/Xdg") {
  static readonly layer = Layer.effect(
    Xdg,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return {
        paths: Effect.fn("Xdg.paths")(() =>
          Effect.sync(() => {
            const home = homeDir();
            const configHome = envOrDefault(
              process.env.XDG_CONFIG_HOME,
              path.join(home, ".config"),
            );
            const stateHome = envOrDefault(
              process.env.XDG_STATE_HOME,
              path.join(home, ".local", "state"),
            );
            const dataHome = envOrDefault(
              process.env.XDG_DATA_HOME,
              path.join(home, ".local", "share"),
            );
            const configDir = path.join(configHome, "yard");
            const stateDir = path.join(stateHome, "yard");
            return {
              configDir,
              configFile: path.join(configDir, "config.json"),
              stateDir,
              instancesFile: path.join(stateDir, "instances.json"),
              lockFile: path.join(stateDir, "state.lock"),
              shareBinDir: path.join(dataHome, "yard", "bin"),
            };
          }),
        ),
      };
    }),
  );
}
