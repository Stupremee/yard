import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import pkg from "../package.json" with { type: "json" };

const yard = Command.make("yard", {}, () => Console.log("Hello from yard!")).pipe(
  Command.withDescription("Manage AI-assisted development environments"),
);

Command.run(yard, { version: pkg.version }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
