import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { kernel, shell, ready } from "../app/machine";
export default function TerminalView() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const term = new Terminal({
      fontFamily: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.6,
      cursorBlink: true,
      cursorStyle: "bar",
      convertEol: true,
      scrollback: 2000,
      theme: {
        background: "#20251f",
        foreground: "#dddcd0",
        cursor: "#d29473",
        selectionBackground: "#4b5648",
        black: "#20251f",
        red: "#e3a09b",
        green: "#bec7a4",
        yellow: "#d8b886",
        blue: "#a2b5c4",
        magenta: "#c3a7c1",
        cyan: "#9abbb0",
        white: "#e9e6d8",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container.current!);
    fit.fit();
    let line = "",
      position = 0,
      history = shell.history.length,
      disposed = false,
      booted = false;
    const prompt = () => {
      term.write("\x1b[38;2;171;189;150m" + shell.prompt() + "\x1b[0m");
    };
    const render = () => {
      term.write("\r\x1b[2K");
      prompt();
      term.write(line);
      if (position < line.length) term.write(`\x1b[${line.length - position}D`);
    };
    const run = async (command: string) => {
      if (!booted || shell.busy) return;
      line = "";
      position = 0;
      term.write("\r\n");
      const result = await shell.execute(command);
      if (disposed) return;
      if (result.clear) term.clear();
      if (result.stdout) term.write(result.stdout);
      if (result.stderr)
        term.write("\x1b[38;2;227;160;155m" + result.stderr + "\x1b[0m");
      history = shell.history.length;
      prompt();
    };
    const data = term.onData((text) => {
      if (text === "\x03") {
        if (shell.busy) shell.cancel();
        else {
          term.write("^C\r\n");
          line = "";
          position = 0;
          prompt();
        }
        return;
      }
      if (!booted || shell.busy) return;
      if (text === "\x1b[A" || text === "\x1b[B") {
        history = Math.max(
          0,
          Math.min(
            shell.history.length,
            history + (text === "\x1b[A" ? -1 : 1),
          ),
        );
        line = shell.history[history] || "";
        position = line.length;
        render();
        return;
      }
      if (text === "\x1b[D") {
        position = Math.max(0, position - 1);
        render();
        return;
      }
      if (text === "\x1b[C") {
        position = Math.min(line.length, position + 1);
        render();
        return;
      }
      if (text === "\x01" || text === "\x1b[H") {
        position = 0;
        render();
        return;
      }
      if (text === "\x05" || text === "\x1b[F") {
        position = line.length;
        render();
        return;
      }
      if (text === "\x0c") {
        term.clear();
        render();
        return;
      }
      if (text === "\t") {
        const candidates = shell.complete(line);
        if (candidates.length === 1) {
          const at = line.lastIndexOf(" ") + 1;
          line = line.slice(0, at) + candidates[0];
          position = line.length;
          render();
        } else if (candidates.length) {
          term.write("\r\n" + candidates.join("  ") + "\r\n");
          render();
        }
        return;
      }
      if (text.startsWith("\x1b")) return;
      for (const c of text) {
        if (c === "\r" || c === "\n") {
          void run(line);
          break;
        }
        if (c === "\x7f") {
          if (position > 0) {
            line = line.slice(0, position - 1) + line.slice(position);
            position--;
            render();
          }
        } else if (c >= " ") {
          line = line.slice(0, position) + c + line.slice(position);
          position++;
          render();
        }
      }
    });
    const resize = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {}
    });
    resize.observe(container.current!);
    const command = (e: Event) => {
      if (shell.busy) return;
      line = (e as CustomEvent<string>).detail;
      position = line.length;
      render();
      void run(line);
      term.focus();
    };
    window.addEventListener("diorama-command", command);
    void ready.then(() => {
      if (disposed) return;
      booted = true;
      term.writeln(
        "\x1b[38;2;210;148;115mDIORAMA  /  browser computing environment\x1b[0m",
      );
      term.writeln("Rust/WASM kernel initialized. WASI services ready.");
      term.writeln("Workspace mounted at /home/visitor.");
      term.writeln("Clang and YOLO26 load on request.\r\n");
      term.writeln(
        "Run \x1b[1m./sample-hello\x1b[0m now, or compile: \x1b[1mcc hello.c -o hello\x1b[0m\r\n",
      );
      prompt();
    });
    return () => {
      disposed = true;
      data.dispose();
      resize.disconnect();
      window.removeEventListener("diorama-command", command);
      term.dispose();
    };
  }, []);
  return (
    <div
      className="terminal-body"
      ref={container}
      aria-label="Interactive DIORAMA terminal"
    />
  );
}
