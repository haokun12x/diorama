import type { Kernel, TraceEvent, Task } from "../kernel/kernel";
export type TaskRow = Omit<Task, "controller">;
export type Execution = {
  id: string;
  label: string;
  roots: number[];
  created: number;
  ended?: number;
  exitCode?: number;
  source: string;
};
export type InferencePoint = {
  time: number;
  pid: number;
  model: string;
  backend: string;
  preprocess: number;
  inference: number;
  postprocess: number;
  pipeline: number;
  objects: number;
  adapter?: AdapterInfo;
};
export type Sample = {
  time: number;
  kernelBytes: number;
  guestBytes: number;
  active: number;
  abiCalls: number;
  abiMs: number;
  frameGap: number | null;
  longTasks: number | null;
  visibilityGap: boolean;
};
export type AdapterInfo = {
  vendor: string;
  architecture: string;
  description: string;
  fallback: boolean | null;
  timestampQuery: boolean;
};
const inspections = new Set([
  "kernel.info",
  "kernel.caller",
  "task.list",
  "task.memory",
  "trace.list",
  "trace.add",
  "fd.list",
  "fd.replace",
  "fs.version",
  "fs.inventory",
  "fs.bytes",
  "fs.exists",
  "fs.stat",
  "fs.peek",
  "fs.snapshot",
]);
export function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1))
  ];
}
export const layerDefinitions = [
  {
    id: "shell",
    title: "Shell",
    sub: "parse / pipe / redirect",
    color: "#c2d6bc",
  },
  {
    id: "kernel",
    title: "Rust kernel",
    sub: "task / syscall dispatch",
    color: "#9ce7d3",
  },
  {
    id: "compiler",
    title: "Clang / LLD",
    sub: "compiler worker",
    color: "#ebcc92",
  },
  {
    id: "WASM",
    title: "WebAssembly",
    sub: "isolated guest memory",
    color: "#98c9ff",
  },
  { id: "WASI", title: "WASI", sub: "system call boundary", color: "#c6b2f1" },
  {
    id: "vision",
    title: "ONNX inference",
    sub: "WebGPU / CPU WASM",
    color: "#f3b89e",
  },
  {
    id: "filesystem",
    title: "Virtual filesystem",
    sub: "shared binary state",
    color: "#bcd894",
  },
] as const;
export function layerFor(e: TraceEvent) {
  return e.layer === "scheduler" ? "kernel" : e.layer;
}
export function executionPids(run: Execution, tasks: TaskRow[]) {
  const ids = new Set(run.roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks)
      if (!ids.has(t.pid) && ids.has(t.ppid)) {
        ids.add(t.pid);
        changed = true;
      }
  }
  return ids;
}
export function executionEvents(
  run: Execution,
  tasks: TaskRow[],
  events: TraceEvent[],
) {
  const ids = executionPids(run, tasks);
  return events.filter((e) => ids.has(e.pid));
}
// Bounded browser observation data. The Rust kernel remains the authority for all system state.
export class Telemetry {
  events: TraceEvent[] = [];
  tasks: TaskRow[] = [];
  commands: Execution[] = [];
  samples: Sample[] = [];
  inferences: InferencePoint[] = [];
  adapter?: AdapterInfo;
  guestBytes = 0;
  revision = 0;
  recording = true;
  longTaskSupported = false;
  private listeners = new Set<() => void>();
  private sequence = 0;
  private pending?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private raf = 0;
  private observer?: PerformanceObserver;
  private callCount = 0;
  private callMs = 0;
  private longCount = 0;
  private gaps: number[] = [];
  private previousFrame?: number;
  private previousSample?: number;
  private discontinuity = true;
  constructor(private kernel: Kernel) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.revision;
  private emit() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  ingest(events: TraceEvent[]) {
    this.events.push(...events);
    if (this.events.length > 4000)
      this.events.splice(0, this.events.length - 4000);
    if (!this.pending && this.listeners.size)
      this.pending = setTimeout(() => {
        this.pending = undefined;
        this.refreshTasks();
        this.emit();
      }, 80);
  }
  private refreshTasks() {
    this.tasks = this.kernel.taskInfo();
  }
  recordCall(op: string, duration: number) {
    if (!inspections.has(op)) {
      this.callCount++;
      this.callMs += duration;
    }
  }
  beginCommand(label: string): Execution {
    const run: Execution = {
      id: `command-${++this.sequence}`,
      label,
      roots: [],
      created: performance.now(),
      source: "shell",
    };
    this.commands.push(run);
    if (this.commands.length > 40) this.commands.shift();
    return run;
  }
  link(run: Execution, pid: number) {
    run.roots.push(pid);
  }
  finishCommand(run: Execution, exitCode: number) {
    run.ended = performance.now();
    run.exitCode = exitCode;
    this.refreshTasks();
    this.emit();
  }
  executions(): Execution[] {
    const linked = new Set(this.commands.flatMap((r) => r.roots));
    return [
      ...this.commands,
      ...this.tasks
        .filter((t) => t.ppid === 1 && !linked.has(t.pid))
        .map((t) => ({
          id: `task-${t.pid}`,
          label: t.name,
          roots: [t.pid],
          created: t.created,
          ended: t.ended,
          exitCode: t.exitCode,
          source: t.kind,
        })),
    ]
      .sort((a, b) => b.created - a.created)
      .slice(0, 40);
  }
  recordInference(point: Omit<InferencePoint, "time">) {
    if (!this.recording) return;
    if (
      ![
        point.preprocess,
        point.inference,
        point.postprocess,
        point.pipeline,
      ].every((n) => Number.isFinite(n) && n >= 0)
    )
      return;
    this.inferences.push({
      ...point,
      adapter: this.adapter,
      time: performance.now(),
    });
    if (this.inferences.length > 120) this.inferences.shift();
    this.emit();
  }
  sample(time = performance.now()) {
    this.refreshTasks();
    const elapsed =
      this.previousSample === undefined
        ? 0
        : (time - this.previousSample) / 1000;
    const gap = this.discontinuity || elapsed > 2;
    this.samples.push({
      time,
      kernelBytes: this.kernel.core.exports.memory.buffer.byteLength,
      guestBytes: this.guestBytes,
      active: this.tasks.filter((t) => t.pid !== 1 && t.ended === undefined)
        .length,
      abiCalls: elapsed > 0 && !gap ? this.callCount / elapsed : 0,
      abiMs: elapsed > 0 && !gap ? this.callMs / elapsed : 0,
      frameGap: percentile(this.gaps, 0.95),
      longTasks: this.longTaskSupported ? this.longCount : null,
      visibilityGap: gap,
    });
    this.samples = this.samples.filter((s) => time - s.time <= 30000);
    if (this.samples.length > 120) this.samples.shift();
    this.previousSample = time;
    this.discontinuity = false;
    this.callCount = 0;
    this.callMs = 0;
    this.gaps = [];
    this.longCount = 0;
    this.emit();
  }
  private frame = (time: number) => {
    if (this.previousFrame !== undefined)
      this.gaps.push(time - this.previousFrame);
    this.previousFrame = time;
    this.raf = requestAnimationFrame(this.frame);
  };
  private visibility = () => {
    this.discontinuity = true;
    this.previousFrame = undefined;
    this.gaps = [];
    this.longCount = 0;
    this.callCount = 0;
    this.callMs = 0;
    cancelAnimationFrame(this.raf);
    if (document.visibilityState === "visible" && this.recording)
      this.raf = requestAnimationFrame(this.frame);
  };
  start() {
    if (this.interval || typeof document === "undefined") return;
    this.sample();
    this.visibility();
    this.interval = setInterval(() => {
      if (this.recording && document.visibilityState === "visible")
        this.sample();
    }, 250);
    document.addEventListener("visibilitychange", this.visibility);
    if (
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes?.includes("longtask")
    ) {
      this.longTaskSupported = true;
      this.observer = new PerformanceObserver((list) => {
        if (this.recording && document.visibilityState === "visible")
          this.longCount += list.getEntries().length;
      });
      this.observer.observe({ type: "longtask" });
    }
  }
  toggleRecording() {
    this.recording = !this.recording;
    this.visibility();
    this.emit();
  }
  stop() {
    clearInterval(this.interval);
    clearTimeout(this.pending);
    this.interval = undefined;
    this.pending = undefined;
    cancelAnimationFrame(this.raf);
    this.observer?.disconnect();
    document.removeEventListener("visibilitychange", this.visibility);
  }
  export() {
    return JSON.stringify(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        kernelStartedAt: this.kernel.started,
        browserTimeOrigin: performance.timeOrigin,
        clock: "performance.now milliseconds",
        metrics:
          "ABI bridge wall time excludes inspection calls; ONNX timings are backend wall time; not GPU utilization",
        samples: this.samples,
        inferences: this.inferences,
        adapter: this.adapter,
        commands: this.commands,
        tasks: this.tasks,
        events: this.events,
      },
      null,
      2,
    );
  }
}
