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

const homeDir = () => process.env.HOME ?? "/tmp";

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
            const configHome = process.env.XDG_CONFIG_HOME ?? path.join(homeDir(), ".config");
            const stateHome = process.env.XDG_STATE_HOME ?? path.join(homeDir(), ".local", "state");
            const dataHome = process.env.XDG_DATA_HOME ?? path.join(homeDir(), ".local", "share");
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
