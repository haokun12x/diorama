/// <reference lib="webworker" />
import {
  WASI,
  File,
  Directory,
  PreopenDirectory,
  OpenDirectory,
  OpenFile,
  ConsoleStdout,
} from "@bjorn3/browser_wasi_shim";
import type { Inode } from "@bjorn3/browser_wasi_shim";
import type { Snapshot } from "../fs/filesystem";
import { validateMemory } from "../compiler/wasm";
type GuestInput = {
  binary: Uint8Array;
  args: string[];
  env: string[];
  stdin: string;
  snapshot: Snapshot;
  cwd: string;
};
self.onmessage = async ({ data }: { data: GuestInput }) => {
  try {
    validateMemory(data.binary);
    const root = new Directory(new Map());
    const original = new Map<string, Uint8Array>();
    for (const [path, entry] of data.snapshot.entries.sort(
      (a, b) => a[0].length - b[0].length,
    )) {
      if (path === "/") continue;
      const parts = path.slice(1).split("/");
      let dir = root;
      for (const p of parts.slice(0, -1)) {
        let n = dir.contents.get(p);
        if (!n) {
          n = new Directory(new Map());
          dir.contents.set(p, n);
        }
        if (!(n instanceof Directory)) throw Error("invalid directory");
        dir = n;
      }
      if (entry.kind === "dir")
        dir.contents.set(parts.at(-1)!, new Directory(new Map()));
      else {
        const bytes = Uint8Array.from(entry.data || []);
        dir.contents.set(
          parts.at(-1)!,
          new File(bytes, {
            readonly:
              !path.startsWith("/home/visitor/") && !path.startsWith("/tmp/"),
          }),
        );
        original.set(path, bytes);
      }
    }
    let working = root;
    for (const p of data.cwd.slice(1).split("/")) {
      const n = working.contents.get(p);
      if (!(n instanceof Directory)) throw Error("cwd does not exist");
      working = n;
    }
    const stdoutDecoder = new TextDecoder(),
      stderrDecoder = new TextDecoder();
    let stdout = "",
      stderr = "",
      outputBytes = 0;
    const output = (channel: "stdout" | "stderr", chunk: Uint8Array) => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) throw Error("guest output exceeds 1 MiB");
      const text = (
        channel === "stdout" ? stdoutDecoder : stderrDecoder
      ).decode(chunk, { stream: true });
      if (channel === "stdout") stdout += text;
      else stderr += text;
      self.postMessage({ type: "output", channel, text });
    };
    const wasi = new WASI(data.args, data.env, [
      new OpenFile(
        new File(new TextEncoder().encode(data.stdin), { readonly: true }),
      ),
      new ConsoleStdout((c) => output("stdout", c)),
      new ConsoleStdout((c) => output("stderr", c)),
      new PreopenDirectory("/", root.contents),
      new PreopenDirectory(data.cwd, working.contents),
    ]);
    let instance: WebAssembly.Instance;
    let traceCount = 0,
      suppressed = 0,
      observedMemory = 0;
    const host: Record<string, (...args: unknown[]) => unknown> = {};
    const inodePaths = new WeakMap<Inode, string>();
    const indexPaths = (dir: Directory, base: string) => {
      inodePaths.set(dir, base || "/");
      for (const [name, n] of dir.contents) {
        const p = base + "/" + name;
        inodePaths.set(n, p);
        if (n instanceof Directory) indexPaths(n, p);
      }
    };
    const descriptors = () => {
      indexPaths(root, "");
      return wasi.fds
        .map((fd, index) =>
          fd
            ? {
                fd: index,
                type: fd.constructor.name,
                path:
                  fd instanceof PreopenDirectory
                    ? fd.prestat_name
                    : fd instanceof OpenFile
                      ? inodePaths.get(fd.file)
                      : fd instanceof OpenDirectory
                        ? inodePaths.get(fd.dir)
                        : undefined,
                offset: fd instanceof OpenFile ? Number(fd.file_pos) : 0,
              }
            : null,
        )
        .filter(Boolean);
    };
    for (const [name, fn] of Object.entries(wasi.wasiImport))
      host[name] = (...args) => {
        const before = performance.now();
        // Deny filesystem mutations outside the two writeable virtual areas.
        if (name === "path_open" || name.startsWith("path_")) {
          const memory = instance?.exports.memory as
            WebAssembly.Memory | undefined;
          let path = "";
          if (
            memory &&
            [
              "path_open",
              "path_create_directory",
              "path_unlink_file",
              "path_remove_directory",
              "path_filestat_set_times",
            ].includes(name)
          ) {
            const pointer =
              name === "path_open" || name === "path_filestat_set_times"
                ? 2
                : 1;
            path = new TextDecoder().decode(
              new Uint8Array(
                memory.buffer,
                Number(args[pointer]),
                Number(args[pointer + 1]),
              ),
            );
            indexPaths(root, "");
            const directory = wasi.fds[Number(args[0])];
            const base =
              directory instanceof PreopenDirectory
                ? directory.prestat_name
                : directory instanceof OpenDirectory
                  ? inodePaths.get(directory.dir) || "/"
                  : "/";
            const absolute = path.startsWith("/") ? path : base + "/" + path;
            const normalized = absolute
              .split("/")
              .reduce<string[]>((parts, p) => {
                if (p === "..") parts.pop();
                else if (p && p !== ".") parts.push(p);
                return parts;
              }, [])
              .join("/");
            const writable =
              normalized.startsWith("home/visitor/") ||
              normalized.startsWith("tmp/");
            const mutates =
              name !== "path_open" ||
              (Number(args[4]) & 9) !== 0 ||
              (BigInt(args[5] as bigint) & 64n) !== 0n;
            if (mutates && !writable) return 63; // ERRNO_PERM
          }
          if (["path_rename", "path_link", "path_symlink"].includes(name))
            return 58; // not supported in guest adapter
        }
        const fd = wasi.fds[Number(args[0])];
        if (
          fd instanceof OpenFile &&
          [
            "fd_allocate",
            "fd_filestat_set_size",
            "fd_write",
            "fd_pwrite",
          ].includes(name)
        ) {
          if (fd.file.readonly) return 63;
          let nextSize = fd.file.data.length;
          if (name === "fd_allocate")
            nextSize = Math.max(nextSize, Number(args[1]) + Number(args[2]));
          if (name === "fd_filestat_set_size") nextSize = Number(args[1]);
          if (name === "fd_write" || name === "fd_pwrite") {
            const mem = instance.exports.memory as WebAssembly.Memory,
              view = new DataView(mem.buffer);
            let length = 0;
            for (let i = 0; i < Number(args[2]); i++)
              length += view.getUint32(Number(args[1]) + i * 8 + 4, true);
            nextSize = Math.max(
              nextSize,
              (name === "fd_pwrite" ? Number(args[3]) : Number(fd.file_pos)) +
                length,
            );
          }
          let total = 0;
          const count = (dir: Directory) => {
            for (const n of dir.contents.values())
              if (n instanceof File) total += n.data.length;
              else if (n instanceof Directory) count(n);
          };
          count(root);
          if (
            !Number.isFinite(nextSize) ||
            nextSize > 8 * 1024 * 1024 ||
            total - fd.file.data.length + nextSize > 32 * 1024 * 1024
          )
            return 27;
        }
        const result = fn(...args);
        const memory = instance?.exports.memory as
          WebAssembly.Memory | undefined;
        if (memory)
          observedMemory = Math.max(observedMemory, memory.buffer.byteLength);
        if (name === "fd_write") {
          const fd = wasi.fds[Number(args[0])];
          if (fd instanceof OpenFile && fd.file.data.length > 8 * 1024 * 1024)
            throw Error("guest file exceeds 8 MiB");
        }
        if (traceCount++ < 300)
          self.postMessage({
            type: "trace",
            op: name,
            args: args.map(String).join(", "),
            result: String(result),
            duration: performance.now() - before,
            memoryBytes: memory?.buffer.byteLength || 0,
            descriptors: descriptors(),
          });
        else suppressed++;
        return result;
      };
    const started = performance.now();
    const module = await WebAssembly.compile(
      data.binary as Uint8Array<ArrayBuffer>,
    );
    if (
      WebAssembly.Module.imports(module).some(
        (i) => i.module !== "wasi_snapshot_preview1" || !(i.name in host),
      )
    )
      throw Error("unsupported guest import");
    instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: host,
    });
    const memory = instance.exports.memory as WebAssembly.Memory;
    self.postMessage({
      type: "memory",
      bytes: memory.buffer.byteLength,
      preview: new Uint8Array(memory.buffer.slice(0, 4096)),
    });
    const exitCode = wasi.start(
      instance as unknown as Parameters<WASI["start"]>[0],
    );
    const writes: { path: string; data: Uint8Array }[] = [],
      dirs: string[] = [];
    const existing = new Set<string>();
    const walk = (dir: Directory, base: string) => {
      for (const [name, n] of dir.contents) {
        const path = base + "/" + name;
        existing.add(path);
        if (n instanceof Directory) {
          dirs.push(path);
          walk(n, path);
        } else if (n instanceof File) {
          const old = original.get(path);
          if (
            !old ||
            old.length !== n.data.length ||
            old.some((b, i) => b !== n.data[i])
          )
            writes.push({ path, data: n.data });
        }
      }
    };
    walk(root, "");
    self.postMessage({
      type: "done",
      exitCode,
      stdout,
      stderr,
      writes,
      dirs,
      removed: data.snapshot.entries
        .map(([p]) => p)
        .filter((p) => p !== "/" && !existing.has(p)),
      duration: performance.now() - started,
      memoryBytes: Math.max(observedMemory, memory.buffer.byteLength),
      preview: new Uint8Array(memory.buffer.slice(0, 4096)),
      suppressed,
    });
  } catch (e) {
    self.postMessage({
      type: "error",
      message: e instanceof Error ? e.message : String(e),
    });
  }
};
