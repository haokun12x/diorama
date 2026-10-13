/// <reference lib="webworker" />
import { NativeKernel } from "../kernel/runtime";
import type { Snapshot } from "../fs/filesystem";
import { validateMemory } from "../compiler/wasm";

type GuestInput = {
  binary: Uint8Array;
  kernelModule: WebAssembly.Module;
  pid: number;
  args: string[];
  env: string[];
  stdin: string;
  snapshot: Snapshot;
  cwd: string;
};
type SnapshotNode = {
  path: string;
  kind: "file" | "dir";
  mtime: number;
  offset: number;
  len: number;
};
class ProcessExit extends Error {
  constructor(public code: number) {
    super("WASI process exit");
  }
}
const encode = new TextEncoder(),
  decode = new TextDecoder();

// Only marshals WASI's guest pointers. Rust/WASM owns all service semantics and state.
self.onmessage = async ({ data }: { data: GuestInput }) => {
  try {
    validateMemory(data.binary);
    const core = new NativeKernel(data.kernelModule);
    const nodes: SnapshotNode[] = [];
    const original = new Map<string, Uint8Array>();
    let size = 0;
    for (const [path, entry] of data.snapshot.entries) {
      const bytes = Uint8Array.from(entry.data || []);
      nodes.push({
        path,
        kind: entry.kind,
        mtime: entry.mtime,
        offset: size,
        len: bytes.length,
      });
      if (entry.kind === "file") original.set(path, bytes);
      size += bytes.length;
    }
    if (size > 32 * 1024 * 1024) throw Error("snapshot exceeds 32 MiB");
    const blob = new Uint8Array(size);
    for (const node of nodes)
      if (node.kind === "file") blob.set(original.get(node.path)!, node.offset);
    core.call("fs.restore", { nodes }, blob);
    core.call(
      "guest.init",
      { pid: data.pid, cwd: data.cwd, argv: data.args, env: data.env },
      encode.encode(data.stdin),
    );
    let instance: WebAssembly.Instance;
    let traceCount = 0,
      suppressed = 0,
      observedMemory = 0;
    const memory = () => instance.exports.memory as WebAssembly.Memory;
    const bytes = (ptr: number, length: number) => {
      if (
        !Number.isInteger(ptr) ||
        !Number.isInteger(length) ||
        ptr < 0 ||
        length < 0 ||
        ptr + length > memory().buffer.byteLength
      )
        throw new RangeError("invalid guest memory range");
      return new Uint8Array(memory().buffer, ptr, length);
    };
    const u32 = (ptr: number, value: number) =>
      new DataView(bytes(ptr, 4).buffer, ptr, 4).setUint32(0, value, true);
    const string = (ptr: number, len: number) => decode.decode(bytes(ptr, len));
    const vectors = (ptr: number, count: number) => {
      if (count > 1024) throw new RangeError("too many I/O vectors");
      const view = new DataView(bytes(ptr, count * 8).buffer, ptr, count * 8);
      const list: Uint8Array[] = [];
      let total = 0;
      for (let i = 0; i < count; i++) {
        const part = bytes(
          view.getUint32(i * 8, true),
          view.getUint32(i * 8 + 4, true),
        );
        total += part.length;
        if (total > 8 * 1024 * 1024)
          throw new RangeError("I/O buffer exceeds limit");
        list.push(part);
      }
      return { list, total };
    };
    const host: Record<string, (...args: any[]) => number> = {};
    const supported = [
      "args_get",
      "args_sizes_get",
      "environ_get",
      "environ_sizes_get",
      "clock_res_get",
      "clock_time_get",
      "fd_advise",
      "fd_allocate",
      "fd_close",
      "fd_datasync",
      "fd_fdstat_get",
      "fd_fdstat_set_flags",
      "fd_fdstat_set_rights",
      "fd_filestat_get",
      "fd_filestat_set_size",
      "fd_filestat_set_times",
      "fd_pread",
      "fd_prestat_get",
      "fd_prestat_dir_name",
      "fd_pwrite",
      "fd_read",
      "fd_readdir",
      "fd_renumber",
      "fd_seek",
      "fd_sync",
      "fd_tell",
      "fd_write",
      "path_create_directory",
      "path_filestat_get",
      "path_filestat_set_times",
      "path_link",
      "path_open",
      "path_readlink",
      "path_remove_directory",
      "path_rename",
      "path_symlink",
      "path_unlink_file",
      "poll_oneoff",
      "proc_exit",
      "proc_raise",
      "random_get",
      "sched_yield",
      "sock_accept",
      "sock_recv",
      "sock_send",
      "sock_shutdown",
    ];
    for (const name of supported)
      host[name] = (...args: any[]) => {
        const started = performance.now();
        if (memory().buffer.byteLength !== observedMemory) {
          observedMemory = memory().buffer.byteLength;
          core.call("task.memory", { pid: data.pid, bytes: observedMemory });
        }
        const req: Record<string, unknown> = {
          traceArgs: args.map(String).join(", "),
        };
        let input = new Uint8Array(),
          outputPtr: number | undefined,
          outputMax: number | undefined;
        let io: ReturnType<typeof vectors> | undefined;
        let result: {
          value: {
            errno: number;
            fields: { offsets?: number[]; count?: number; exitCode?: number };
          };
          data: Uint8Array;
        };
        try {
          if (name.startsWith("fd_")) req.fd = args[0];
          if (name === "args_sizes_get" || name === "environ_sizes_get") {
            bytes(args[0], 4);
            bytes(args[1], 4);
          } else if (name === "args_get" || name === "environ_get") {
            outputPtr = args[1];
          } else if (
            ["fd_read", "fd_write", "fd_pread", "fd_pwrite"].includes(name)
          ) {
            io = vectors(args[1], args[2]);
            req.count = io.total;
            bytes(args[name === "fd_pread" || name === "fd_pwrite" ? 4 : 3], 4);
            if (name === "fd_pread" || name === "fd_pwrite")
              req.offset = String(args[3]);
            if (name === "fd_write" || name === "fd_pwrite") {
              input = new Uint8Array(io.total);
              let offset = 0;
              for (const part of io.list) {
                input.set(part, offset);
                offset += part.length;
              }
            }
          } else if (
            ["fd_prestat_get", "fd_fdstat_get", "fd_filestat_get"].includes(
              name,
            )
          ) {
            outputPtr = args[1];
            outputMax =
              name === "fd_prestat_get"
                ? 8
                : name === "fd_fdstat_get"
                  ? 24
                  : 64;
          } else if (name === "fd_prestat_dir_name") {
            outputPtr = args[1];
            outputMax = args[2];
          } else if (name === "fd_seek") {
            req.offset = String(args[1]);
            req.whence = args[2];
            outputPtr = args[3];
            outputMax = 8;
          } else if (name === "fd_tell") {
            outputPtr = args[1];
            outputMax = 8;
          } else if (name === "fd_fdstat_set_flags") req.flags = args[1];
          else if (name === "fd_filestat_set_size") req.size = String(args[1]);
          else if (name === "fd_allocate") {
            req.offset = String(args[1]);
            req.len = String(args[2]);
          } else if (name === "fd_readdir") {
            req.count = args[2];
            req.cookie = String(args[3]);
            outputPtr = args[1];
            outputMax = args[2];
            bytes(args[4], 4);
          } else if (name === "path_open") {
            req.dirfd = args[0];
            req.path = string(args[2], args[3]);
            req.oflags = args[4];
            req.rights = String(args[5]);
            req.fdflags = args[7];
            outputPtr = args[8];
            outputMax = 4;
          } else if (name === "path_filestat_get") {
            req.dirfd = args[0];
            req.path = string(args[2], args[3]);
            outputPtr = args[4];
            outputMax = 64;
          } else if (
            [
              "path_create_directory",
              "path_unlink_file",
              "path_remove_directory",
            ].includes(name)
          ) {
            req.dirfd = args[0];
            req.path = string(args[1], args[2]);
          } else if (name === "clock_time_get" || name === "clock_res_get") {
            req.clock = args[0];
            outputPtr = args[name === "clock_time_get" ? 2 : 1];
            outputMax = 8;
          } else if (name === "random_get") {
            req.len = args[1];
            outputPtr = args[0];
            outputMax = args[1];
          } else if (name === "proc_exit") req.code = args[0];
          if (outputPtr !== undefined && outputMax !== undefined)
            bytes(outputPtr, outputMax);
          result = core.call("wasi." + name, req, input);
          if (!result.value.errno) {
            if (name === "args_sizes_get" || name === "environ_sizes_get") {
              const view = new DataView(
                result.data.buffer,
                result.data.byteOffset,
                8,
              );
              u32(args[0], view.getUint32(0, true));
              u32(args[1], view.getUint32(4, true));
            } else if (name === "args_get" || name === "environ_get") {
              bytes(args[0], result.value.fields.offsets!.length * 4);
              bytes(args[1], result.data.length).set(result.data);
              result.value.fields.offsets!.forEach((offset, i) =>
                u32(args[0] + i * 4, args[1] + offset),
              );
            } else if (io) {
              if (name === "fd_read" || name === "fd_pread") {
                let offset = 0;
                for (const part of io.list) {
                  const n = Math.min(part.length, result.data.length - offset);
                  if (n > 0) part.set(result.data.subarray(offset, offset + n));
                  offset += n;
                }
              }
              u32(
                args[name === "fd_pread" || name === "fd_pwrite" ? 4 : 3],
                result.value.fields.count!,
              );
              if ((name === "fd_write" || name === "fd_pwrite") && args[0] < 3)
                self.postMessage({
                  type: "output",
                  channel: args[0] === 1 ? "stdout" : "stderr",
                  text: decode.decode(input),
                });
            } else if (outputPtr !== undefined) {
              if (outputMax !== undefined && result.data.length > outputMax)
                return 37;
              bytes(outputPtr, result.data.length).set(result.data);
              if (name === "fd_readdir") u32(args[4], result.data.length);
            }
          }
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          result = { value: { errno: 21, fields: {} }, data: new Uint8Array() };
          core.call("trace.add", {
            pid: data.pid,
            layer: "WASI",
            name,
            args: req.traceArgs,
            result: "21",
            duration: performance.now() - started,
          });
        }
        observedMemory = Math.max(observedMemory, memory().buffer.byteLength);
        if (traceCount++ < 300)
          self.postMessage({
            type: "trace",
            op: name,
            args: req.traceArgs,
            result: String(result.value.errno),
            duration: performance.now() - started,
            memoryBytes: memory().buffer.byteLength,
            descriptors: core.call("fd.list").value,
          });
        else suppressed++;
        if (name === "proc_exit" && !result.value.errno)
          throw new ProcessExit(result.value.fields.exitCode!);
        return result.value.errno;
      };
    const started = performance.now();
    const module = await WebAssembly.compile(
      data.binary as Uint8Array<ArrayBuffer>,
    );
    if (
      WebAssembly.Module.imports(module).some(
        (i) =>
          i.module !== "wasi_snapshot_preview1" ||
          i.kind !== "function" ||
          !(i.name in host),
      )
    )
      throw Error("unsupported guest import");
    instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: host,
    });
    if (
      !(memory() instanceof WebAssembly.Memory) ||
      typeof instance.exports._start !== "function"
    )
      throw Error("guest requires exported memory and _start");
    observedMemory = memory().buffer.byteLength;
    core.call("task.memory", { pid: data.pid, bytes: observedMemory });
    self.postMessage({
      type: "memory",
      bytes: memory().buffer.byteLength,
      preview: new Uint8Array(memory().buffer.slice(0, 4096)),
    });
    let exitCode = 0;
    try {
      (instance.exports._start as () => void)();
    } catch (error) {
      if (error instanceof ProcessExit) exitCode = error.code;
      else throw error;
    }
    core.call("task.finish", { pid: data.pid, code: exitCode });
    const snapshot = core.call<SnapshotNode[]>("fs.snapshot");
    const existing = new Set(snapshot.value.map((n) => n.path));
    const dirs: string[] = [],
      writes: { path: string; data: Uint8Array }[] = [];
    for (const node of snapshot.value) {
      if (node.kind === "dir") dirs.push(node.path);
      else {
        const bytes = snapshot.data.slice(node.offset, node.offset + node.len),
          old = original.get(node.path);
        if (
          !old ||
          old.length !== bytes.length ||
          old.some((b, i) => b !== bytes[i])
        )
          writes.push({ path: node.path, data: bytes });
      }
    }
    self.postMessage({
      type: "done",
      exitCode,
      stdout: decode.decode(core.call("fs.peek", { path: "/dev/stdout" }).data),
      stderr: decode.decode(core.call("fs.peek", { path: "/dev/stderr" }).data),
      writes,
      dirs,
      removed: data.snapshot.entries
        .map(([p]) => p)
        .filter((p) => p !== "/" && !existing.has(p)),
      duration: performance.now() - started,
      memoryBytes: Math.max(observedMemory, memory().buffer.byteLength),
      kernelMemoryBytes: core.exports.memory.buffer.byteLength,
      preview: new Uint8Array(memory().buffer.slice(0, 4096)),
      suppressed,
    });
  } catch (e) {
    self.postMessage({
      type: "error",
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
