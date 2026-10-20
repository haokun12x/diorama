# Execution observatory

The terminal's side panel follows the latest command through the subsystems it actually touched. Open **Kernel**, or **Open observatory**, for the complete instrument view. All original kernel internals remain available in the expandable **Runtime-managed tasks** section. Selecting a task lifetime opens its native process record.

## Follow and replay

Each entered shell line gets a session observation record. Pipeline stages remain grouped under that line, while Rust PIDs and parent PIDs identify the actual tasks and child workers. Compiler and vision actions launched directly from their views also appear in execution history. Select an earlier execution or follow the latest one.

The colored layers summarize recorded subsystem boundaries; they do not assert a C function call stack. The event sequence preserves receipt order and exposes operation, PID, arguments, return value, and measured duration. Worker timestamps are not subtracted from the main thread's clock. Task lifetime bars use native task creation/end times on the main thread clock and include waiting, downloads, and transport. An instant boundary has no invented duration. Replay advances through those recorded events at a presentation speed of 130 ms per event; it does not re-execute the command or claim that this was the original execution speed. The slider supports keyboard operation. Reduced-motion preferences disable the live pulse.

Guest Rust filesystem events are forwarded alongside real WASI boundary records, within the existing 300-call guest trace limit. Shell input, output, and stderr redirects execute under their actual command PID. Observation history is bounded to 4,000 events, 40 command lines, and the kernel's current task history. Older executions may have incomplete history after eviction. The authoritative Rust trace retains its separate 500-event bound.

## Live metrics

The monitor collects at most 120 observations at 4 Hz over a 30-second window. Background tabs suspend collection and animation-frame sampling. Resuming produces a discontinuity rather than a line interpolated through unobserved time. Pause charts also stops recording new inference observations; execution history continues. JSON export includes actual samples, model/backend-specific inference observations, clock origins, adapter metadata, task records, and retained events. The file is downloaded locally and never uploaded by the monitor.

| Instrument | Measurement and boundary |
|---|---|
| Rust kernel memory | Actual `WebAssembly.Memory.buffer.byteLength`, sampled on the main thread. This is committed linear memory, not live allocations or the JS heap. |
| Last guest memory | Actual guest memory observed at instantiation, WASI boundaries, or exit. A synchronous guest without host calls cannot be continuously inspected across its worker boundary. |
| Kernel ABI activity | Calls/s and wall ms/s around the native bridge, including metadata/buffer transport and observer overhead. Inspector queries and trace bookkeeping are excluded. This is not CPU utilization. |
| Browser frame interval | Nearest-rank p95 of actual requestAnimationFrame intervals between sample boundaries. It measures main-thread scheduling, not guest instruction throughput or GPU utilization. |
| Long tasks | PerformanceObserver long-task entries (>50 ms), if supported. Unsupported measurements are identified rather than replaced with fabricated values. |
| Perception latency | Actual official model preprocess, inference, postprocess, and worker-pipeline wall times. p50/p95 and the plot are grouped by the same model and backend. The rolling buffer holds 120 completed observations; small sample counts are displayed. |
| Completed/s | Completion intervals for observations within the last 10 seconds; requires at least two completions. This includes capture/dispatch overhead for camera frames and is not a theoretical GPU FPS calculation. |
| GPU identity | Metadata from the device actually used by ONNX Runtime, read after WebGPU session initialization. A software fallback is explicitly identified. CPU runs retain CPU labels even after a backend/model switch. |

ONNX backend wall times include submission and synchronization. The monitor does not collect GPU timestamp queries, GPU utilization percentages, or VRAM usage. Device information may be restricted by the browser; unavailable fields remain absent. The device metadata integration follows the official [ONNX Runtime WebGPU environment API](https://onnxruntime.ai/docs/api/js/interfaces/Env.WebGpuFlags.html).

The browser layer only observes execution. Files, task lifecycle, descriptors, permissions, and snapshots remain owned by the existing Rust/WebAssembly kernel. No monitoring library, remote collector, extra model, or preload of compiler/inference assets is required.

## Verification

`tests/telemetry.test.ts` exercises real shell pipeline grouping, child-PID isolation, redirection ownership, workload/inspector separation, memory growth, discontinuities, buffer limits, stable adapter metadata, invalid timings, and percentile calculation. `e2e/observatory.spec.ts` checks real WASI execution, layer visibility, task timelines, replay/slider controls, history selection, sampling pause/resume, JSON download, and mobile width. The real WebGPU acceptance case verifies that recorded inference timing and backend match the actual model result.
