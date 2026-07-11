import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import { resolveDevTasks, resolveStackName } from "./config.ts";

const ChildState = Schema.Struct({
  pid: Schema.Int,
  label: Schema.String,
  command: Schema.String,
});
type ChildState = typeof ChildState.Type;
const DevState = Schema.Struct({
  cwd: Schema.String,
  pid: Schema.Int,
  startedAt: Schema.String,
  children: Schema.Array(ChildState),
});
type DevState = typeof DevState.Type;
const DevStateJson = Schema.fromJsonString(DevState);
class DevTaskExitError extends Data.TaggedError("DevTaskExitError")<{ readonly code: number }> {}

const tempRoot = Effect.gen(function* () {
  const path = yield* Path.Path;
  const tmp = yield* Config.string("TMPDIR").pipe(Config.withDefault("/tmp"));
  return path.join(tmp, "yard");
});
const paths = Effect.fn("dev.paths")(function* (name: string) {
  const path = yield* Path.Path;
  const root = yield* tempRoot;
  const dir = path.join(root, name);
  return { root, dir, lock: path.join(dir, "lock"), state: path.join(dir, "state.json") };
});
const readState = Effect.fn("dev.readState")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeEffect(DevStateJson)),
    Effect.option,
    Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
  );
});
const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const killGroup = (pid: number, signal: NodeJS.Signals) =>
  Effect.sync(() => {
    if (!alive(pid)) return;
    try {
      process.kill(-pid, signal);
    } catch (error: unknown) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")
      )
        throw error;
    }
  });
const stopChildren = (children: ReadonlyArray<ChildState>) =>
  Effect.gen(function* () {
    yield* Effect.forEach(children, (child) => killGroup(child.pid, "SIGTERM"), { discard: true });
    yield* Effect.sleep("1500 millis");
    yield* Effect.forEach(children, (child) => killGroup(child.pid, "SIGKILL"), { discard: true });
  });
const withLock = Effect.fn("dev.withLock")(function* <A, E, R>(
  name: string,
  body: Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const location = yield* paths(name);
  yield* fs.makeDirectory(location.dir, { recursive: true });
  const start = yield* DateTime.now;
  const acquire = Effect.gen(function* () {
    while (true) {
      const made = yield* fs.makeDirectory(location.lock).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (made) return;
      const now = yield* DateTime.now;
      if (DateTime.toEpochMillis(now) - DateTime.toEpochMillis(start) > 10_000)
        yield* fs.remove(location.lock, { recursive: true, force: true });
      else yield* Effect.sleep("100 millis");
    }
  });
  return yield* Effect.acquireUseRelease(
    acquire,
    () => body,
    () => fs.remove(location.lock, { recursive: true, force: true }).pipe(Effect.ignore),
  );
});

const output = (
  label: string,
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  error: boolean,
) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      error ? Console.error(`[${label}] ${line}`) : Console.log(`[${label}] ${line}`),
    ),
    Effect.ignore,
  );

export const runDev = Effect.fn("dev.run")(function* (cwd: string, override?: string) {
  const fs = yield* FileSystem.FileSystem;
  const name = yield* resolveStackName(cwd, override);
  const tasks = yield* resolveDevTasks(cwd);
  const location = yield* paths(name);
  const children = yield* withLock(
    name,
    Effect.gen(function* () {
      const previous = yield* readState(location.state);
      if (previous?.children.length) {
        yield* Console.log(`Stopping existing ${name} dev stack from ${previous.cwd}...`);
        yield* stopChildren(previous.children);
      }
      const handles = yield* Effect.forEach(tasks, (task) =>
        ChildProcess.make(task.command, {
          cwd,
          shell: true,
          detached: true,
          stdin: "inherit",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const now = yield* DateTime.now;
      const state: DevState = {
        cwd,
        pid: process.pid,
        startedAt: DateTime.formatIso(now),
        children: handles.map((handle, index) => ({
          pid: handle.pid,
          label: tasks[index]?.label ?? "dev",
          command: tasks[index]?.command ?? "",
        })),
      };
      yield* fs.writeFileString(location.state, yield* Schema.encodeEffect(DevStateJson)(state));
      return handles;
    }),
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Effect.forEach(children, (child) => killGroup(child.pid, "SIGTERM"), {
        discard: true,
      });
      const state = yield* readState(location.state);
      if (state?.pid === process.pid)
        yield* fs.remove(location.state, { force: true }).pipe(Effect.ignore);
    }),
  );
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    const label = tasks[index]?.label ?? "dev";
    yield* Effect.forkScoped(output(label, child.stdout, false));
    yield* Effect.forkScoped(output(label, child.stderr, true));
  }
  const code = yield* Effect.raceAll(
    children.map((child) =>
      child.exitCode.pipe(
        Effect.map(Number),
        Effect.orElseSucceed(() => 1),
      ),
    ),
  );
  if (code !== 0) return yield* new DevTaskExitError({ code });
});

export const stopDev = Effect.fn("dev.stop")(function* (cwd: string, override?: string) {
  const fs = yield* FileSystem.FileSystem;
  const name = yield* resolveStackName(cwd, override);
  const location = yield* paths(name);
  yield* withLock(
    name,
    Effect.gen(function* () {
      const state = yield* readState(location.state);
      if (!state?.children.length) yield* Console.log(`no running stack named ${name}`);
      else {
        yield* Console.log(`Stopping ${name} dev stack from ${state.cwd}...`);
        yield* stopChildren(state.children);
      }
      yield* fs.remove(location.state, { force: true }).pipe(Effect.ignore);
    }),
  );
});

export const statusDev = Effect.fn("dev.status")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const location = yield* paths("");
  const names = yield* fs.readDirectory(location.root).pipe(Effect.orElseSucceed(() => []));
  const now = yield* DateTime.now;
  const rows: Array<string> = [];
  for (const name of names) {
    const item = yield* paths(name);
    const state = yield* readState(item.state);
    if (!state) continue;
    const states = state.children.map((child) => ({ ...child, alive: alive(child.pid) }));
    if (states.every((child) => !child.alive)) {
      yield* fs.remove(item.state, { force: true }).pipe(Effect.ignore);
      continue;
    }
    const started = DateTime.makeUnsafe(state.startedAt);
    const seconds = Math.max(
      0,
      Math.floor((DateTime.toEpochMillis(now) - DateTime.toEpochMillis(started)) / 1_000),
    );
    rows.push(
      `${name}\t${state.cwd}\t${state.startedAt} (${seconds}s)\t${states.map((child) => `${child.label}:${child.pid}:${child.alive ? "alive" : "dead"}`).join(", ")}`,
    );
  }
  if (rows.length === 0) yield* Console.log("no running dev stacks");
  else {
    yield* Console.log("NAME\tCWD\tSTARTED / UPTIME\tTASKS");
    yield* Effect.forEach(rows, (row) => Console.log(row), { discard: true });
  }
});
