import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { FileSystem, resolvePath, SnapshotStore } from "../src/fs/filesystem";
import { Kernel } from "../src/kernel/kernel";
import { Shell } from "../src/terminal/shell";
import { parse } from "../src/terminal/parser";
import { validateMemory } from "../src/compiler/wasm";
import { seed } from "../src/data/seed";
import type { Compiler } from "../src/compiler/compiler";
import type { Vision } from "../src/vision/vision";
describe("virtual filesystem", () => {
  let fs: FileSystem;
  beforeEach(() => {
    fs = new FileSystem();
    fs.mkdir("/home/visitor", true);
  });
  it("normalizes traversal and maintains real bytes", () => {
    expect(resolvePath("../../tmp/a", "/home/visitor")).toBe("/tmp/a");
    fs.write("/home/visitor/a", "hello");
    fs.write("/home/visitor/a", " world", true);
    expect(fs.text("/home/visitor/a")).toBe("hello world");
    const data = fs.read("/home/visitor/a");
    data[0] = 0;
    expect(fs.text("/home/visitor/a")).toBe("hello world");
  });
  it("copies, renames, and removes directory subtrees", () => {
    fs.mkdir("/home/visitor/a/b", true);
    fs.write("/home/visitor/a/b/n", "value");
    fs.copy("/home/visitor/a", "/home/visitor/c", true);
    fs.move("/home/visitor/c", "/home/visitor/d");
    expect(fs.text("/home/visitor/d/b/n")).toBe("value");
    expect(() => fs.remove("/home/visitor/a")).toThrow("not empty");
    fs.remove("/home/visitor/a", true);
    expect(fs.exists("/home/visitor/a/b")).toBe(false);
    expect(() => fs.copy("/home/visitor/d", "/home/visitor/d/e", true)).toThrow(
      "into itself",
    );
  });
  it("restores snapshots atomically and denies read-only proc writes", () => {
    fs.write("/home/visitor/n", "original");
    const snapshot = fs.snapshot();
    fs.write("/home/visitor/n", "changed");
    fs.restore(snapshot);
    expect(fs.text("/home/visitor/n")).toBe("original");
    expect(() =>
      fs.restore({
        version: 1,
        entries: [
          ["/", { kind: "dir", mtime: 0 }],
          ["/orphan/n", { kind: "file", mtime: 0 }],
        ],
      }),
    ).toThrow("parent");
    expect(fs.text("/home/visitor/n")).toBe("original");
    fs.mkdir("/proc", true, true);
    fs.write("/proc/n", "state", false, true);
    expect(() => fs.write("/proc/n", "other")).toThrow("read-only");
  });
  it("persists binary snapshots across IndexedDB connections", async () => {
    const store = new SnapshotStore();
    await store.clear();
    fs.write("/home/visitor/a", new Uint8Array([0, 255, 1]));
    await store.save(fs.snapshot());
    const other = new FileSystem();
    other.restore((await new SnapshotStore().load())!);
    expect([...other.read("/home/visitor/a")]).toEqual([0, 255, 1]);
    await store.clear();
    expect(await store.load()).toBeUndefined();
  });
  it("enforces file and workspace limits", () => {
    expect(() =>
      fs.write("/home/visitor/a", new Uint8Array(8 * 1024 * 1024 + 1)),
    ).toThrow("8 MiB");
    fs.maxBytes = 4;
    expect(() => fs.write("/home/visitor/a", "12345")).toThrow("32 MiB");
  });
});
describe("kernel contracts", () => {
  it("tracks descriptors, offsets, caller events, and task cleanup", () => {
    const k = new Kernel();
    seed(k);
    k.fs.write("/tmp/x", "abcd");
    const t = k.spawn("reader");
    k.state(t, "running");
    const fd = k.open(t.pid, "/tmp/x", "rw");
    expect(new TextDecoder().decode(k.read(t.pid, fd, 2))).toBe("ab");
    k.write(t.pid, fd, new TextEncoder().encode("XY"));
    expect(k.fs.text("/tmp/x")).toBe("abXY");
    k.close(t.pid, fd);
    k.finish(t, 7);
    expect(k.tasks.get(t.pid)?.exitCode).toBe(7);
    expect(k.fds.some((f) => f.pid === t.pid)).toBe(false);
    expect(k.events.some((e) => e.op === "fd.read" && e.pid === t.pid)).toBe(
      true,
    );
    expect(
      JSON.parse(k.fs.text("/proc/tasks")).some(
        (p: { pid: number }) => p.pid === t.pid,
      ),
    ).toBe(true);
  });
  it("cancels child tasks and preserves the shell", () => {
    const k = new Kernel(),
      p = k.spawn("pipeline"),
      child = k.spawn("worker", "wasm guest", p.pid);
    k.cancel(p.pid);
    expect(child.controller.signal.aborted).toBe(true);
    expect(p.state).toBe("cancelled");
    expect(k.tasks.get(1)?.state).toBe("waiting");
    expect(() => k.cancel(1)).toThrow("cancellable");
  });
  it("cooperatively yields before dispatch, records failure exit, and caps event history", async () => {
    const k = new Kernel();
    const order: string[] = [];
    const p = k.run("job", "test", () => {
      order.push("job");
      throw Error("failure");
    });
    order.push("caller");
    await expect(p).rejects.toThrow("failure");
    expect(order).toEqual(["caller", "job"]);
    expect(k.tasks.get(2)?.exitCode).toBe(1);
    for (let i = 0; i < 600; i++) k.trace(1, "test", "event");
    expect(k.events).toHaveLength(500);
  });
});
describe("shell parser and streams", () => {
  it("distinguishes quoted operators, empty arguments, and variables", () => {
    const p = parse(`echo "a | b" '' '$HOME' "$HOME" > out`, {
      HOME: "/home/visitor",
    });
    expect(p[0].args).toEqual(["echo", "a | b", "", "$HOME", "/home/visitor"]);
    expect(p[0].output).toBe("out");
    expect(() => parse('echo "unterminated', {})).toThrow("quote");
    expect(() => parse("echo a && pwd", {})).toThrow("unsupported");
    expect(() => parse("cat |", {})).toThrow("command");
  });
  it("runs actual utilities over the shared filesystem and pipe buffers", async () => {
    const k = new Kernel();
    seed(k);
    const shell = new Shell(k, {} as Compiler, {} as Vision);
    expect((await shell.execute('echo "red blue" > colors')).code).toBe(0);
    await shell.execute('echo "green" >> colors');
    const r = await shell.execute("cat colors | grep blue | wc -w");
    expect(r.stdout).toBe("2\n");
    expect(k.fs.text("/home/visitor/colors")).toBe("red blue\ngreen\n");
    expect((await shell.execute("cat < colors")).stdout).toContain("green");
    expect((await shell.execute("cat missing 2> errors")).stderr).toBe("");
    expect(k.fs.text("/home/visitor/errors")).toContain("no such file");
    expect(k.events.some((e) => e.op === "io.pipe")).toBe(true);
    await shell.execute('export TEST="a b"');
    expect((await shell.execute('echo "$TEST"')).stdout).toBe("a b\n");
  });
  it("interrupts a waiting command", async () => {
    const k = new Kernel();
    seed(k);
    const shell = new Shell(k, {} as Compiler, {} as Vision);
    const pending = shell.execute("sleep 10");
    await new Promise((r) => setTimeout(r, 20));
    shell.cancel();
    expect((await pending).code).toBe(130);
    expect(shell.busy).toBe(false);
  });
});
describe("guest memory contract", () => {
  it("requires a bounded defined WASM memory", () => {
    const header = [0, 97, 115, 109, 1, 0, 0, 0];
    expect(() =>
      validateMemory(Uint8Array.from([...header, 5, 5, 1, 1, 1, 128, 8])),
    ).not.toThrow();
    expect(() =>
      validateMemory(Uint8Array.from([...header, 5, 3, 1, 0, 1])),
    ).toThrow("maximum");
    expect(() => validateMemory(Uint8Array.from(header))).toThrow(
      "exactly one",
    );
  });
});
