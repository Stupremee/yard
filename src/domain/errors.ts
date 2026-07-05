import * as Schema from "effect/Schema";

export class NotAGitRepo extends Schema.TaggedErrorClass<NotAGitRepo>()("NotAGitRepo", {
  cwd: Schema.String,
  message: Schema.optional(Schema.String),
}) {}

export class NoFreePort extends Schema.TaggedErrorClass<NoFreePort>()("NoFreePort", {
  from: Schema.Finite,
  to: Schema.Finite,
}) {}

export class CaddyUnreachable extends Schema.TaggedErrorClass<CaddyUnreachable>()(
  "CaddyUnreachable",
  {
    url: Schema.String,
    error: Schema.Unknown,
  },
) {}

export class CloudflareDnsError extends Schema.TaggedErrorClass<CloudflareDnsError>()(
  "CloudflareDnsError",
  {
    hostname: Schema.String,
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export class TunnelNotConfigured extends Schema.TaggedErrorClass<TunnelNotConfigured>()(
  "TunnelNotConfigured",
  {
    message: Schema.String,
  },
) {}

export class BinaryUnavailable extends Schema.TaggedErrorClass<BinaryUnavailable>()(
  "BinaryUnavailable",
  {
    name: Schema.String,
    message: Schema.String,
    url: Schema.optional(Schema.String),
  },
) {}

export class StateLocked extends Schema.TaggedErrorClass<StateLocked>()("StateLocked", {
  path: Schema.String,
  pid: Schema.optional(Schema.Finite),
}) {}

export class ConfigInvalid extends Schema.TaggedErrorClass<ConfigInvalid>()("ConfigInvalid", {
  path: Schema.String,
  error: Schema.Unknown,
}) {}

export class InstanceNotFound extends Schema.TaggedErrorClass<InstanceNotFound>()(
  "InstanceNotFound",
  {
    slug: Schema.String,
  },
) {}

export class NoInstanceForWorktree extends Schema.TaggedErrorClass<NoInstanceForWorktree>()(
  "NoInstanceForWorktree",
  {
    worktreeRoot: Schema.String,
  },
) {}

export class ProcessFailed extends Schema.TaggedErrorClass<ProcessFailed>()("ProcessFailed", {
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
  exitCode: Schema.Finite,
  stderr: Schema.String,
}) {}

export class FilesystemError extends Schema.TaggedErrorClass<FilesystemError>()("FilesystemError", {
  path: Schema.String,
  operation: Schema.String,
  error: Schema.Unknown,
}) {}

export class WordlistExhausted extends Schema.TaggedErrorClass<WordlistExhausted>()(
  "WordlistExhausted",
  {},
) {}
