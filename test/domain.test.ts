import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  appUnitInstanceName,
  composeInstanceSlug,
  routeHostname,
  slugifyRepoName,
} from "../src/domain/slug.js";
import { pickWord, WORDS } from "../src/domain/wordlist.js";
import { GlobalConfig, Instance, InstancesFile, RepoConfig } from "../src/domain/model.js";

describe("slug", () => {
  it("slugifies repo names and composes hosts", () => {
    expect(slugifyRepoName("My Cool_App!!")).toBe("my-cool-app");
    expect(slugifyRepoName("---")).toBe("repo");
    expect(composeInstanceSlug("Werkwacht", null)).toBe("werkwacht");
    expect(composeInstanceSlug("Werkwacht", "komet")).toBe("werkwacht-komet");
    expect(routeHostname("werkwacht-komet", "convex-site", "example.de")).toBe(
      "werkwacht-komet-convex-site.example.de",
    );
  });

  it("escapes systemd app unit instance names", () => {
    expect(appUnitInstanceName("repo/name", "web dev")).toBe("repo-name--web-dev");
  });
});

describe("wordlist", () => {
  it("contains many safe short lowercase words", () => {
    expect(WORDS.length).toBeGreaterThanOrEqual(900);
    expect(WORDS.every((word) => /^[a-z]{3,8}$/.test(word))).toBe(true);
    expect(new Set(WORDS).size).toBe(WORDS.length);
  });

  it.effect("retries collisions", () =>
    Effect.gen(function* () {
      const first = WORDS[0]!;
      const second = WORDS[1]!;
      const picked = yield* pickWord((word) => word === first);
      expect(picked).toBe(second);
    }),
  );
});

describe("schemas", () => {
  it.effect("decodes defaults and round-trips repo config", () =>
    Effect.gen(function* () {
      const config = yield* Schema.decodeUnknownEffect(RepoConfig)({});
      expect(config.env.link).toEqual([".env"]);
      expect(config.env.copyOnce).toEqual([".env.local"]);
      expect(config.processes.web?.route).toBe(true);
      const encoded = yield* Schema.encodeUnknownEffect(RepoConfig)(config);
      const decoded = yield* Schema.decodeUnknownEffect(RepoConfig)(encoded);
      expect(decoded).toEqual(config);
    }),
  );

  it.effect("round-trips global and instances file formats", () =>
    Effect.gen(function* () {
      const global = new GlobalConfig({
        version: 1,
        zone: "example.de",
        tunnel: { name: "yard", id: "uuid", credentialsFile: "~/.local/state/yard/tunnel.json" },
      });
      const instance = new Instance({
        repoName: "yard",
        word: null,
        worktreeRoot: "/srv/dev/yard",
        primaryRoot: "/srv/dev/yard",
        ports: { web: 3100 },
        processes: ["web"],
        createdAt: "2026-07-04T00:00:00.000Z",
        updatedAt: "2026-07-04T00:00:00.000Z",
      });
      const state = new InstancesFile({ version: 1, instances: { yard: instance } });
      expect(
        (yield* Schema.decodeUnknownEffect(GlobalConfig)(
          yield* Schema.encodeUnknownEffect(GlobalConfig)(global),
        )).auth.mode,
      ).toBe("public");
      expect(
        (yield* Schema.decodeUnknownEffect(InstancesFile)(
          yield* Schema.encodeUnknownEffect(InstancesFile)(state),
        )).instances.yard?.visibility,
      ).toBe("public");
    }),
  );
});
