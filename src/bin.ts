import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import pkg from "../package.json" with { type: "json" };
import { runDev, statusDev, stopDev } from "./dev/runner.ts";

const name = Flag.string("name").pipe(Flag.withAlias("n"), Flag.optional);
const stop = Command.make("stop", { name }, ({ name }) =>
  stopDev(process.cwd(), Option.getOrUndefined(name)),
);
const status = Command.make("status", {}, () => statusDev());
const dev = Command.make("dev", { name }, ({ name }) =>
  Effect.scoped(runDev(process.cwd(), Option.getOrUndefined(name))),
).pipe(
  Command.withDescription("Run a singleton development stack"),
  Command.withSubcommands([stop, status]),
);
const yard = Command.make("yard", {}, () =>
  Console.log("Use yard --help to see available commands."),
).pipe(
  Command.withDescription("Manage AI-assisted development environments"),
  Command.withSubcommands([dev]),
);

Command.run(yard, { version: pkg.version }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
