import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { delete as deleteRequest } from "effect/unstable/http/HttpClientRequest";
import { FetchHttpClient } from "effect/unstable/http";
import { CloudflareDnsError } from "../domain/errors.ts";

export type DeleteHostnameResult = "deleted" | "not-found" | "skipped-no-token";

const baseUrl = "https://api.cloudflare.com/client/v4";

const ZoneResponse = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.Array(Schema.Unknown).pipe(Schema.optional),
  result: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});

const DnsRecordsResponse = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.Array(Schema.Unknown).pipe(Schema.optional),
  result: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      content: Schema.String,
      type: Schema.String,
    }),
  ),
});

const DeleteResponse = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.Array(Schema.Unknown).pipe(Schema.optional),
});

type ApiResponse = {
  readonly success: boolean;
  readonly errors?: ReadonlyArray<unknown>;
};

const apiErrorMessage = (body: { readonly errors?: ReadonlyArray<unknown> }) =>
  body.errors === undefined || body.errors.length === 0
    ? "Cloudflare API request failed"
    : body.errors.map((error) => JSON.stringify(error)).join("; ");

const dnsError = (hostname: string, operation: string, error: unknown) =>
  new CloudflareDnsError({
    hostname,
    operation,
    message: error instanceof Error ? error.message : String(error),
  });

const apiRequest = Effect.fn("CloudflareDns.apiRequest")(function* <A>(
  http: HttpClient.HttpClient,
  token: string,
  hostname: string,
  operation: string,
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Codec<A, unknown, never, never>,
) {
  const response = yield* request.pipe(
    HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
    http.execute,
    Effect.mapError((error) => dnsError(hostname, operation, error)),
  );
  const decoded = yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
    Effect.mapError((error) => dnsError(hostname, operation, error)),
  );
  const apiResponse = decoded as ApiResponse;
  if (response.status < 200 || response.status >= 300 || apiResponse.success !== true) {
    return yield* new CloudflareDnsError({
      hostname,
      operation,
      message: apiErrorMessage(apiResponse),
    });
  }
  return decoded;
});

export class CloudflareDns extends Context.Service<
  CloudflareDns,
  {
    readonly deleteHostname: (options: {
      readonly zone: string;
      readonly tunnelId: string;
      readonly hostname: string;
    }) => Effect.Effect<DeleteHostnameResult, CloudflareDnsError>;
  }
>()("yard/services/CloudflareDns") {
  static readonly layer = Layer.effect(
    CloudflareDns,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;

      return {
        deleteHostname: Effect.fn("CloudflareDns.deleteHostname")(function* (options) {
          const token = process.env.CLOUDFLARE_API_TOKEN;
          if (token === undefined || token.trim().length === 0) {
            return "skipped-no-token" as const;
          }

          const zoneUrl = `${baseUrl}/zones?name=${encodeURIComponent(options.zone)}`;
          const zoneResponse = yield* apiRequest(
            http,
            token,
            options.hostname,
            "lookup-zone",
            HttpClientRequest.get(zoneUrl),
            ZoneResponse,
          );
          const zoneId = zoneResponse.result.find((zone) => zone.name === options.zone)?.id;
          if (zoneId === undefined) {
            return yield* new CloudflareDnsError({
              hostname: options.hostname,
              operation: "lookup-zone",
              message: `Cloudflare zone not found: ${options.zone}`,
            });
          }

          const recordsUrl = `${baseUrl}/zones/${encodeURIComponent(zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(options.hostname)}`;
          const recordsResponse = yield* apiRequest(
            http,
            token,
            options.hostname,
            "list-records",
            HttpClientRequest.get(recordsUrl),
            DnsRecordsResponse,
          );
          const expectedContent = `${options.tunnelId}.cfargotunnel.com`;
          const matching = recordsResponse.result.filter(
            (record) => record.type === "CNAME" && record.content === expectedContent,
          );
          if (matching.length === 0) {
            return "not-found" as const;
          }

          for (const record of matching) {
            const deleteUrl = `${baseUrl}/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(record.id)}`;
            yield* apiRequest(
              http,
              token,
              options.hostname,
              "delete-record",
              deleteRequest(deleteUrl),
              DeleteResponse,
            );
          }
          return "deleted" as const;
        }),
      };
    }),
  );

  static readonly liveLayer = CloudflareDns.layer.pipe(Layer.provide(FetchHttpClient.layer));
}
