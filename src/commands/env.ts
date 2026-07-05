import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { EnvLinker } from "../services/EnvLinker.ts";
import type { EnvLinkerAction } from "../services/EnvLinker.ts";
import { Output } from "../services/Output.ts";
import { RepoConfig } from "../services/RepoConfig.ts";
import { lookupInstance, resolveContext } from "./context.ts";

const formatAction = (action: EnvLinkerAction): string => {
  switch (action.type) {
    case "primary-noop":
      return "primary worktree: no env links needed";
    case "linked":
      return `linked ${action.path} -> ${action.source}`;
    case "already-linked":
      return `already linked ${action.path} -> ${action.source}`;
    case "backed-up":
      return `backed up ${action.path} -> ${action.backup}`;
    case "copied":
      return `copied ${action.source} -> ${action.path}`;
    case "already-exists":
      return `already exists ${action.path}`;
    case "missing-source":
      return `missing source ${action.source}`;
  }
};

const envLinkCommand = Command.make(
  "link",
  {},
  Effect.fn("commands.env.link")(function* () {
    const context = yield* resolveContext();
    yield* lookupInstance(context.slug);
    const repoConfig = yield* RepoConfig;
    const linker = yield* EnvLinker;
    const output = yield* Output;
    const config = yield* repoConfig.resolve(context.worktreeRoot);
    const actions = yield* linker.linkForWorktree({
      worktreeRoot: context.worktreeRoot,
      primaryRoot: context.primaryRoot,
      env: config.env,
    });
    yield* output.emit({
      json: { slug: context.slug, actions },
      human: actions.map(formatAction),
    });
  }),
).pipe(Command.withDescription("Link configured env files for the current worktree"));

export const envCommand = Command.make("env").pipe(
  Command.withDescription("Manage yard env files"),
  Command.withSubcommands([envLinkCommand]),
);
