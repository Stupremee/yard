import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

export class ProcessSpec extends Schema.Class<ProcessSpec>("ProcessSpec")({
  command: Schema.String,
  route: Schema.optional(Schema.Boolean),
}) {}

export class RouteSpec extends Schema.Class<RouteSpec>("RouteSpec")({
  process: Schema.String,
  portEnv: Schema.String,
  urlEnv: Schema.optional(Schema.String),
}) {}

export class EnvSpec extends Schema.Class<EnvSpec>("EnvSpec")({
  link: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([".env"])),
    Schema.withConstructorDefault(Effect.succeed([".env"])),
  ),
  copyOnce: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([".env.local"])),
    Schema.withConstructorDefault(Effect.succeed([".env.local"])),
  ),
}) {}

export class RepoConfig extends Schema.Class<RepoConfig>("RepoConfig")({
  processes: Schema.Record(Schema.String, ProcessSpec).pipe(
    Schema.withDecodingDefault(
      Effect.succeed({ web: new ProcessSpec({ command: "vp run dev", route: true }) }),
    ),
    Schema.withConstructorDefault(
      Effect.succeed({ web: new ProcessSpec({ command: "vp run dev", route: true }) }),
    ),
  ),
  routes: Schema.Record(Schema.String, RouteSpec).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
    Schema.withConstructorDefault(Effect.succeed({})),
  ),
  env: EnvSpec.pipe(
    Schema.withDecodingDefault(Effect.succeed(new EnvSpec({}))),
    Schema.withConstructorDefault(Effect.succeed(new EnvSpec({}))),
  ),
}) {}

export class TunnelConfig extends Schema.Class<TunnelConfig>("TunnelConfig")({
  name: Schema.String,
  id: Schema.String,
  credentialsFile: Schema.String,
}) {}

export class BinariesConfig extends Schema.Class<BinariesConfig>("BinariesConfig")({
  caddy: Schema.String,
  cloudflared: Schema.String,
}) {}

export class AuthConfig extends Schema.Class<AuthConfig>("AuthConfig")({
  mode: Schema.Literals(["public", "access"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("public" as const)),
    Schema.withConstructorDefault(Effect.succeed("public" as const)),
  ),
  teamDomain: Schema.optional(Schema.String),
  serviceToken: Schema.optional(Schema.String),
}) {}

export class GlobalConfig extends Schema.Class<GlobalConfig>("GlobalConfig")({
  version: Schema.Literal(1),
  zone: Schema.String,
  caddyHttpPort: Schema.Finite.pipe(
    Schema.withDecodingDefault(Effect.succeed(8600)),
    Schema.withConstructorDefault(Effect.succeed(8600)),
  ),
  caddyAdminPort: Schema.Finite.pipe(
    Schema.withDecodingDefault(Effect.succeed(2019)),
    Schema.withConstructorDefault(Effect.succeed(2019)),
  ),
  portRange: Schema.Tuple([Schema.Finite, Schema.Finite]).pipe(
    Schema.withDecodingDefault(Effect.succeed([3100, 3999] as const)),
    Schema.withConstructorDefault(Effect.succeed([3100, 3999] as const)),
  ),
  tunnel: TunnelConfig,
  binaries: BinariesConfig.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(new BinariesConfig({ caddy: "auto", cloudflared: "auto" })),
    ),
    Schema.withConstructorDefault(
      Effect.succeed(new BinariesConfig({ caddy: "auto", cloudflared: "auto" })),
    ),
  ),
  auth: AuthConfig.pipe(
    Schema.withDecodingDefault(Effect.succeed(new AuthConfig({}))),
    Schema.withConstructorDefault(Effect.succeed(new AuthConfig({}))),
  ),
}) {}

export class Instance extends Schema.Class<Instance>("Instance")({
  repoName: Schema.String,
  word: Schema.NullOr(Schema.String),
  worktreeRoot: Schema.String,
  primaryRoot: Schema.String,
  ports: Schema.Record(Schema.String, Schema.Finite),
  processes: Schema.Array(Schema.String),
  routedProcess: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed("web")),
    Schema.withConstructorDefault(Effect.succeed("web")),
  ),
  visibility: Schema.Literals(["protected", "public"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("public" as const)),
    Schema.withConstructorDefault(Effect.succeed("public" as const)),
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) {}

export class InstancesFile extends Schema.Class<InstancesFile>("InstancesFile")({
  version: Schema.Literal(1),
  instances: Schema.Record(Schema.String, Instance).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
    Schema.withConstructorDefault(Effect.succeed({})),
  ),
}) {}

export const emptyInstancesFile = () => new InstancesFile({ version: 1, instances: {} });
