import { useEffect, useState, useSyncExternalStore } from "react";
import { kernel, vision, compiler } from "../app/machine";
import {
  executionEvents,
  executionPids,
  layerDefinitions,
  layerFor,
  percentile,
  type Execution,
  type Sample,
} from "./telemetry";
import type { TraceEvent } from "../kernel/kernel";
import "./observatory.css";
const telemetry = kernel.telemetry;
export function useTelemetry() {
  useSyncExternalStore(
    telemetry.subscribe,
    telemetry.snapshot,
    telemetry.snapshot,
  );
  return telemetry;
}
const ms = (value: number | null | undefined) =>
  value == null
    ? "—"
    : value < 1
      ? value.toFixed(2)
      : value < 100
        ? value.toFixed(1)
        : Math.round(value).toLocaleString();
const mib = (value: number) => (value / 1048576).toFixed(2);
const colorFor = (layer: string) =>
  layerDefinitions.find((l) => l.id === layer)?.color || "#a7bdba";
function useExecution() {
  useTelemetry();
  const [choice, choose] = useState("latest");
  const runs = telemetry.executions();
  const run = runs.find((r) => r.id === choice) || runs[0];
  const events = run
    ? executionEvents(run, telemetry.tasks, telemetry.events)
    : [];
  return { choice, choose, runs, run, events };
}
function RunPicker({
  state,
  label,
}: {
  state: ReturnType<typeof useExecution>;
  label: string;
}) {
  return (
    <label className="obs-run-picker">
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        value={state.choice === "latest" ? "latest" : state.run?.id || "latest"}
        onChange={(e) => state.choose(e.target.value)}
      >
        <option value="latest">Follow latest execution</option>
        {state.runs.map((r) => (
          <option key={r.id} value={r.id}>
            {r.ended === undefined ? "● " : ""}
            {r.label.slice(0, 90)}
          </option>
        ))}
      </select>
    </label>
  );
}
function LayerPath({
  events,
  current,
  live,
  compact = false,
  onSelect,
}: {
  events: TraceEvent[];
  current?: TraceEvent;
  live: boolean;
  compact?: boolean;
  onSelect?: (event: TraceEvent) => void;
}) {
  const visible = layerDefinitions.filter((l) =>
    events.some((e) => layerFor(e) === l.id),
  );
  const nodes = visible.length
    ? visible
    : layerDefinitions.filter((l) =>
        ["shell", "kernel", "WASM", "WASI", "filesystem"].includes(l.id),
      );
  return (
    <div
      className={`obs-layer-path ${compact ? "compact" : ""}`}
      aria-label="Observed subsystem path"
    >
      {nodes.map((l, i) => {
        const items = events.filter((e) => layerFor(e) === l.id),
          last = items.at(-1);
        const selected = current && layerFor(current) === l.id;
        const Card = compact ? "div" : "button";
        return (
          <div
            className={`obs-layer ${last ? "visited" : "unvisited"} ${selected ? "current" : ""} ${selected && live ? "pulsing" : ""}`}
            style={{ "--layer-color": l.color } as React.CSSProperties}
            key={l.id}
          >
            <span className="obs-bus">
              <i />
              {i < nodes.length - 1 && <b />}
            </span>
            <Card
              className="obs-layer-card"
              {...(!compact ? { disabled: !last || !onSelect } : {})}
              onClick={compact ? undefined : () => last && onSelect?.(last)}
              title={
                last ? `${last.op} · ${last.args}` : "No execution recorded"
              }
            >
              <span className="obs-layer-index">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="obs-layer-name">
                <strong>{l.title}</strong>
                <small>{compact ? last?.op || l.sub : l.sub}</small>
              </span>
              <span className="obs-layer-count">
                {last ? items.length.toString().padStart(2, "0") : "—"}
                <small>{last ? "events" : "idle"}</small>
              </span>
            </Card>
          </div>
        );
      })}
    </div>
  );
}
export function ExecutionRail({ open }: { open: () => void }) {
  const state = useExecution(),
    { run, events } = state;
  const last = events.at(-1),
    active = run?.ended === undefined && !!run;
  return (
    <aside className="execution-rail obs-surface">
      <div className="obs-eyebrow">
        <span className={`obs-status-dot ${active ? "active" : ""}`} />{" "}
        EXECUTION LAYERS <span>{active ? "LIVE" : "OBSERVED"}</span>
      </div>
      <h3>Follow the command.</h3>
      <RunPicker state={state} label="Terminal execution history" />
      <div className="obs-command">
        <span>$</span>
        <code>{run?.label || "Waiting for your first command"}</code>
      </div>
      <LayerPath events={events} current={last} live={active} compact />
      <div className="obs-rail-bottom">
        <span>
          {run
            ? active
              ? "In progress"
              : `exit ${run.exitCode ?? "—"} · ${ms((run.ended || performance.now()) - run.created)} ms`
            : "Real task and syscall events"}
        </span>
        <span>{events.length} events</span>
      </div>
      <button className="obs-open" onClick={open}>
        Open observatory <span>↗</span>
      </button>
    </aside>
  );
}
function Timeline({
  run,
  events,
  selected,
  select,
  onSelectTask,
}: {
  run?: Execution;
  events: TraceEvent[];
  selected?: TraceEvent;
  select: (e: TraceEvent) => void;
  onSelectTask?: (pid: number) => void;
}) {
  const pids = run ? executionPids(run, telemetry.tasks) : new Set<number>();
  const tasks = telemetry.tasks
    .filter((t) => pids.has(t.pid))
    .sort((a, b) => a.created - b.created);
  const started = run?.created || 0,
    end = run?.ended || performance.now(),
    duration = Math.max(0.01, end - started);
  const origin = kernel.started;
  return (
    <div className="obs-timeline">
      <div className="obs-plot-heading">
        <span>PROCESS / WORKER LIFETIMES</span>
        <span>{run ? `${ms(duration)} ms` : "No samples"}</span>
      </div>
      <div className="obs-time-axis">
        <span>0</span>
        <span>{run ? ms(duration / 2) : "—"}</span>
        <span>{run ? ms(duration) : "—"} ms</span>
      </div>
      {tasks.length ? (
        tasks.map((t) => {
          const parent = tasks.find((p) => p.pid === t.ppid),
            left = Math.max(0, ((t.created - started) / duration) * 100),
            width = Math.max(
              0.5,
              Math.min(
                100 - left,
                (((t.ended || end) - t.created) / duration) * 100,
              ),
            );
          return (
            <div className="obs-time-row" key={t.pid}>
              <button
                className="obs-task-label"
                onClick={() => onSelectTask?.(t.pid)}
                title={`PID ${t.pid} · parent ${t.ppid} · ${t.state}`}
              >
                <span>
                  {parent ? "↳ " : ""}
                  {t.pid}
                </span>
                <b>{t.name}</b>
              </button>
              <div className="obs-time-track">
                <button
                  className={`obs-task-span ${t.ended === undefined ? "running" : ""} ${t.exitCode ? "unsuccessful" : ""}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  onClick={() => onSelectTask?.(t.pid)}
                  aria-label={`Inspect PID ${t.pid}, ${t.name}`}
                  title={`${t.state} · ${ms((t.ended || end) - t.created)} ms`}
                />
              </div>
            </div>
          );
        })
      ) : (
        <div className="obs-timeline-empty">
          Execute a command to see its task tree and measured lifetimes.
        </div>
      )}
      <div className="obs-event-heading">
        EVENT SEQUENCE <span>select a boundary to inspect</span>
      </div>
      <div
        className="obs-event-track"
        role="group"
        aria-label="Recorded execution events"
      >
        {events.slice(-120).map((e) => (
          <button
            key={e.id}
            className={selected?.id === e.id ? "selected" : ""}
            style={
              { "--event-color": colorFor(layerFor(e)) } as React.CSSProperties
            }
            onClick={() => select(e)}
            title={`${e.op} · PID ${e.pid} · +${ms(Math.max(0, e.time + origin - started))} ms`}
            aria-label={`Inspect event ${e.id}: ${e.op}`}
          />
        ))}
        {!events.length && <span>Trace appears here as the machine runs.</span>}
      </div>
      <div className="obs-event-detail">
        <span className="obs-detail-label">
          {selected
            ? `PID ${selected.pid} / ${selected.layer.toUpperCase()}`
            : "BOUNDARY DETAIL"}
        </span>
        <code>{selected?.op || "No execution selected"}</code>
        <p>
          {selected?.args ||
            "Use the terminal, compiler, or vision lab. Every path comes from this machine's actual events."}
        </p>
        {selected && (
          <div>
            <span>
              return <b>{selected.result}</b>
            </span>
            <span>
              {selected.duration > 0
                ? `${ms(selected.duration)} ms wall time`
                : "instant event"}
            </span>
          </div>
        )}
      </div>
      <p className="obs-caption">
        Task nesting and recorded syscall boundaries. C function stacks are not
        sampled. Bars show elapsed lifetime, including waits.
      </p>
    </div>
  );
}
export function ExecutionExplorer({
  onSelectTask,
}: {
  onSelectTask?: (pid: number) => void;
}) {
  const state = useExecution(),
    { run, events } = state;
  const [cursor, setCursor] = useState<number | null>(null),
    [playing, setPlaying] = useState(false);
  useEffect(() => {
    setCursor(null);
    setPlaying(false);
  }, [run?.id]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(
      () =>
        setCursor((c) => {
          const next = (c ?? -1) + 1;
          if (next >= events.length - 1) {
            setPlaying(false);
            return Math.max(0, events.length - 1);
          }
          return next;
        }),
      130,
    );
    return () => clearInterval(timer);
  }, [playing, events.length]);
  const index =
      cursor === null ? events.length - 1 : Math.min(cursor, events.length - 1),
    selected = events[index];
  const currentEvents = cursor === null ? events : events.slice(0, index + 1),
    active = !!run && run.ended === undefined;
  const select = (e: TraceEvent) => {
    setPlaying(false);
    setCursor(events.findIndex((item) => item.id === e.id));
  };
  return (
    <section
      className="execution-explorer obs-surface"
      aria-label="Execution observatory"
    >
      <header className="obs-header">
        <div>
          <p className="obs-eyebrow">
            <span
              className={`obs-status-dot ${active && cursor === null ? "active" : ""}`}
            />{" "}
            SYSTEM OBSERVATORY /{" "}
            {cursor === null
              ? state.choice === "latest"
                ? "LIVE FOLLOW"
                : "RECORDED EXECUTION"
              : "RECORDED REPLAY"}
          </p>
          <h2>Inside the execution.</h2>
        </div>
        <RunPicker state={state} label="Observed execution" />
      </header>
      <div className="obs-execution-title">
        <code>
          <span>$ </span>
          {run?.label || "Your next command starts here."}
        </code>
        <span className={run?.exitCode ? "obs-exit failed" : "obs-exit"}>
          {run ? (active ? "RUNNING" : `EXIT ${run.exitCode ?? "—"}`) : "IDLE"}
        </span>
      </div>
      <div className="obs-execution-grid">
        <div className="obs-stack-panel">
          <div className="obs-plot-heading">
            OBSERVED LAYERS <span>{events.length} boundaries</span>
          </div>
          <LayerPath
            events={currentEvents}
            current={selected}
            live={active && cursor === null}
            onSelect={select}
          />
          <p className="obs-caption">
            Only subsystems touched by this execution light up.
          </p>
        </div>
        <Timeline
          run={run}
          events={events}
          selected={selected}
          select={select}
          onSelectTask={onSelectTask}
        />
      </div>
      <div className="obs-playback">
        <button
          onClick={() => {
            if (playing) setPlaying(false);
            else {
              if (cursor === null || cursor >= events.length - 1) setCursor(0);
              setPlaying(true);
            }
          }}
          disabled={!events.length || active}
        >
          {playing ? "Pause replay" : "Replay execution"}
        </button>
        <input
          type="range"
          aria-label="Execution replay position"
          min={0}
          max={Math.max(0, events.length - 1)}
          value={Math.max(0, index)}
          disabled={!events.length}
          onChange={(e) => {
            setPlaying(false);
            setCursor(Number(e.target.value));
          }}
        />
        <span>
          {events.length ? index + 1 : 0} / {events.length}
        </span>
        <button
          onClick={() => {
            setPlaying(false);
            setCursor(null);
            state.choose("latest");
          }}
        >
          Live follow
        </button>
      </div>
    </section>
  );
}
type Series = { name: string; color: string; values: (number | null)[] };
function Sparkline({
  series,
  label,
  unit,
  floor = 0,
  gaps = [],
  times,
}: {
  series: Series[];
  label: string;
  unit: string;
  floor?: number;
  gaps?: boolean[];
  times?: number[];
}) {
  const width = 600,
    height = 110,
    all = series.flatMap((s) =>
      s.values.filter((v): v is number => v !== null && Number.isFinite(v)),
    ),
    max = Math.max(floor, ...all, 0.001);
  return (
    <div className="obs-chart">
      <div className="obs-chart-scale">
        <span>
          {ms(max)} {unit}
        </span>
        <span>0</span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        preserveAspectRatio="none"
      >
        {[0.15, 0.55, 0.95].map((y) => (
          <line
            key={y}
            x1={0}
            x2={width}
            y1={height * y}
            y2={height * y}
            className="obs-chart-grid"
          />
        ))}
        {series.map((s) => {
          let path = "",
            lastValid = false;
          s.values.forEach((v, i) => {
            if (v === null || !Number.isFinite(v) || gaps[i]) {
              lastValid = false;
              return;
            }
            const x = times
                ? Math.max(0, 1 - ((times.at(-1) || 0) - times[i]) / 30000) *
                  width
                : s.values.length > 1
                  ? (i / (s.values.length - 1)) * width
                  : width,
              y = height - 8 - (v / max) * (height - 20);
            path += `${lastValid ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)} `;
            lastValid = true;
          });
          const lastIndex =
            s.values
              .map((v, i) => (v !== null && Number.isFinite(v) ? i : -1))
              .filter((i) => i >= 0)
              .at(-1) ?? -1;
          const lastValue = s.values[lastIndex];
          const x = times
            ? Math.max(
                0,
                1 - ((times.at(-1) || 0) - (times[lastIndex] || 0)) / 30000,
              ) * width
            : width;
          return (
            <g key={s.name}>
              <path
                d={path}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
              {lastValue !== undefined && lastValue !== null && (
                <circle
                  cx={x}
                  cy={height - 8 - (lastValue / max) * (height - 20)}
                  r={3}
                  fill={s.color}
                />
              )}
            </g>
          );
        })}
        {!all.length && (
          <text
            x={width / 2}
            y={height / 2}
            textAnchor="middle"
            fill="#a5b7b3"
            fontSize={12}
          >
            Awaiting measured samples
          </text>
        )}
      </svg>
      <div className="obs-chart-legend">
        {series.map((s) => (
          <span key={s.name}>
            <i style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}
export function PerformanceMonitor() {
  useTelemetry();
  const samples = telemetry.samples,
    last = samples.at(-1),
    inference = telemetry.inferences.at(-1);
  const sameModel = telemetry.inferences.filter(
      (p) => p.backend === inference?.backend && p.model === inference?.model,
    ),
    p50 = percentile(
      sameModel.map((p) => p.inference),
      0.5,
    ),
    p95 = percentile(
      sameModel.map((p) => p.inference),
      0.95,
    );
  const recent = telemetry.inferences.filter(
      (p) => performance.now() - p.time <= 10000,
    ),
    rate =
      recent.length >= 2
        ? (recent.length - 1) / ((recent.at(-1)!.time - recent[0].time) / 1000)
        : null;
  const values = (f: (s: Sample) => number | null) => samples.map(f),
    gaps = samples.map((s) => s.visibilityGap);
  const download = () => {
    const blob = new Blob([telemetry.export()], { type: "application/json" }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "diorama-telemetry.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section
      className="obs-performance obs-surface"
      aria-label="Live performance monitor"
    >
      <header className="obs-header">
        <div>
          <p className="obs-eyebrow">
            <span
              className={`obs-status-dot ${telemetry.recording ? "active" : ""}`}
            />{" "}
            LIVE TELEMETRY / 4 HZ
          </p>
          <h2>The machine, measured.</h2>
        </div>
        <div className="obs-actions">
          <button onClick={() => telemetry.toggleRecording()}>
            {telemetry.recording ? "Pause charts" : "Resume charts"}
          </button>
          <button onClick={download}>Export JSON ↗</button>
        </div>
      </header>
      <div className="obs-metric-grid">
        <div className="obs-metric">
          <div className="obs-plot-heading">
            WASM LINEAR MEMORY <span>MiB</span>
          </div>
          <strong>
            {last ? mib(last.kernelBytes) : "—"}
            <small>kernel</small>
          </strong>
          <Sparkline
            label="Kernel and last observed guest WASM memory over time"
            unit="MiB"
            floor={2}
            gaps={gaps}
            times={samples.map((s) => s.time)}
            series={[
              {
                name: "Rust kernel",
                color: "#9ce7d3",
                values: values((s) => s.kernelBytes / 1048576),
              },
              {
                name: "Last guest",
                color: "#98c9ff",
                values: values((s) => s.guestBytes / 1048576),
              },
            ]}
          />
          <p className="obs-caption">
            Actual linear memory; guest value is the last observation. Limits:
            kernel 256 MiB / guest 64 MiB.
          </p>
        </div>
        <div className="obs-metric">
          <div className="obs-plot-heading">
            KERNEL ABI ACTIVITY <span>ms / s</span>
          </div>
          <strong>
            {ms(last?.abiCalls)}
            <small>calls / s</small>
          </strong>
          <Sparkline
            label="Instrumented kernel ABI wall time per second"
            unit="ms/s"
            floor={1}
            gaps={gaps}
            times={samples.map((s) => s.time)}
            series={[
              {
                name: "ABI bridge wall time",
                color: "#c6b2f1",
                values: values((s) => s.abiMs),
              },
            ]}
          />
          <p className="obs-caption">
            Workload calls, including transport. Inspector reads excluded. This
            is not CPU utilization.
          </p>
        </div>
        <div className="obs-metric">
          <div className="obs-plot-heading">
            BROWSER FRAME INTERVAL <span>p95</span>
          </div>
          <strong>
            {ms(last?.frameGap)}
            <small>ms</small>
          </strong>
          <Sparkline
            label="Measured main-thread animation frame intervals"
            unit="ms"
            floor={20}
            gaps={gaps}
            times={samples.map((s) => s.time)}
            series={[
              {
                name: "Frame interval p95",
                color: "#ebcc92",
                values: values((s) => s.frameGap),
              },
            ]}
          />
          <p className="obs-caption">
            {telemetry.longTaskSupported
              ? `${samples.reduce((n, s) => n + (s.longTasks || 0), 0)} long tasks (>50 ms) in this window.`
              : "Long-task API unavailable."}{" "}
            Hidden-tab gaps are not connected.
          </p>
        </div>
      </div>
      <div className="obs-inference-grid">
        <div className="obs-inference-summary">
          <div className="obs-plot-heading">
            PERCEPTION ENGINE{" "}
            <span className="obs-backend">
              {vision.busy
                ? "PROCESSING"
                : vision.device === "not initialized"
                  ? "UNLOADED"
                  : vision.device.toUpperCase()}
            </span>
          </div>
          <h3>{inference?.model || "YOLO26 / on demand"}</h3>
          <div className="obs-inference-numbers">
            <div>
              <b>{ms(p50)}</b>
              <span>p50 ms</span>
            </div>
            <div>
              <b>{ms(p95)}</b>
              <span>p95 ms</span>
            </div>
            <div>
              <b>{rate === null ? "—" : rate.toFixed(1)}</b>
              <span>completed / s</span>
            </div>
          </div>
          <p className="obs-caption">
            {sameModel.length} observations for this model + backend.{" "}
            {inference?.adapter
              ? `${inference.adapter.vendor} ${inference.adapter.architecture} ${inference.adapter.description}${inference.adapter.fallback ? " · software fallback" : ""}`
              : inference?.backend === "cpu"
                ? "CPU / single-threaded WASM backend."
                : "GPU device information appears after WebGPU initializes."}
          </p>
          <p className="obs-caption">
            {vision.busy
              ? vision.status
              : "Run detection or camera capture in Vision Lab to record inference."}{" "}
            GPU utilization and VRAM are not exposed by this monitor.
          </p>
        </div>
        <div className="obs-inference-chart">
          <div className="obs-plot-heading">
            INFERENCE LATENCY{" "}
            <span>{inference?.backend.toUpperCase() || "NO BACKEND"} / ms</span>
          </div>
          <Sparkline
            label="Measured inference latency for the current model and backend"
            unit="ms"
            series={[
              {
                name: "ONNX backend wall time",
                color: "#f3b89e",
                values: sameModel.map((p) => p.inference),
              },
            ]}
          />
          {inference && (
            <div className="obs-stage-proportions" aria-hidden="true">
              {[
                inference.preprocess,
                inference.inference,
                inference.postprocess,
              ].map((value, i) => (
                <span
                  key={i}
                  style={{
                    flexGrow: value,
                    background: ["#9ce7d3", "#f3b89e", "#c6b2f1"][i],
                  }}
                />
              ))}
            </div>
          )}
          <div
            className="obs-stage-bar"
            aria-label="Last measured prediction stages"
          >
            {inference ? (
              [
                {
                  name: "Preprocess",
                  value: inference.preprocess,
                  color: "#9ce7d3",
                },
                {
                  name: "Inference",
                  value: inference.inference,
                  color: "#f3b89e",
                },
                {
                  name: "Postprocess",
                  value: inference.postprocess,
                  color: "#c6b2f1",
                },
              ].map((s) => (
                <div
                  key={s.name}
                  style={{
                    flex: 1,
                    borderColor: s.color,
                  }}
                >
                  <span>{s.name}</span>
                  <b>{ms(s.value)} ms</b>
                </div>
              ))
            ) : (
              <p className="obs-caption">
                No inference has run. Models remain unloaded.
              </p>
            )}
          </div>
          <p className="obs-caption">
            Backend timings include submission and synchronization; they are not
            GPU timestamp queries. Latest worker pipeline:{" "}
            {ms(inference?.pipeline)} ms.
          </p>
        </div>
      </div>
      <div className="obs-performance-footer">
        <span>
          {samples.length} / 120 samples · 30 s rolling window ·{" "}
          {telemetry.recording ? "recording" : "charts paused"}
        </span>
        <span>
          Last compile {ms(compiler.lastCompileMs)} ms · guest{" "}
          {ms(compiler.lastRunMs)} ms
        </span>
      </div>
    </section>
  );
}
