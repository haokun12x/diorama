import { FileSystem } from "../fs/filesystem";
export type TaskState =
  "runnable" | "running" | "waiting" | "terminated" | "cancelled";
export type Task = {
  pid: number;
  ppid: number;
  name: string;
  kind: string;
  state: TaskState;
  created: number;
  ended?: number;
  exitCode?: number;
  memoryBytes: number;
  controller: AbortController;
};
export type TraceEvent = {
  id: number;
  time: number;
  pid: number;
  layer: string;
  op: string;
  args: string;
  result: string;
  duration: number;
};
export type Descriptor = {
  pid: number;
  fd: number;
  path: string;
  mode: "r" | "w" | "rw";
  offset: number;
};
export class Kernel {
  fs = new FileSystem();
  tasks = new Map<number, Task>();
  events: TraceEvent[] = [];
  fds: Descriptor[] = [];
  started = performance.now();
  nextPid = 2;
  nextEvent = 1;
  currentPid = 1;
  revision = 0;
  listeners = new Set<() => void>();
  constructor() {
    this.tasks.set(1, {
      pid: 1,
      ppid: 0,
      name: "visitor shell",
      kind: "shell",
      state: "waiting",
      created: performance.now(),
      memoryBytes: 0,
      controller: new AbortController(),
    });
    this.fds = [
      { pid: 1, fd: 0, path: "/dev/stdin", mode: "r", offset: 0 },
      { pid: 1, fd: 1, path: "/dev/stdout", mode: "w", offset: 0 },
      { pid: 1, fd: 2, path: "/dev/stderr", mode: "w", offset: 0 },
    ];
    this.fs.onEvent = (op, args, result) =>
      this.trace(this.currentPid, "filesystem", op, args, result);
    this.fs.onChange = () => this.notify();
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  notify() {
    this.revision++;
    for (const l of this.listeners) l();
  }
  trace(
    pid: number,
    layer: string,
    op: string,
    args = "",
    result = "0",
    duration = 0,
  ) {
    this.events.push({
      id: this.nextEvent++,
      time: performance.now() - this.started,
      pid,
      layer,
      op,
      args: args.slice(0, 300),
      result: result.slice(0, 500),
      duration,
    });
    if (this.events.length > 500) this.events.shift();
    this.notify();
  }
  spawn(name: string, kind = "userspace", ppid = 1) {
    const pid = this.nextPid++;
    const task: Task = {
      pid,
      ppid,
      name,
      kind,
      state: "runnable",
      created: performance.now(),
      memoryBytes: 0,
      controller: new AbortController(),
    };
    this.tasks.set(pid, task);
    this.trace(
      pid,
      "kernel",
      "task.spawn",
      `${name}, parent=${ppid}`,
      "runnable",
    );
    this.fds.push(
      ...[0, 1, 2].map((fd) => ({
        pid,
        fd,
        path: `/dev/std${["in", "out", "err"][fd]}`,
        mode: (fd === 0 ? "r" : "w") as "r" | "w",
        offset: 0,
      })),
    );
    const dead = [...this.tasks.values()].filter((t) => t.ended);
    for (const t of dead.slice(0, Math.max(0, this.tasks.size - 128)))
      this.tasks.delete(t.pid);
    return task;
  }
  state(task: Task, state: TaskState) {
    if (task.ended) return;
    task.state = state;
    this.trace(task.pid, "scheduler", "task.state", task.name, state);
  }
  finish(task: Task, code = 0) {
    if (task.ended) return;
    task.state = task.controller.signal.aborted ? "cancelled" : "terminated";
    task.ended = performance.now();
    task.exitCode = code;
    this.fds = this.fds.filter((f) => f.pid !== task.pid);
    this.trace(
      task.pid,
      "kernel",
      "task.exit",
      task.name,
      String(code),
      task.ended - task.created,
    );
  }
  cancel(pid: number) {
    const t = this.tasks.get(pid);
    if (!t || t.ended || pid === 1) throw Error(`${pid}: no cancellable task`);
    t.controller.abort();
    for (const child of this.tasks.values())
      if (child.ppid === pid && !child.ended) this.cancel(child.pid);
    this.finish(t, 130);
  }
  async run<T>(
    name: string,
    kind: string,
    fn: (task: Task) => Promise<T> | T,
    parent = 1,
    signal?: AbortSignal,
  ) {
    const t = this.spawn(name, kind, parent);
    const abort = () => {
      if (!t.ended) this.cancel(t.pid);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw Error("Interrupted");
      await new Promise<void>((r) => setTimeout(r, 0));
      this.state(t, "running");
      if (t.controller.signal.aborted) throw Error("Interrupted");
      const result = await fn(t);
      this.finish(t, 0);
      return result;
    } catch (e) {
      this.finish(t, t.controller.signal.aborted ? 130 : 1);
      throw e;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
  withPid<T>(pid: number, fn: () => T): T {
    const previous = this.currentPid;
    this.currentPid = pid;
    try {
      return fn();
    } finally {
      this.currentPid = previous;
    }
  }
  open(pid: number, path: string, mode: Descriptor["mode"] = "r") {
    if (mode === "r") this.fs.stat(path);
    const fd =
      Math.max(2, ...this.fds.filter((f) => f.pid === pid).map((f) => f.fd)) +
      1;
    this.fds.push({ pid, fd, path, mode, offset: 0 });
    this.trace(pid, "kernel", "fd.open", `${path}, ${mode}`, String(fd));
    return fd;
  }
  read(pid: number, fd: number, count: number) {
    const d = this.fds.find((f) => f.pid === pid && f.fd === fd);
    if (!d || d.mode === "w") throw Error("bad descriptor");
    const bytes = this.fs.read(d.path).slice(d.offset, d.offset + count);
    d.offset += bytes.length;
    this.trace(pid, "kernel", "fd.read", String(fd), String(bytes.length));
    return bytes;
  }
  write(pid: number, fd: number, data: Uint8Array) {
    const d = this.fds.find((f) => f.pid === pid && f.fd === fd);
    if (!d || d.mode === "r") throw Error("bad descriptor");
    const old = this.fs.exists(d.path)
      ? this.fs.read(d.path)
      : new Uint8Array();
    const next = new Uint8Array(Math.max(old.length, d.offset + data.length));
    next.set(old);
    next.set(data, d.offset);
    this.fs.write(d.path, next);
    d.offset += data.length;
    this.trace(pid, "kernel", "fd.write", String(fd), String(data.length));
  }
  close(pid: number, fd: number) {
    const at = this.fds.findIndex((f) => f.pid === pid && f.fd === fd);
    if (at < 0) throw Error("bad descriptor");
    this.fds.splice(at, 1);
    this.trace(pid, "kernel", "fd.close", String(fd), "0");
  }
  proc() {
    this.fs.mkdir("/proc", true, true);
    const virtual: Record<string, () => string> = {
      tasks: () => JSON.stringify(this.taskInfo(), null, 2) + "\n",
      mounts: () => "/  diorama-memfs  rw\n/proc  dynamic-runtime  ro\n",
      runtime: () =>
        JSON.stringify(
          {
            kernel: "DIORAMA 0.1",
            architecture: "wasm32 / WASI preview1",
            uptimeMs: performance.now() - this.started,
            filesystemBytes: this.fs.bytes(),
            taskCount: this.tasks.size,
            sharedArrayBufferRequired: false,
          },
          null,
          2,
        ) + "\n",
    };
    for (const [name, read] of Object.entries(virtual)) {
      this.fs.write("/proc/" + name, "", false, true);
      this.fs.dynamic.set("/proc/" + name, read);
    }
  }
  taskInfo() {
    return [...this.tasks.values()].map(({ controller, ...t }) => t);
  }
}
