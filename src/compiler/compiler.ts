import type { Kernel, Task } from "../kernel/kernel";
import { FileSystem } from "../fs/filesystem";
import { inspectWasm, validateMemory, type WasmInfo } from "./wasm";
export class Compiler {
  status = "Compiler unloaded";
  progress = new Map<string, { loaded: number; total: number }>();
  diagnostics = "";
  lastCompileMs?: number;
  lastRunMs?: number;
  lastInfo?: WasmInfo;
  memoryPreview: Uint8Array = new Uint8Array();
  memoryBytes = 0;
  constructor(public kernel: Kernel) {}
  async compile(
    path: string,
    out: string,
    flags: string[] = [],
    parent = 1,
    signal?: AbortSignal,
  ) {
    if (
      flags.some(
        (f) =>
          !/^(-O[0-3sz]|-g|-Wall|-Wextra|-Werror|-std=c(89|99|11|17|2x|23)|-D[A-Za-z_]\w*(=.*)?)$/.test(
            f,
          ),
      )
    )
      throw Error(
        "Supported flags: -O0..3/-Os/-Oz, -g, -Wall, -Wextra, -Werror, -std=c11/c17/c23, -DNAME=value",
      );
    const source = this.kernel.fs.text(path);
    if (source.length > 256 * 1024) throw Error("source exceeds 256 KiB");
    return this.kernel
      .run(
        "cc " + path.split("/").pop(),
        "compiler",
        async (task) => {
          this.progress.clear();
          this.diagnostics = "";
          this.status = "Loading compiler";
          this.kernel.state(task, "waiting");
          const extraFiles: Record<string, string> = {};
          for (const [p, n] of this.kernel.fs.entries)
            if (
              n.kind === "file" &&
              p.endsWith(".h") &&
              p.startsWith("/home/visitor/")
            )
              extraFiles[p.slice("/home/visitor/".length)] =
                this.kernel.fs.text(p);
          const result = await this.worker<{
            diagnostics: string;
            binary?: Uint8Array;
            duration: number;
          }>(
            new Worker(
              new URL("../workers/compiler.worker.ts", import.meta.url),
              { type: "module" },
            ),
            {
              source,
              fileName: path.split("/").pop(),
              flags,
              extraFiles,
              base: new URL(import.meta.env.BASE_URL, location.origin).href,
            },
            task,
            180000,
            (data) => {
              if (data.type === "progress")
                this.progress.set(data.asset, {
                  loaded: data.loaded,
                  total: data.total,
                });
              if (data.type === "phase") this.status = data.phase;
              this.kernel.notify();
            },
          );
          this.lastCompileMs = result.duration;
          this.diagnostics = result.diagnostics;
          if (!result.binary) {
            this.status = "Compilation failed";
            this.kernel.finish(task, 1);
            throw Error(result.diagnostics || "Clang compilation failed");
          }
          validateMemory(result.binary);
          this.kernel.withPid(task.pid, () =>
            this.kernel.fs.write(out, result.binary!),
          );
          this.lastInfo = await inspectWasm(result.binary);
          this.status =
            "Compiled · " + result.binary.length.toLocaleString() + " bytes";
          this.kernel.trace(
            task.pid,
            "compiler",
            "clang + wasm-ld",
            path,
            out,
            result.duration,
          );
          return result;
        },
        parent,
        signal,
      )
      .catch((e) => {
        this.status = "Compiler stopped";
        this.diagnostics = e instanceof Error ? e.message : String(e);
        this.kernel.notify();
        throw e;
      });
  }
  async execute(
    path: string,
    args: string[] = [],
    stdin = "",
    cwd = "/home/visitor",
    env: Record<string, string> = {},
    parent = 1,
    signal?: AbortSignal,
    onOutput?: (text: string, channel: string) => void,
  ) {
    const binary = this.kernel.fs.read(path);
    validateMemory(binary);
    return this.kernel.run(
      path.split("/").pop() || path,
      "wasm guest",
      async (task) => {
        const snapshot = this.kernel.fs.snapshot();
        snapshot.entries.push(["/proc", { kind: "dir", mtime: Date.now() }]);
        for (const [p, reader] of this.kernel.fs.dynamic)
          snapshot.entries.push([
            p,
            {
              kind: "file",
              data: Array.from(new TextEncoder().encode(reader())),
              mtime: Date.now(),
            },
          ]);
        const result = await this.worker<{
          exitCode: number;
          stdout: string;
          stderr: string;
          duration: number;
          memoryBytes: number;
          preview: Uint8Array;
          writes: { path: string; data: Uint8Array }[];
          dirs: string[];
          removed: string[];
          suppressed: number;
        }>(
          new Worker(new URL("../workers/guest.worker.ts", import.meta.url), {
            type: "module",
          }),
          {
            binary,
            args: [path, ...args],
            env: Object.entries(env).map(([k, v]) => k + "=" + v),
            stdin,
            cwd,
            snapshot,
          },
          task,
          10000,
          (data) => {
            if (data.type === "output") onOutput?.(data.text, data.channel);
            if (data.type === "trace") {
              this.kernel.trace(
                task.pid,
                "WASI",
                data.op,
                data.args,
                data.result,
                data.duration,
              );
              task.memoryBytes = data.memoryBytes;
              this.kernel.fds = this.kernel.fds
                .filter((f) => f.pid !== task.pid)
                .concat(
                  data.descriptors.map(
                    (d: {
                      fd: number;
                      type: string;
                      path?: string;
                      offset: number;
                    }) => ({
                      pid: task.pid,
                      fd: d.fd,
                      path:
                        d.fd < 3
                          ? "/dev/std" + ["in", "out", "err"][d.fd]
                          : d.path || d.type,
                      mode: "rw",
                      offset: d.offset,
                    }),
                  ),
                );
            }
            if (data.type === "memory") {
              this.memoryPreview = data.preview;
              this.memoryBytes = data.bytes;
              task.memoryBytes = data.bytes;
              this.kernel.trace(
                task.pid,
                "WASM",
                "module.instantiate",
                path,
                String(data.bytes) + " bytes",
              );
            }
          },
        );
        const writable = (p: string) =>
          p.startsWith("/home/visitor/") || p.startsWith("/tmp/");
        const staging = new FileSystem();
        staging.entries = new Map(this.kernel.fs.entries);
        staging.dynamic = new Map(this.kernel.fs.dynamic);
        const fsEvents: [string, string, string][] = [];
        staging.onEvent = (...args) => fsEvents.push(args);
        for (const d of result.dirs
          .filter(writable)
          .sort((a, b) => a.length - b.length))
          if (!staging.exists(d)) staging.mkdir(d, true);
        for (const w of result.writes)
          if (writable(w.path)) staging.write(w.path, w.data);
        for (const p of result.removed.sort((a, b) => b.length - a.length))
          if (writable(p) && staging.exists(p)) staging.remove(p);
        this.kernel.fs.entries = staging.entries;
        this.kernel.fs.changed();
        for (const [op, args, result] of fsEvents)
          this.kernel.trace(task.pid, "filesystem", op, args, result);
        this.lastRunMs = result.duration;
        this.memoryBytes = result.memoryBytes;
        this.memoryPreview = result.preview;
        task.memoryBytes = result.memoryBytes;
        if (result.suppressed)
          this.kernel.trace(
            task.pid,
            "WASI",
            "trace.capped",
            String(result.suppressed),
            "additional host calls omitted",
          );
        this.kernel.finish(task, result.exitCode);
        this.kernel.notify();
        return result;
      },
      parent,
      signal,
    );
  }
  private worker<T>(
    worker: Worker,
    payload: unknown,
    task: Task,
    timeout: number,
    onMessage: (data: any) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timer);
        worker.terminate();
        task.controller.signal.removeEventListener("abort", abort);
      };
      const fail = (message: string) => {
        cleanup();
        reject(Error(message));
      };
      const abort = () => fail("Interrupted: worker terminated");
      task.controller.signal.addEventListener("abort", abort, { once: true });
      if (task.controller.signal.aborted) {
        abort();
        return;
      }
      timer = setTimeout(
        () => fail(`Worker exceeded ${timeout / 1000}s execution limit`),
        timeout,
      );
      worker.onerror = (e) => fail(e.message || "Worker failed");
      worker.onmessage = ({ data }) => {
        if (data.type === "done") {
          cleanup();
          resolve(data);
        } else if (data.type === "error") fail(data.message);
        else onMessage(data);
      };
      worker.postMessage(payload);
    });
  }
}
