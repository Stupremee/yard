import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command, Flag } from "effect/unstable/cli";
import pkg from "../package.json" with { type: "json" };
import { runDev, statusDev, stopDev } from "./dev/runner.ts";
import { runInit } from "./dev/init.ts";

const name = Flag.string("name").pipe(Flag.withAlias("n"), Flag.optional);
const stop = Command.make("stop", { name }, ({ name }) =>
  stopDev(process.cwd(), Option.getOrUndefined(name)),
).pipe(Command.withDescription("Stop the running development stack"));
const status = Command.make("status", {}, () => statusDev()).pipe(
  Command.withDescription("List running development stacks"),
);
const dev = Command.make("dev", { name }, ({ name }) =>
  Effect.scoped(runDev(process.cwd(), Option.getOrUndefined(name))),
).pipe(Command.withDescription("Run a singleton development stack"));

const script = Flag.string("script").pipe(
  Flag.withAlias("s"),
  Flag.atLeast(0),
  Flag.withDescription("Dev script to include (repeatable); implies non-interactive mode"),
);
const target = Flag.choice("target", ["yard", "package"]).pipe(
  Flag.optional,
  Flag.withDescription('Where to write config: yard.json or the package.json "yard" key'),
);
const yes = Flag.boolean("yes").pipe(
  Flag.withAlias("y"),
  Flag.withDescription("Non-interactive: select all discovered dev scripts"),
);
const force = Flag.boolean("force").pipe(
  Flag.withAlias("f"),
  Flag.withDescription("Overwrite existing yard configuration"),
);
const init = Command.make("init", { script, target, yes, force }, (flags) =>
  runInit(process.cwd(), flags),
).pipe(Command.withDescription("Initialize yard configuration for this project"));

const yard = Command.make("yard", {}, () =>
  Console.log("Use yard --help to see available commands."),
).pipe(
  Command.withDescription("Manage AI-assisted development environments"),
  Command.withSubcommands([init, dev, stop, status]),
);

Command.run(yard, { version: pkg.version }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
