import { useState } from "react";
import { kernel, compiler } from "../app/machine";
import { useMachine } from "../components/useMachine";
const layers = [
  "shell",
  "scheduler",
  "kernel",
  "compiler",
  "WASM",
  "WASI",
  "filesystem",
  "vision",
  "storage",
];
export default function KernelView() {
  useMachine();
  const [filter, setFilter] = useState("all"),
    [selected, setSelected] = useState(1);
  const tasks = kernel.taskInfo(),
    events = kernel.events.filter(
      (e) => filter === "all" || e.layer === filter,
    );
  const task = tasks.find((t) => t.pid === selected);
  return (
    <div className="kernel-view">
      <div className="kernel-stats">
        {[
          ["TASKS", tasks.filter((t) => !t.ended).length + " active"],
          [
            "VIRTUAL FILESYSTEM",
            (kernel.fs.bytes() / 1024).toFixed(1) + " KiB",
          ],
          [
            "LAST GUEST MEMORY",
            compiler.memoryBytes
              ? (compiler.memoryBytes / 1024).toFixed(0) + " KiB"
              : "not instantiated",
          ],
          ["TRACE BUFFER", kernel.events.length + " / 500 events"],
        ].map(([name, value]) => (
          <div key={name}>
            <span className="micro">{name}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="kernel-columns">
        <section>
          <div className="pane-title">
            Runtime-managed tasks <span className="live-dot">live</span>
          </div>
          <div
            className="table-scroll"
            tabIndex={0}
            role="region"
            aria-label="Scrollable process table"
          >
            <table>
              <thead>
                <tr>
                  <th>PID</th>
                  <th>Task</th>
                  <th>State</th>
                  <th>Exit</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tasks
                  .slice(-16)
                  .reverse()
                  .map((t) => (
                    <tr
                      key={t.pid}
                      className={selected === t.pid ? "selected" : ""}
                    >
                      <td>
                        <button
                          className="text-button"
                          onClick={() => setSelected(t.pid)}
                        >
                          {t.pid}
                        </button>
                      </td>
                      <td>{t.name}</td>
                      <td>
                        <span className={"state " + t.state}>{t.state}</span>
                      </td>
                      <td>{t.exitCode ?? "—"}</td>
                      <td>
                        {t.pid !== 1 && !t.ended && (
                          <button
                            className="text-button"
                            onClick={() => kernel.cancel(t.pid)}
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="fine">
            {task
              ? `PID ${task.pid} · parent ${task.ppid} · ${task.kind} · observed memory ${task.memoryBytes.toLocaleString()} bytes`
              : ""}
          </p>
          <div className="scheduling">
            <p className="micro">TASK LIFECYCLE / measured wall time</p>
            {tasks
              .filter((t) => t.pid !== 1)
              .slice(-7)
              .map((t) => (
                <div key={t.pid}>
                  <code>
                    {t.pid} {t.name.slice(0, 18)}
                  </code>
                  <span
                    style={{
                      width:
                        Math.min(
                          100,
                          Math.max(
                            2,
                            ((t.ended || performance.now()) - t.created) / 100,
                          ),
                        ) + "%",
                    }}
                  />
                  <small>
                    {((t.ended || performance.now()) - t.created).toFixed(1)} ms
                  </small>
                </div>
              ))}
          </div>
        </section>
        <section className="memory-pane">
          <div className="pane-title">
            WASM linear memory <span className="micro">OBSERVED BYTES</span>
          </div>
          <div className="memory-grid">
            {Array.from({ length: 128 }, (_, i) => {
              const value =
                compiler.memoryPreview
                  .slice(i * 32, i * 32 + 32)
                  .reduce((sum, n) => sum + n, 0) / 32;
              return (
                <span
                  key={i}
                  title={`0x${(i * 32).toString(16).padStart(4, "0")} · mean byte ${value.toFixed(1)}`}
                  style={{
                    background: compiler.memoryPreview.length
                      ? `rgba(113,130,95,${0.1 + (value / 255) * 0.9})`
                      : "#e4e3d9",
                  }}
                />
              );
            })}
          </div>
          <p className="fine">
            First 4 KiB of the most recent guest's actual linear memory. Each
            cell averages 32 bytes. No guest has run until values appear. This
            is a byte preview, not an allocation map.
          </p>
          <details open>
            <summary>Open file descriptors · {kernel.fds.length}</summary>
            <div className="fd-list">
              {kernel.fds.map((d) => (
                <div key={d.pid + ":" + d.fd}>
                  <code>
                    {d.pid}:{d.fd}
                  </code>
                  <span>{d.path}</span>
                  <small>
                    {d.mode} · {d.offset}
                  </small>
                </div>
              ))}
            </div>
          </details>
          <details>
            <summary>
              Mounted filesystem · {kernel.fs.entries.size} nodes
            </summary>
            <pre className="fs-tree">
              {[...kernel.fs.entries.keys()].sort().join("\n")}
            </pre>
          </details>
        </section>
      </div>
      <section className="trace-pane">
        <div className="pane-title">
          <span>
            Execution trace <small>Shell → runtime → WASI → I/O</small>
          </span>
          <label>
            Layer{" "}
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">All layers</option>
              {layers.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
        </div>
        <div
          className="trace-scroll"
          tabIndex={0}
          role="region"
          aria-label="Scrollable execution trace"
        >
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>PID</th>
                <th>Layer / operation</th>
                <th>Arguments</th>
                <th>Result</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {events
                .slice(-80)
                .reverse()
                .map((e) => (
                  <tr key={e.id}>
                    <td>{e.time.toFixed(1)} ms</td>
                    <td>{e.pid}</td>
                    <td>
                      <span className="trace-layer">{e.layer}</span>{" "}
                      <code>{e.op}</code>
                    </td>
                    <td>{e.args}</td>
                    <td>{e.result}</td>
                    <td>{e.duration ? e.duration.toFixed(2) + " ms" : "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
