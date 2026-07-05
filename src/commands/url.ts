import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import { ConfigInvalid } from "../domain/errors.ts";
import { primaryHostname, routeHostname } from "../domain/slug.ts";
import { Output } from "../services/Output.ts";
import { StateStore } from "../services/StateStore.ts";
import { lookupInstance, resolveContext } from "./context.ts";

export type UrlInfo = {
  readonly slug: string;
  readonly route: string | null;
  readonly url: string;
  readonly authHeaders: Record<string, string>;
};

export const composeUrlInfo = (slug: string, zone: string, route?: string): UrlInfo => ({
  slug,
  route: route ?? null,
  url: `https://${route === undefined ? primaryHostname(slug, zone) : routeHostname(slug, route, zone)}`,
  authHeaders: {},
});

export const urlCommand = Command.make(
  "url",
  {
    route: Flag.string("route").pipe(Flag.optional),
  },
  Effect.fn("commands.url")(function* ({ route }) {
    const context = yield* resolveContext();
    const instance = yield* lookupInstance(context.slug);
    const store = yield* StateStore;
    const output = yield* Output;
    const config = yield* store.loadGlobalConfig();
    const routeName = Option.getOrUndefined(route);
    // Valid --route values are the instance's extra routes; the routed process is
    // served at the primary hostname (no --route needed).
    if (
      routeName !== undefined &&
      (!Object.hasOwn(instance.ports, routeName) || routeName === instance.routedProcess)
    ) {
      const available = Object.keys(instance.ports)
        .filter((name) => name !== instance.routedProcess)
        .sort((left, right) => left.localeCompare(right));
      return yield* new ConfigInvalid({
        path: "--route",
        error: new Error(
          `Unknown route "${routeName}" for ${context.slug}; available routes: ${
            available.length === 0 ? "none" : available.join(", ")
          }`,
        ),
      });
    }
    const info = composeUrlInfo(context.slug, config.zone, routeName);
    yield* output.emit({ json: info, human: info.url });
  }),
).pipe(Command.withDescription("Print the public URL for the current yard instance"));
