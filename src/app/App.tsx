import { ExecutionRail } from "../observability/Observatory";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { kernel, compiler, vision, shell, persistence } from "./machine";
import { useMachine } from "../components/useMachine";
import { projects } from "../data/projects";
const TerminalView = lazy(() => import("../terminal/TerminalView"));
const KernelView = lazy(() => import("../kernel/KernelView"));
const CompilerView = lazy(() => import("../compiler/CompilerView"));
const VisionView = lazy(() => import("../vision/VisionView"));
const ProjectExplorer = lazy(() => import("../components/ProjectExplorer"));
const tabs = [
  "Terminal",
  "Kernel",
  "Compiler",
  "Vision Lab",
  "Projects",
] as const;
type Tab = (typeof tabs)[number];
const anatomy = [
  {
    name: "Presentation",
    detail: "Terminal, editor, inspector, and vision views share one runtime.",
    id: "Terminal" as Tab,
  },
  {
    name: "Userspace",
    detail:
      "A command parser, real utilities, and Clang compiled to WebAssembly.",
    id: "Compiler" as Tab,
  },
  {
    name: "Rust / WASM kernel",
    detail:
      "A Rust kernel owns tasks, descriptors, files, and system calls in WebAssembly.",
    id: "Kernel" as Tab,
  },
  {
    name: "Browser substrate",
    detail:
      "Dedicated workers, bounded WebAssembly, IndexedDB, and WebGPU or CPU inference.",
    id: "Vision Lab" as Tab,
  },
];
function MachineDrawing({ open }: { open: (t: Tab) => void }) {
  return (
    <div className="machine-drawing">
      <div className="drawing-caption">
        <span>FIG. 01</span>
        <span>A COMPUTER IN MINIATURE</span>
      </div>
      <svg
        viewBox="0 0 560 365"
        role="group"
        aria-label="Conceptual layers of the browser computer"
      >
        <defs>
          <pattern
            id="dots"
            width="20"
            height="20"
            patternUnits="userSpaceOnUse"
          >
            <circle cx="1" cy="1" r="0.6" fill="#b9b9a9" />
          </pattern>
        </defs>
        <rect width="560" height="365" fill="url(#dots)" />
        <g fill="none" stroke="#c6c8b7" strokeWidth="1">
          <path d="M50 290 285 159 520 290 285 421Z" />
          <path d="M285 55v272M66 171v118M504 171v118" strokeDasharray="4 6" />
        </g>
        <g
          className="iso-layer"
          onClick={() => open("Kernel")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              open("Kernel");
            }
          }}
          aria-label="Inspect virtual kernel"
        >
          <path
            d="m65 244 220-122 220 122-220 122Z"
            fill="#d6d9c7"
            stroke="#9fa48e"
          />
          <path d="m65 244 220 122 220-122v12L285 378 65 256Z" fill="#acb29a" />
          <path
            d="m112 243 173-94 173 94-173 96Z"
            fill="#c8cdb5"
            stroke="#959c84"
          />
          <g fill="none" stroke="#8d957b">
            <path d="m145 245 140-77 140 77-140 77Z" />
            <path d="m178 245 107-59 107 59-107 60Z" />
            <path d="M285 168v154M145 245h280" />
          </g>
        </g>
        <g
          className="iso-layer"
          onClick={() => open("Compiler")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              open("Compiler");
            }
          }}
          aria-label="Open compiler"
        >
          <path
            d="m65 185 220-122 220 122-220 122Z"
            fill="#edecdc"
            fillOpacity="0.94"
            stroke="#acae96"
          />
          <path d="m65 185 220 122 220-122v10L285 317 65 195Z" fill="#c3c4af" />
          <path
            d="m208 185 77-43 77 43-77 43Z"
            fill="#53634b"
            stroke="#394b31"
          />
          <path d="m208 185 77 43 77-43v9l-77 43-77-43Z" fill="#364a31" />
          <g fill="none" stroke="#879074">
            <path d="m123 188 62-34 30 16-62 35Z" />
            <path d="m157 218 62-34 30 16-62 35Z" />
            <path d="m340 167 33-18 70 39-33 18Z" />
            <path d="m313 182 33-18 70 39-33 18Z" />
          </g>
          <path d="m255 185 30-16 30 16-30 17Z" fill="#899775" />
        </g>
        <g
          className="iso-layer"
          onClick={() => open("Terminal")}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              open("Terminal");
            }
          }}
          aria-label="Open terminal"
        >
          <path
            d="m65 121 220-122 220 122-220 122Z"
            fill="#f5f3e9"
            fillOpacity="0.78"
            stroke="#adb198"
          />
          <path d="m65 121 220 122 220-122v6L285 249 65 127Z" fill="#d8dbc8" />
          <path
            d="m232 118 53-30 53 30-53 30Z"
            fill="#c27c5c"
            stroke="#a16c50"
          />
          <path d="m232 118 53 30 53-30v7l-53 30-53-30Z" fill="#966044" />
          <g fill="none" stroke="#ceaa90" strokeWidth="1.5">
            <path d="m253 118 32-18 32 18-32 18Z" />
            <path d="m263 118 22-12 22 12-22 12Z" />
          </g>
        </g>
        <g fontFamily="monospace" fontSize="10" fill="#646b58">
          <path d="M338 114h150" stroke="#a5a98f" />
          <text x="412" y="103">
            USERSPACE
          </text>
          <path d="M362 188h130" stroke="#8a967e" />
          <text x="418" y="176">
            WASM / WASI
          </text>
          <path d="M372 287h123" stroke="#8a967e" />
          <text x="417" y="276">
            VIRTUAL FS
          </text>
          <text x="24" y="342" fontSize="9">
            CONCEPTUAL STACK · CLICK A LAYER TO EXPLORE
          </text>
        </g>
      </svg>
      <div className="drawing-foot">
        <span>
          <i /> BROWSER-NATIVE COMPUTING
        </span>
        <span>NO SERVER REQUIRED</span>
      </div>
    </div>
  );
}
export function App() {
  useMachine();
  const [tab, setTab] = useState<Tab>("Terminal"),
    [visited, setVisited] = useState<Set<Tab>>(new Set(["Terminal"])),
    [layer, setLayer] = useState(0);
  const machine = useRef<HTMLElement>(null);
  const open = (next: Tab, scroll = true) => {
    setTab(next);
    setVisited((old) => new Set([...old, next]));
    if (scroll)
      machine.current?.scrollIntoView({
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "start",
      });
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        open("Terminal");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const command = (text: string) => {
    open("Terminal");
    setTimeout(
      () =>
        window.dispatchEvent(
          new CustomEvent("diorama-command", { detail: text }),
        ),
      200,
    );
  };
  return (
    <>
      <a className="skip-link" href="#machine">
        Skip to the computer
      </a>
      <header className="site-header">
        <a className="wordmark" href="#overview">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m12 2 10 5.5v9L12 22 2 16.5v-9Z M2 7.5 12 13l10-5.5 M12 13v9" />
          </svg>
          DIORAMA<span>by haokun12x</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#overview">Overview</a>
          <button onClick={() => open("Terminal")}>Terminal</button>
          <button onClick={() => open("Compiler")}>Compiler</button>
          <button onClick={() => open("Vision Lab")}>Vision Lab</button>
          <button onClick={() => open("Projects")}>Projects</button>
          <a href="#about">About</a>
        </nav>
        <a
          className="source-link"
          href="https://github.com/haokun12x/diorama"
          target="_blank"
          rel="noreferrer"
        >
          Source ↗
        </a>
      </header>
      <main>
        <section className="hero" id="overview">
          <div className="hero-copy">
            <p className="eyebrow">
              <span /> A SYSTEMS ENGINEERING EXPERIMENT
            </p>
            <h1>
              An Entire Computer,
              <br />
              Inside Your <em>Browser.</em>
            </h1>
            <p className="hero-description">
              A miniature computing environment. A Rust/WASM kernel, a real
              compiler, and neural perception — running at the edge of the web.
            </p>
            <div className="hero-actions">
              <button className="primary" onClick={() => open("Terminal")}>
                Explore the System <span>↗</span>
              </button>
              <button className="hero-secondary" onClick={() => open("Kernel")}>
                Inspect the Kernel <span>→</span>
              </button>
            </div>
            <p className="hero-note">
              A miniature computing world, built from first principles.
            </p>
          </div>
          <MachineDrawing open={open} />
        </section>
        <div className="capability-strip">
          <span>
            01 <b>VIRTUAL KERNEL</b> Real, inspectable state
          </span>
          <span>
            02 <b>CLANG → WASM</b> Compile in the browser
          </span>
          <span>
            03 <b>NEURAL PERCEPTION</b> YOLO26 on your device
          </span>
        </div>
        <section className="machine-section" id="machine" ref={machine}>
          <div className="section-heading">
            <div>
              <p className="micro">THE LIVE ENVIRONMENT</p>
              <h2>The system is the portfolio.</h2>
            </div>
            <div className="machine-heading-actions">
              <button className="text-button" onClick={() => open("Compiler")}>
                Compile Something ↗
              </button>
              <button
                className="text-button"
                onClick={() => open("Vision Lab")}
              >
                Open Vision Lab ↗
              </button>
            </div>
          </div>
          <div className={"workstation " + (tab === "Terminal" ? "dark" : "")}>
            <div className="workspace-toolbar">
              <div className="window-mark">
                <span />
                <span />
                <span />
              </div>
              <div
                role="tablist"
                aria-label="Computer views"
                className="workspace-tabs"
              >
                {tabs.map((t, i) => (
                  <button
                    key={t}
                    role="tab"
                    id={"tab-" + i}
                    aria-controls={"panel-" + i}
                    aria-selected={tab === t}
                    tabIndex={tab === t ? 0 : -1}
                    className={tab === t ? "active" : ""}
                    onClick={() => open(t, false)}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                        e.preventDefault();
                        const index =
                          (i +
                            (e.key === "ArrowRight" ? 1 : -1) +
                            tabs.length) %
                          tabs.length;
                        open(tabs[index], false);
                        document.getElementById("tab-" + index)?.focus();
                      }
                    }}
                  >
                    <span className="tab-icon" aria-hidden="true">
                      {[">_", "⊞", "{ }", "◉", "▱"][i]}
                    </span>
                    {t}
                  </button>
                ))}
              </div>
              <div className="runtime-indicator">
                <i /> Runtime ready
              </div>
            </div>
            {tabs.map((t, i) =>
              visited.has(t) ? (
                <div
                  key={t}
                  role="tabpanel"
                  id={"panel-" + i}
                  aria-labelledby={"tab-" + i}
                  hidden={tab !== t}
                >
                  <Suspense
                    fallback={
                      <div className="view-loading">
                        Loading {t.toLowerCase()}…
                      </div>
                    }
                  >
                    {t === "Terminal" ? (
                      <div className="terminal-layout">
                        <div>
                          <div className="terminal-title">
                            <span>visitor@diorama</span>
                            <span>
                              /home/visitor <small>· WASI preview1</small>
                            </span>
                          </div>
                          <TerminalView />
                          <div className="terminal-hints">
                            <span>TRY A COMMAND</span>
                            <button onClick={() => command("help")}>
                              help
                            </button>
                            <button onClick={() => command("ls projects")}>
                              ls projects
                            </button>
                            <button
                              onClick={() => command("cat /proc/runtime")}
                            >
                              cat /proc/runtime
                            </button>
                            <button onClick={() => command("trace show")}>
                              trace show
                            </button>
                          </div>
                        </div>
                        <ExecutionRail open={() => open("Kernel", false)} />
                      </div>
                    ) : t === "Kernel" ? (
                      <KernelView />
                    ) : t === "Compiler" ? (
                      <CompilerView />
                    ) : t === "Vision Lab" ? (
                      <VisionView />
                    ) : (
                      <ProjectExplorer />
                    )}
                  </Suspense>
                </div>
              ) : null,
            )}
            <div className="workspace-status">
              <span>
                <i /> {persistence}
              </span>
              <span>
                {tab === "Terminal"
                  ? "TAB autocomplete · ↑↓ history · Ctrl+C interrupt"
                  : "All views share the same virtual machine"}
              </span>
              <span>DIORAMA / 0.1</span>
            </div>
          </div>
        </section>
        <section className="architecture-section">
          <div className="architecture-copy">
            <p className="micro">SMALL MACHINE. REAL MECHANISMS.</p>
            <h2>
              Nothing behind
              <br />
              the curtain.
            </h2>
            <p>
              A kernel you can inspect. Programs you can change. Predictions you
              can measure. Every view opens onto the same miniature computing
              world.
            </p>
            <a
              className="text-button"
              href="https://github.com/haokun12x/diorama/blob/main/docs/ARCHITECTURE.md"
              target="_blank"
              rel="noreferrer"
            >
              Read the architecture ↗
            </a>
          </div>
          <div className="architecture-explorer">
            <div className="architecture-layers">
              {anatomy.map((a, i) => (
                <button
                  key={a.name}
                  className={layer === i ? "selected" : ""}
                  onClick={() => setLayer(i)}
                >
                  <span>0{i + 1}</span>
                  <b>{a.name}</b>
                  <span>↗</span>
                </button>
              ))}
            </div>
            <div className="architecture-detail">
              <p className="micro">
                LAYER 0{layer + 1} / {anatomy[layer].name.toUpperCase()}
              </p>
              <p>{anatomy[layer].detail}</p>
              <button
                className="text-button"
                onClick={() => open(anatomy[layer].id)}
              >
                Explore this layer →
              </button>
            </div>
          </div>
        </section>
        <section className="research-section" id="research">
          <div className="section-heading">
            <div>
              <p className="micro">SELECTED WORK / PUBLIC & INSPECTABLE</p>
              <h2>From the kernel to the model.</h2>
            </div>
            <a
              href="https://github.com/haokun12x"
              className="text-button"
              target="_blank"
              rel="noreferrer"
            >
              All repositories ↗
            </a>
          </div>
          <div className="research-list">
            {projects.map((p, i) => (
              <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
                <span className="project-number">0{i + 1}</span>
                <div>
                  <p className="micro">{p.category}</p>
                  <h3>{p.title}</h3>
                </div>
                <p>{p.summary}</p>
                <span className="project-arrow">↗</span>
              </a>
            ))}
          </div>
        </section>
        <section className="about-section" id="about">
          <div>
            <p className="micro">ABOUT THE ENGINEERING</p>
            <h2>
              Understanding systems
              <br />
              by building them.
            </h2>
          </div>
          <div>
            <p>
              This is haokun12x’s engineering homepage: an executable
              exploration of runtimes, compilers, GPU workloads, and efficient
              model inference.
            </p>
            <p>
              The linked work examines long-context attention, post-training
              infrastructure, and agent runtime contracts. DIORAMA brings those
              interests together in a computer small enough to understand.
            </p>
            <div className="about-links">
              <a
                href="https://github.com/haokun12x"
                target="_blank"
                rel="noreferrer"
              >
                GitHub ↗
              </a>
              <a
                href="https://github.com/haokun12x/diorama/issues"
                target="_blank"
                rel="noreferrer"
              >
                Get in touch ↗
              </a>
            </div>
          </div>
        </section>
      </main>
      <footer>
        <a className="wordmark" href="#overview">
          DIORAMA
        </a>
        <span>A miniature computing world. Open source under AGPL-3.0.</span>
        <a
          href="https://github.com/haokun12x/diorama/blob/main/docs/LIMITATIONS.md"
          target="_blank"
          rel="noreferrer"
        >
          What this machine implements ↗
        </a>
      </footer>
    </>
  );
}
