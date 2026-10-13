import { useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { cpp } from "@codemirror/lang-cpp";
import { kernel, compiler, shell } from "../app/machine";
import { samples } from "../data/samples";
import { useMachine } from "../components/useMachine";
export default function CompilerView() {
  useMachine();
  const host = useRef<HTMLDivElement>(null),
    editor = useRef<EditorView | null>(null);
  const [filename, setFilename] = useState("hello.c"),
    [flags, setFlags] = useState("-O2 -Wall"),
    [stdin, setStdin] = useState("hello from a pipe\n");
  const [output, setOutput] = useState(
      "Compile a source file to inspect the resulting module.",
    ),
    [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    const view = new EditorView({
      doc: kernel.fs.exists("/home/visitor/" + filename)
        ? kernel.fs.text("/home/visitor/" + filename)
        : "",
      extensions: [
        basicSetup,
        cpp(),
        EditorView.theme({
          "&": { background: "#f8f7f0", fontSize: "13px" },
          ".cm-content": {
            fontFamily: '"IBM Plex Mono", monospace',
            padding: "20px 0",
          },
          ".cm-gutters": {
            background: "#efeee5",
            color: "#999b8d",
            border: "none",
          },
          ".cm-scroller": { minHeight: "355px" },
          "&.cm-focused": { outline: "none" },
        }),
      ],
      parent: host.current!,
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, [filename]);
  const save = () => {
    const source = editor.current!.state.doc.toString();
    kernel.fs.write("/home/visitor/" + filename, source);
  };
  const compile = async () => {
    setWorking(true);
    setError("");
    abort.current = new AbortController();
    try {
      save();
      const result = await compiler.compile(
        "/home/visitor/" + filename,
        "/home/visitor/" + filename.replace(/\.c$/, ".wasm"),
        flags.trim().split(/\s+/).filter(Boolean),
        1,
        abort.current.signal,
      );
      setOutput(
        `Build complete. ${result.binary?.length.toLocaleString()} bytes of WebAssembly.\n${result.duration.toFixed(1)} ms (compiler initialization included).\n` +
          result.diagnostics,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
      abort.current = null;
    }
  };
  const run = async () => {
    setWorking(true);
    setError("");
    abort.current = new AbortController();
    try {
      const r = await compiler.execute(
        "/home/visitor/" + filename.replace(/\.c$/, ".wasm"),
        [],
        stdin,
        shell.cwd,
        shell.env,
        1,
        abort.current.signal,
      );
      setOutput(
        r.stdout +
          r.stderr +
          `\nProcess exited with code ${r.exitCode}. ${r.duration.toFixed(2)} ms.\nObserved linear memory: ${(r.memoryBytes / 1024).toFixed(0)} KiB.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
      abort.current = null;
    }
  };
  return (
    <div className="compiler-grid">
      <div className="source-pane">
        <div className="pane-title">
          <label>
            Source{" "}
            <select
              aria-label="C example"
              value={filename}
              disabled={working}
              onChange={(e) => setFilename(e.target.value)}
            >
              {Object.keys(samples).map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <button
            className="text-button"
            disabled={working}
            onClick={() => {
              save();
              setOutput("Source saved to /home/visitor/" + filename);
            }}
          >
            Save file ↗
          </button>
        </div>
        <div ref={host} className="code-editor" />
        <div className="compiler-controls">
          <label>
            Flags{" "}
            <input
              value={flags}
              onChange={(e) => setFlags(e.target.value)}
              disabled={working}
            />
          </label>
          <button
            className="primary small"
            onClick={compile}
            disabled={working}
          >
            Compile C → WASM
          </button>
          <button
            className="secondary small"
            onClick={run}
            disabled={
              working ||
              !kernel.fs.exists(
                "/home/visitor/" + filename.replace(/\.c$/, ".wasm"),
              )
            }
          >
            Run ↗
          </button>
          {working && (
            <button
              className="secondary small"
              onClick={() => abort.current?.abort()}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      <div className="build-pane">
        <p className="micro">BUILD & EXECUTION</p>
        <h3>{compiler.status}</h3>
        {working && (
          <div className="downloads">
            {[...compiler.progress].map(([name, p]) => (
              <div key={name}>
                <span>{name}</span>
                <span>
                  {(p.loaded / 1048576).toFixed(1)} MiB{" "}
                  {p.total ? " / " + (p.total / 1048576).toFixed(1) : ""}
                </span>
                <progress
                  max={p.total || 1}
                  value={p.total ? p.loaded : undefined}
                />
              </div>
            ))}
          </div>
        )}
        <pre
          className={error ? "diagnostics error" : "diagnostics"}
          aria-live="polite"
        >
          {error || output}
        </pre>
        <label className="stdin-label">
          Standard input
          <textarea
            value={stdin}
            onChange={(e) => setStdin(e.target.value)}
            rows={2}
          />
        </label>
        {compiler.lastInfo && (
          <details open>
            <summary>
              Module inspection · {compiler.lastInfo.bytes.toLocaleString()}{" "}
              bytes
            </summary>
            <p className="micro">IMPORTS / WASI PREVIEW 1</p>
            <div className="import-list">
              {compiler.lastInfo.imports.map((i) => (
                <code key={i.name}>{i.name}</code>
              ))}
            </div>
            <p className="micro">EXPORTS</p>
            <div className="import-list">
              {compiler.lastInfo.exports.map((i) => (
                <code key={i.name}>
                  {i.name} : {i.kind}
                </code>
              ))}
            </div>
          </details>
        )}
        <p className="fine">
          Clang & LLD execute as WebAssembly in an isolated worker. First use
          loads ~90 MiB of compiler artifacts. Your source stays in this
          browser.
        </p>
      </div>
    </div>
  );
}
