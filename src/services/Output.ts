import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

type OutputInput = {
  readonly json: unknown;
  readonly human: string | ReadonlyArray<string>;
};

const lines = (input: string | ReadonlyArray<string>) => (Array.isArray(input) ? input : [input]);

const write = (stream: NodeJS.WriteStream, value: string) =>
  Effect.sync(() => {
    stream.write(value.endsWith("\n") ? value : `${value}\n`);
  });

export class Output extends Context.Service<
  Output,
  {
    readonly emit: (input: OutputInput) => Effect.Effect<void>;
    readonly emitError: (input: OutputInput) => Effect.Effect<void>;
    readonly isJson: () => Effect.Effect<boolean>;
  }
>()("yard/services/Output") {
  static layer(json: boolean): Layer.Layer<Output> {
    return Layer.succeed(Output, {
      emit: Effect.fn("Output.emit")((input) =>
        write(
          process.stdout,
          json ? JSON.stringify(input.json, null, 2) : lines(input.human).join("\n"),
        ),
      ),
      emitError: Effect.fn("Output.emitError")((input) =>
        write(
          process.stderr,
          json ? JSON.stringify(input.json, null, 2) : lines(input.human).join("\n"),
        ),
      ),
      isJson: Effect.fn("Output.isJson")(() => Effect.succeed(json)),
    });
  }
}
