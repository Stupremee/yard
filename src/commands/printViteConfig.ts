import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";
import { Output } from "../services/Output.js";

export const viteConfigSnippet = `// yard expects PORT and DEV_HOST to be set in the process environment.
// If either is missing, fail fast before exporting the config.
if (!process.env.PORT || !process.env.DEV_HOST) {
  throw new Error("yard requires PORT and DEV_HOST");
}

export default {
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT),
    strictPort: true,
    allowedHosts: [process.env.DEV_HOST],
    hmr: {
      protocol: "wss",
      host: process.env.DEV_HOST,
      clientPort: 443,
    },
  },
};`;

export const printViteConfigCommand = Command.make("print-vite-config", {}, () =>
  Effect.gen(function* () {
    const output = yield* Output;
    yield* output.emit({
      json: { snippet: viteConfigSnippet },
      human: viteConfigSnippet,
    });
  }),
).pipe(Command.withDescription("Print the Vite server configuration needed behind yard"));
