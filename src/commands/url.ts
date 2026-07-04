import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import { primaryHostname, routeHostname } from "../domain/slug.js";
import { Output } from "../services/Output.js";
import { StateStore } from "../services/StateStore.js";
import { lookupInstance, resolveContext } from "./context.js";

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
    yield* lookupInstance(context.slug);
    const store = yield* StateStore;
    const output = yield* Output;
    const config = yield* store.loadGlobalConfig();
    const routeName = Option.getOrUndefined(route);
    const info = composeUrlInfo(context.slug, config.zone, routeName);
    yield* output.emit({ json: info, human: info.url });
  }),
).pipe(Command.withDescription("Print the public URL for the current yard instance"));
