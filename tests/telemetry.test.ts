import { describe, it, expect } from "vitest";
import { Kernel } from "../src/kernel/kernel";
import { Shell } from "../src/terminal/shell";
import { seed } from "../src/data/seed";
import {
  percentile,
  executionEvents,
  executionPids,
} from "../src/observability/telemetry";
import type { Compiler } from "../src/compiler/compiler";
import type { Vision } from "../src/vision/vision";

describe("observable execution and measured telemetry", () => {
  it("groups pipeline stages and real child task events under the entered command", async () => {
    const k = new Kernel();
    seed(k);
    const shell = new Shell(k, {} as Compiler, {} as Vision);
    await shell.execute('echo "red blue" > colors');
    const redirected = k.telemetry.commands.at(-1)!;
    expect(
      executionEvents(redirected, k.taskInfo(), k.telemetry.events).some(
        (e) => e.op === "fs.write" && e.args.includes("colors"),
      ),
    ).toBe(true);
    await shell.execute("cat colors | grep blue | wc -w");
    const run = k.telemetry.commands.at(-1)!;
    expect(run.label).toBe("cat colors | grep blue | wc -w");
    expect(run.roots).toHaveLength(3);
    const events = executionEvents(run, k.taskInfo(), k.telemetry.events);
    expect(events.filter((e) => e.op === "command.dispatch")).toHaveLength(3);
    expect(
      events.some((e) => e.op === "fs.read" && e.args.includes("colors")),
    ).toBe(true);
    expect(events.some((e) => e.op === "io.pipe")).toBe(true);
    const other = k.spawn("unrelated", "test");
    const parent = k.spawn("observed parent", "userspace");
    const nested = { ...run, roots: [parent.pid] };
    const child = k.spawn("actual child", "worker", parent.pid);
    k.trace(child.pid, "WASI", "fd_read");
    k.trace(other.pid, "WASI", "unrelated");
    const ids = executionPids(nested, k.taskInfo());
    expect(ids.has(child.pid)).toBe(true);
    expect(ids.has(other.pid)).toBe(false);
    expect(
      executionEvents(nested, k.taskInfo(), k.telemetry.events).some(
        (e) => e.op === "unrelated",
      ),
    ).toBe(false);
    expect(run.exitCode).toBe(0);
    expect(run.ended).toBeGreaterThanOrEqual(run.created);
  });
  it("excludes inspector requests from ABI activity and reads actual growing WASM memory", () => {
    const k = new Kernel(),
      t = k.telemetry;
    t.sample(1000);
    k.core.exports.memory.grow(1);
    // Controlled wall-time inputs verify rate units independently of machine speed.
    t.recordCall("kernel.info", 90);
    t.recordCall("trace.list", 90);
    t.recordCall("task.list", 90);
    t.recordCall("fs.write", 2);
    t.recordCall("fs.read", 3);
    t.sample(2000);
    const last = t.samples.at(-1)!;
    expect(last.abiCalls).toBe(2);
    expect(last.abiMs).toBe(5);
    expect(last.kernelBytes).toBe(k.core.exports.memory.buffer.byteLength);
    expect(last.kernelBytes - t.samples[0].kernelBytes).toBe(65536);
    t.recordCall("fs.read", 1);
    t.sample(5000);
    expect(t.samples.at(-1)?.visibilityGap).toBe(true);
    expect(t.samples.at(-1)?.abiCalls).toBe(0);
    t.sample(40000);
    expect(t.samples).toHaveLength(1);
  });
  it("retains actual model/backend metadata, rejects invalid timings and bounds histories", () => {
    const k = new Kernel(),
      t = k.telemetry;
    t.adapter = {
      vendor: "measured device",
      architecture: "device",
      description: "",
      fallback: false,
      timestampQuery: false,
    };
    const point = {
      pid: 2,
      model: "actual model",
      backend: "webgpu",
      preprocess: 1,
      inference: 10,
      postprocess: 2,
      pipeline: 15,
      objects: 3,
    };
    t.recordInference(point);
    t.adapter = undefined;
    expect(t.inferences[0].adapter?.vendor).toBe("measured device");
    t.recordInference({ ...point, inference: NaN });
    expect(t.inferences).toHaveLength(1);
    t.recording = false;
    t.recordInference(point);
    expect(t.inferences).toHaveLength(1);
    t.recording = true;
    for (let i = 0; i < 160; i++)
      t.recordInference({ ...point, backend: "cpu", inference: i });
    expect(t.inferences).toHaveLength(120);
    const output = JSON.parse(t.export());
    expect(output.inferences.at(-1).backend).toBe("cpu");
    expect(output.metrics).toContain("not GPU utilization");
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([40, 10, 30, 20], 0.5)).toBe(20);
    expect(percentile([40, 10, 30, 20], 0.95)).toBe(40);
  });
});
