export type Entry =
  | { kind: "file"; data: Uint8Array; mtime: number }
  | { kind: "dir"; mtime: number };
export type Snapshot = {
  version: 1;
  entries: [string, { kind: "dir" | "file"; data?: number[]; mtime: number }][];
};
export type FsEvent = (op: string, args: string, result: string) => void;
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
export class FileSystem {
  entries = new Map<string, Entry>([["/", { kind: "dir", mtime: Date.now() }]]);
  dynamic = new Map<string, () => string>();
  onEvent: FsEvent = () => {};
  onChange: () => void = () => {};
  revision = 0;
  maxBytes = 32 * 1024 * 1024;
  stat(path: string): Entry {
    const p = resolvePath(path);
    const n = this.entries.get(p);
    if (!n) throw Error(`${p}: no such file or directory`);
    return n;
  }
  exists(path: string) {
    return this.entries.has(resolvePath(path));
  }
  guard(path: string) {
    if (path === "/proc" || path.startsWith("/proc/"))
      throw Error(`${path}: read-only virtual mount`);
  }
  changed() {
    this.revision++;
    this.onChange();
  }
  mkdir(path: string, recursive = false, internal = false) {
    const p = resolvePath(path);
    if (!internal) this.guard(p);
    if (this.entries.has(p)) {
      if (recursive && this.stat(p).kind === "dir") return;
      throw Error(`${p}: already exists`);
    }
    if (!this.exists(parentPath(p))) {
      if (!recursive) throw Error(`${parentPath(p)}: no such directory`);
      this.mkdir(parentPath(p), true, internal);
    }
    if (this.stat(parentPath(p)).kind !== "dir")
      throw Error("parent is not a directory");
    this.entries.set(p, { kind: "dir", mtime: Date.now() });
    this.changed();
    this.onEvent("fs.mkdir", p, "0");
  }
  write(
    path: string,
    data: string | Uint8Array,
    append = false,
    internal = false,
  ) {
    const p = resolvePath(path);
    if (!internal) this.guard(p);
    if (this.stat(parentPath(p)).kind !== "dir")
      throw Error("parent is not a directory");
    if (this.entries.get(p)?.kind === "dir")
      throw Error(`${p}: is a directory`);
    const bytes =
      typeof data === "string" ? encoder.encode(data) : data.slice();
    let result = bytes;
    if (append && this.exists(p)) {
      const old = this.read(p);
      result = new Uint8Array(old.length + bytes.length);
      result.set(old);
      result.set(bytes, old.length);
    }
    if (result.length > 8 * 1024 * 1024)
      throw Error("file exceeds 8 MiB limit");
    const old = this.entries.get(p);
    const prior = old?.kind === "file" ? old.data.length : 0;
    if (this.bytes() - prior + result.length > this.maxBytes)
      throw Error("workspace exceeds 32 MiB limit");
    this.entries.set(p, { kind: "file", data: result, mtime: Date.now() });
    this.changed();
    this.onEvent(
      "fs.write",
      `${p}, ${result.length} bytes`,
      String(result.length),
    );
  }
  read(path: string) {
    const p = resolvePath(path);
    const n = this.stat(p);
    if (n.kind !== "file") throw Error(`${p}: is a directory`);
    const bytes = this.dynamic.has(p)
      ? encoder.encode(this.dynamic.get(p)!())
      : n.data.slice();
    this.onEvent("fs.read", p, String(bytes.length));
    return bytes;
  }
  text(path: string) {
    return decoder.decode(this.read(path));
  }
  list(path: string) {
    const p = resolvePath(path);
    if (this.stat(p).kind !== "dir") throw Error(`${p}: not a directory`);
    this.onEvent("fs.readdir", p, "0");
    return [...this.entries.keys()]
      .filter((k) => k !== p && parentPath(k) === p)
      .sort();
  }
  remove(path: string, recursive = false) {
    const p = resolvePath(path);
    this.guard(p);
    if (p === "/") throw Error("cannot remove root");
    const n = this.stat(p);
    const children = [...this.entries.keys()].filter((k) =>
      k.startsWith(p + "/"),
    );
    if (n.kind === "dir" && children.length && !recursive)
      throw Error(`${p}: directory not empty`);
    for (const k of [p, ...children]) this.entries.delete(k);
    this.changed();
    this.onEvent("fs.unlink", p, "0");
  }
  copy(from: string, to: string, recursive = false) {
    const a = resolvePath(from),
      b = resolvePath(to);
    if (b === a || b.startsWith(a + "/"))
      throw Error("cannot copy a path into itself");
    const n = this.stat(a);
    if (n.kind === "file") this.write(b, this.read(a));
    else {
      if (!recursive) throw Error("directory copy needs -r");
      this.mkdir(b, true);
      for (const c of this.list(a))
        this.copy(c, b + "/" + c.split("/").pop(), true);
    }
  }
  move(from: string, to: string) {
    const a = resolvePath(from),
      b = resolvePath(to);
    this.guard(a);
    this.guard(b);
    this.copy(a, b, true);
    this.remove(a, true);
    this.onEvent("fs.rename", `${a} → ${b}`, "0");
  }
  bytes() {
    let size = 0;
    for (const n of this.entries.values())
      if (n.kind === "file") size += n.data.length;
    return size;
  }
  snapshot(): Snapshot {
    return {
      version: 1,
      entries: [...this.entries]
        .filter(([p]) => p != "/proc" && !p.startsWith("/proc/"))
        .map(([p, n]) => [
          p,
          {
            kind: n.kind,
            mtime: n.mtime,
            ...(n.kind === "file" ? { data: Array.from(n.data) } : {}),
          },
        ]),
    };
  }
  restore(snapshot: Snapshot) {
    if (snapshot.version !== 1 || !Array.isArray(snapshot.entries))
      throw Error("unsupported snapshot");
    const restored = new Map<string, Entry>();
    let bytes = 0;
    for (const [p, n] of snapshot.entries) {
      if (p !== resolvePath(p) || p.startsWith("/proc/"))
        throw Error("invalid snapshot path");
      const data = Uint8Array.from(n.data || []);
      bytes += data.length;
      if (bytes > this.maxBytes) throw Error("snapshot exceeds limit");
      restored.set(
        p,
        n.kind === "dir"
          ? { kind: "dir", mtime: n.mtime }
          : { kind: "file", data, mtime: n.mtime },
      );
    }
    if (restored.get("/")?.kind !== "dir") throw Error("snapshot needs root");
    for (const p of restored.keys())
      if (p !== "/" && restored.get(parentPath(p))?.kind !== "dir")
        throw Error("snapshot parent missing");
    for (const [p, n] of this.entries)
      if (p === "/proc" || p.startsWith("/proc/")) restored.set(p, n);
    this.entries = restored;
    this.changed();
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
