import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { CloudflareDnsError } from "../src/domain/errors.ts";
import { CloudflareDns } from "../src/services/CloudflareDns.ts";

const makeHttpClient = (
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
) =>
  HttpClient.makeWith(
    Effect.fnUntraced(function* (requestEffect) {
      const request = yield* requestEffect;
      return yield* handler(request);
    }),
    Effect.succeed as HttpClient.HttpClient.Preprocess<HttpClientError.HttpClientError, never>,
  );

const jsonResponse = (request: HttpClientRequest.HttpClientRequest, body: unknown, status = 200) =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const withToken = <A, E, R>(effect: Effect.Effect<A, E, R>, token: string | undefined) =>
  Effect.gen(function* () {
    const previous = process.env.CLOUDFLARE_API_TOKEN;
    if (token === undefined) {
      delete process.env.CLOUDFLARE_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_API_TOKEN = token;
    }
    return yield* effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previous === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
          else process.env.CLOUDFLARE_API_TOKEN = previous;
        }),
      ),
    );
  });

const layerWithRequests = (requests: Array<{ readonly method: string; readonly url: string }>) =>
  CloudflareDns.layer.pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        makeHttpClient((request) => {
          requests.push({ method: request.method, url: request.url });
          if (request.url.endsWith("/zones?name=example.test")) {
            return Effect.succeed(
              jsonResponse(request, {
                success: true,
                result: [{ id: "zone-1", name: "example.test" }],
              }),
            );
          }
          if (request.url.endsWith("/zones/zone-1/dns_records?type=CNAME&name=app.example.test")) {
            return Effect.succeed(
              jsonResponse(request, {
                success: true,
                result: [
                  {
                    id: "owned",
                    name: "app.example.test",
                    type: "CNAME",
                    content: "tunnel-id.cfargotunnel.com",
                  },
                  {
                    id: "user-owned",
                    name: "app.example.test",
                    type: "CNAME",
                    content: "elsewhere.example.test",
                  },
                ],
              }),
            );
          }
          if (request.url.endsWith("/zones/zone-1/dns_records/owned")) {
            return Effect.succeed(jsonResponse(request, { success: true }));
          }
          return Effect.succeed(
            jsonResponse(request, { success: false, errors: ["unexpected"] }, 500),
          );
        }),
      ),
    ),
  );

describe("CloudflareDns", () => {
  it.effect("deletes only CNAME records owned by the tunnel", () => {
    const requests: Array<{ readonly method: string; readonly url: string }> = [];
    return withToken(
      Effect.gen(function* () {
        const dns = yield* CloudflareDns;
        const result = yield* dns.deleteHostname({
          zone: "example.test",
          tunnelId: "tunnel-id",
          hostname: "app.example.test",
        });
        expect(result).toBe("deleted");
        expect(requests.map((request) => request.url)).toEqual([
          "https://api.cloudflare.com/client/v4/zones?name=example.test",
          "https://api.cloudflare.com/client/v4/zones/zone-1/dns_records?type=CNAME&name=app.example.test",
          "https://api.cloudflare.com/client/v4/zones/zone-1/dns_records/owned",
        ]);
        expect(requests.at(-1)?.method).toBe("DELETE");
      }).pipe(Effect.provide(layerWithRequests(requests))),
      "secret",
    );
  });

  it.effect("returns not-found when no tunnel-owned record matches", () => {
    const layer = CloudflareDns.layer.pipe(
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          makeHttpClient((request) => {
            if (request.url.endsWith("/zones?name=example.test")) {
              return Effect.succeed(
                jsonResponse(request, {
                  success: true,
                  result: [{ id: "zone-1", name: "example.test" }],
                }),
              );
            }
            return Effect.succeed(
              jsonResponse(request, {
                success: true,
                result: [
                  {
                    id: "other",
                    name: "app.example.test",
                    type: "CNAME",
                    content: "other.cfargotunnel.com",
                  },
                ],
              }),
            );
          }),
        ),
      ),
    );
    return withToken(
      Effect.gen(function* () {
        const dns = yield* CloudflareDns;
        expect(
          yield* dns.deleteHostname({
            zone: "example.test",
            tunnelId: "tunnel-id",
            hostname: "app.example.test",
          }),
        ).toBe("not-found");
      }).pipe(Effect.provide(layer)),
      "secret",
    );
  });

  it.effect("skips cleanup without an API token", () =>
    withToken(
      Effect.gen(function* () {
        const dns = yield* CloudflareDns;
        expect(
          yield* dns.deleteHostname({
            zone: "example.test",
            tunnelId: "tunnel-id",
            hostname: "app.example.test",
          }),
        ).toBe("skipped-no-token");
      }).pipe(Effect.provide(layerWithRequests([]))),
      undefined,
    ),
  );

  it.effect("maps API failures to CloudflareDnsError", () => {
    const layer = CloudflareDns.layer.pipe(
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          makeHttpClient((request) =>
            Effect.succeed(jsonResponse(request, { success: false, errors: ["bad"] }, 500)),
          ),
        ),
      ),
    );
    return withToken(
      Effect.gen(function* () {
        const dns = yield* CloudflareDns;
        const error = yield* Effect.flip(
          dns.deleteHostname({
            zone: "example.test",
            tunnelId: "tunnel-id",
            hostname: "app.example.test",
          }),
        );
        expect(error).toBeInstanceOf(CloudflareDnsError);
        expect(error.hostname).toBe("app.example.test");
        expect(error.operation).toBe("lookup-zone");
      }).pipe(Effect.provide(layer)),
      "secret",
    );
  });
});
