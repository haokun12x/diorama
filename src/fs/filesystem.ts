export type Entry =
  | { kind: "file"; data: Uint8Array; mtime: number }
  | { kind: "dir"; mtime: number };
export type Snapshot = {
  version: 1;
  entries: [
    string,
    { kind: "dir" | "file"; data?: number[] | Uint8Array; mtime: number },
  ][];
};
export type FsEvent = (op: string, args: string, result: string) => void;
import { NativeKernel } from "../kernel/native";
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
export function resolvePath(path: string, cwd = "/home/visitor"): string {
  const parts: string[] = [];
  for (const p of (path.startsWith("/") ? path : cwd + "/" + path).split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return "/" + parts.join("/");
}
export function parentPath(path: string) {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}
type SnapshotNode = {
  path: string;
  kind: "dir" | "file";
  mtime: number;
  offset: number;
  len: number;
};
export class FileSystem {
  dynamic = new Map<string, () => string>();
  onEvent: FsEvent = () => {};
  onChange: () => void = () => {};
  private cache = new Map<string, Entry>();
  private cacheRevision = -1;
  private limit = 32 * 1024 * 1024;
  constructor(public core = new NativeKernel()) {}
  get revision() {
    return this.core.call<number>("fs.version").value;
  }
  get maxBytes() {
    return this.limit;
  }
  set maxBytes(n: number) {
    this.limit = n;
    this.core.call("fs.limit", { bytes: n });
  }
  private operation<T>(
    op: string,
    args: Record<string, unknown> = {},
    bytes?: Uint8Array,
    mutates = false,
  ) {
    const result = this.core.call<T>(op, args, bytes);
    for (const e of result.events)
      if (e.layer === "filesystem") this.onEvent(e.op, e.args, e.result);
    if (mutates) this.changed();
    return result;
  }
  get entries() {
    const version = this.revision;
    if (version !== this.cacheRevision) {
      const r = this.core.call<SnapshotNode[]>("fs.inventory");
      const entries = new Map<string, Entry>();
      for (const n of r.value)
        entries.set(
          n.path,
          n.kind === "dir"
            ? { kind: "dir", mtime: n.mtime }
            : {
                kind: "file",
                mtime: n.mtime,
                data: r.data.slice(n.offset, n.offset + n.len),
              },
        );
      this.cache = entries;
      this.cacheRevision = version;
    }
    return this.cache;
  }
  set entries(map: Map<string, Entry>) {
    this.restore({
      version: 1,
      entries: [...map]
        .filter(([p]) => p != "/proc" && !p.startsWith("/proc/"))
        .map(([p, n]) => [
          p,
          {
            kind: n.kind,
            mtime: n.mtime,
            ...(n.kind === "file" ? { data: n.data } : {}),
          },
        ]),
    });
  }
  changed() {
    this.cacheRevision = -1;
    this.onChange();
  }
  stat(path: string): Entry {
    const p = resolvePath(path);
    const n = this.core.call<{ kind: "dir" | "file"; mtime: number }>(
      "fs.stat",
      { path: p },
    ).value;
    return n.kind === "dir"
      ? { kind: "dir", mtime: n.mtime }
      : {
          kind: "file",
          mtime: n.mtime,
          data: this.core.call("fs.peek", { path: p }).data,
        };
  }
  exists(path: string) {
    return this.core.call<boolean>("fs.exists", { path: resolvePath(path) })
      .value;
  }
  guard(path: string) {
    if (path === "/proc" || path.startsWith("/proc/"))
      throw Error(`${path}: read-only virtual mount`);
  }
  mkdir(path: string, recursive = false, internal = false) {
    this.operation(
      "fs.mkdir",
      { path: resolvePath(path), recursive, internal },
      undefined,
      true,
    );
  }
  write(
    path: string,
    data: string | Uint8Array,
    append = false,
    internal = false,
  ) {
    this.operation(
      "fs.write",
      { path: resolvePath(path), append, internal },
      typeof data === "string" ? encoder.encode(data) : data,
      true,
    );
  }
  read(path: string) {
    return this.operation("fs.read", { path: resolvePath(path) }).data;
  }
  peek(path: string) {
    return this.core.call("fs.peek", { path: resolvePath(path) }).data;
  }
  text(path: string) {
    return decoder.decode(this.read(path));
  }
  list(path: string) {
    return this.operation<string[]>("fs.list", { path: resolvePath(path) })
      .value;
  }
  remove(path: string, recursive = false) {
    this.operation(
      "fs.remove",
      { path: resolvePath(path), recursive },
      undefined,
      true,
    );
  }
  copy(from: string, to: string, recursive = false) {
    this.operation(
      "fs.copy",
      { from: resolvePath(from), to: resolvePath(to), recursive },
      undefined,
      true,
    );
  }
  move(from: string, to: string) {
    this.operation(
      "fs.move",
      { from: resolvePath(from), to: resolvePath(to) },
      undefined,
      true,
    );
  }
  bytes() {
    return this.core.call<number>("fs.bytes").value;
  }
  snapshot(): Snapshot {
    const r = this.core.call<SnapshotNode[]>("fs.snapshot");
    return {
      version: 1,
      entries: r.value.map((n) => [
        n.path,
        {
          kind: n.kind,
          mtime: n.mtime,
          ...(n.kind === "file"
            ? { data: r.data.slice(n.offset, n.offset + n.len) }
            : {}),
        },
      ]),
    };
  }
  restore(snapshot: Snapshot) {
    if (snapshot.version !== 1 || !Array.isArray(snapshot.entries))
      throw Error("unsupported snapshot");
    let size = 0;
    const chunks: Uint8Array[] = [];
    const nodes: SnapshotNode[] = [];
    for (const [path, n] of snapshot.entries) {
      const bytes =
        n.kind === "file" ? Uint8Array.from(n.data || []) : new Uint8Array();
      nodes.push({
        path,
        kind: n.kind,
        mtime: n.mtime,
        offset: size,
        len: bytes.length,
      });
      chunks.push(bytes);
      size += bytes.length;
      if (size > this.limit) throw Error("snapshot exceeds limit");
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    this.operation("fs.restore", { nodes }, bytes, true);
  }
}

export class SnapshotStore {
  async database() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("diorama-workspace", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("snapshots");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async load(): Promise<Snapshot | undefined> {
    const db = await this.database();
    try {
      return await new Promise((resolve, reject) => {
        const r = db
          .transaction("snapshots")
          .objectStore("snapshots")
          .get("workspace");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  }
  async save(snapshot: Snapshot) {
    const db = await this.database();
    try {
      await new Promise<void>((resolve, reject) => {
        const t = db.transaction("snapshots", "readwrite");
        t.objectStore("snapshots").put(snapshot, "workspace");
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  }
  async clear() {
    const db = await this.database();
    try {
      await new Promise<void>((resolve, reject) => {
        const t = db.transaction("snapshots", "readwrite");
        t.objectStore("snapshots").clear();
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
      });
    } finally {
      db.close();
    }
  }
}
