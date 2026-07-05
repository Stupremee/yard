import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { Output } from "../services/Output.ts";
import { StateStore } from "../services/StateStore.ts";
import { formatInstanceStatus, loadInstanceStatus } from "./status.ts";

export const listCommand = Command.make(
  "list",
  {},
  Effect.fn("commands.list")(function* () {
    const store = yield* StateStore;
    const output = yield* Output;
    const state = yield* store.loadInstances();
    const instances = [];
    for (const [slug, instance] of Object.entries(state.instances).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      instances.push(yield* loadInstanceStatus(slug, instance));
    }
    const human =
      instances.length === 0
        ? "No yard instances found"
        : instances.flatMap((instance, index) => [
            ...(index === 0 ? [] : [""]),
            ...formatInstanceStatus(instance),
          ]);
    yield* output.emit({ json: { instances }, human });
  }),
).pipe(Command.withDescription("List all yard instances with live status"));
