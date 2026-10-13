import type { Kernel, Task } from "../kernel/kernel";
import type { Compiler } from "../compiler/compiler";
import type { Vision } from "../vision/vision";
import { resolvePath } from "../fs/filesystem";
import { commands } from "../data/seed";
import { parse } from "./parser";
export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
  clear?: boolean;
};
const ok = (stdout = ""): CommandResult => ({ stdout, stderr: "", code: 0 });
export class Shell {
  cwd = "/home/visitor";
  env: Record<string, string> = {
    USER: "visitor",
    HOME: "/home/visitor",
    PATH: "/bin",
    TERM: "xterm-256color",
    PWD: "/home/visitor",
    "?": "0",
  };
  history: string[] = [];
  busy = false;
  active?: Task;
  constructor(
    public kernel: Kernel,
    public compiler: Compiler,
    public vision: Vision,
    public reset: () => Promise<void> = async () => {},
  ) {}
  prompt() {
    return `visitor@diorama:${this.cwd.replace("/home/visitor", "~")}$ `;
  }
  path(p: string) {
    return resolvePath(
      p.startsWith("~") ? p.replace("~", this.env.HOME) : p,
      this.cwd,
    );
  }
  complete(prefix: string) {
    const part = prefix.split(/\s/).at(-1) || "";
    if (!prefix.includes(" "))
      return commands.filter((c) => c.startsWith(part));
    const slash = part.lastIndexOf("/");
    const dir = slash < 0 ? "." : part.slice(0, slash + 1);
    try {
      return this.kernel.fs
        .list(this.path(dir))
        .map(
          (p) =>
            (slash < 0 ? "" : dir) +
            p.split("/").pop() +
            (this.kernel.fs.stat(p).kind === "dir" ? "/" : ""),
        )
        .filter((p) => p.startsWith(part));
    } catch {
      return [];
    }
  }
  cancel() {
    if (this.active && !this.active.ended) this.kernel.cancel(this.active.pid);
  }
  async execute(line: string): Promise<CommandResult> {
    if (this.busy)
      return {
        stdout: "",
        stderr: "shell: a foreground job is already running\n",
        code: 1,
      };
    this.busy = true;
    this.history.push(line);
    if (this.history.length > 200) this.history.shift();
    let result = ok();
    try {
      const pipeline = parse(line, this.env);
      let input = "";
      for (const command of pipeline) {
        result = await this.kernel.run(
          command.args.join(" "),
          "userspace",
          async (task) => {
            this.active = task;
            this.kernel.trace(
              task.pid,
              "shell",
              "command.dispatch",
              command.args.join(" "),
              "running",
            );
            if (command.input)
              input = this.kernel.fs.text(this.path(command.input));
            let output: CommandResult;
            try {
              output = await this.dispatch(command.args, input, task);
            } catch (e) {
              output = {
                stdout: "",
                stderr: `${command.args[0]}: ${e instanceof Error ? e.message : String(e)}\n`,
                code: task.controller.signal.aborted ? 130 : 1,
              };
            }
            if (task.controller.signal.aborted)
              output = { stdout: "", stderr: "Interrupted\n", code: 130 };
            if (command.output) {
              if (this.path(command.output) !== "/dev/null")
                this.kernel.fs.write(
                  this.path(command.output),
                  output.stdout,
                  command.append,
                );
              this.kernel.trace(
                task.pid,
                "shell",
                "io.redirect",
                command.output,
                String(output.stdout.length),
              );
              output.stdout = "";
            }
            if (command.error) {
              if (this.path(command.error) !== "/dev/null")
                this.kernel.fs.write(
                  this.path(command.error),
                  output.stderr,
                  command.errorAppend,
                );
              output.stderr = "";
            }
            this.kernel.finish(task, output.code);
            return output;
          },
        );
        input = result.stdout;
        if (input.length > 1024 * 1024) throw Error("pipe exceeds 1 MiB");
        if (pipeline.length > 1)
          this.kernel.trace(
            this.active?.pid || 1,
            "shell",
            "io.pipe",
            "buffered stdout",
            String(input.length),
          );
        if (result.code === 130) break;
      }
    } catch (e) {
      result = {
        stdout: "",
        stderr: `shell: ${e instanceof Error ? e.message : String(e)}\n`,
        code: 1,
      };
    } finally {
      this.env["?"] = String(result.code);
      this.active = undefined;
      this.busy = false;
      this.kernel.notify();
    }
    return result;
  }
  async dispatch(
    [name, ...args]: string[],
    stdin: string,
    task: Task,
  ): Promise<CommandResult> {
    const fs = this.kernel.fs;
    const paths = () =>
      args.filter((a) => !a.startsWith("-")).map((a) => this.path(a));
    const content = () =>
      paths().length
        ? paths()
            .map((p) => fs.text(p))
            .join("")
        : stdin;
    // Filesystem operations are synchronous; set caller identity only for this dispatch turn.
    this.kernel.currentPid = task.pid;
    queueMicrotask(() => {
      this.kernel.currentPid = 1;
    });
    switch (name) {
      case "help":
        return ok(
          "DIORAMA / executable field guide\n\n" +
            commands.join("  ") +
            "\n\nTRY NOW    ./sample-hello (prebuilt WASI guest)\nCOMPUTE    cc hello.c -o hello  →  ./hello\nINSPECT    ps  ·  trace show  ·  cat /proc/runtime\nPERCEIVE   vision detect /samples/street.jpg --json\nSEGMENT    vision segment /samples/street.jpg --model yolo26-seg\nEXPLORE    find projects  ·  cat projects/wavefill/README.md\n\nPipes, <, >, >>, 2>, quotes and $VARIABLE are supported.\nUtilities are BusyBox-inspired TypeScript. Ctrl+C cancels workers.\n",
        );
      case "pwd":
        return ok(this.cwd + "\n");
      case "cd": {
        const p = this.path(args[0] || "~");
        if (fs.stat(p).kind !== "dir") throw Error("not a directory");
        this.cwd = p;
        this.env.PWD = p;
        return ok();
      }
      case "ls": {
        const p = this.path(args.find((a) => !a.startsWith("-")) || ".");
        const files = fs.stat(p).kind === "dir" ? fs.list(p) : [p];
        return ok(
          files
            .filter(
              (p) =>
                args.includes("-a") || !p.split("/").pop()!.startsWith("."),
            )
            .map((p) => {
              const n = fs.stat(p);
              return (
                (args.includes("-l")
                  ? `${n.kind === "dir" ? "d" : "-"}  ${String(n.kind === "file" ? n.data.length : 0).padStart(7)}  `
                  : "") +
                p.split("/").pop() +
                (n.kind === "dir" ? "/" : "")
              );
            })
            .join(args.includes("-l") ? "\n" : "  ") + "\n",
        );
      }
      case "cat":
        return ok(content());
      case "echo": {
        const newline = args[0] !== "-n";
        if (!newline) args.shift();
        return ok(args.join(" ") + (newline ? "\n" : ""));
      }
      case "mkdir":
        if (!paths().length) throw Error("missing directory");
        for (const p of paths()) fs.mkdir(p, args.includes("-p"));
        return ok();
      case "touch":
        if (!paths().length) throw Error("missing file");
        for (const p of paths()) if (!fs.exists(p)) fs.write(p, "");
        return ok();
      case "rm":
        if (!paths().length) throw Error("missing path");
        for (const p of paths()) {
          if (args.includes("-f") && !fs.exists(p)) continue;
          fs.remove(p, args.includes("-r") || args.includes("-rf"));
        }
        return ok();
      case "cp":
      case "mv": {
        const [a, b] = paths();
        if (!a || !b) throw Error("source and destination required");
        const dest =
          fs.exists(b) && fs.stat(b).kind === "dir"
            ? b + "/" + a.split("/").pop()
            : b;
        if (name === "cp") fs.copy(a, dest, args.includes("-r"));
        else fs.move(a, dest);
        return ok();
      }
      case "grep": {
        let pattern = args.find((a) => !a.startsWith("-"));
        if (pattern === undefined) throw Error("pattern required");
        const textArgs = args.filter((a) => !a.startsWith("-")).slice(1);
        let re: RegExp;
        try {
          re = new RegExp(pattern, args.includes("-i") ? "i" : "");
        } catch {
          throw Error("invalid regular expression");
        }
        const text = textArgs.length
          ? textArgs.map((p) => fs.text(this.path(p))).join("")
          : stdin;
        const lines = text.split("\n");
        if (lines.at(-1) === "") lines.pop();
        const matched = lines
          .map((s, i) => ({ s, i }))
          .filter(({ s }) => (args.includes("-v") ? !re.test(s) : re.test(s)));
        return {
          stdout:
            matched
              .map(({ s, i }) => (args.includes("-n") ? `${i + 1}:` : "") + s)
              .join("\n") + (matched.length ? "\n" : ""),
          stderr: "",
          code: matched.length ? 0 : 1,
        };
      }
      case "find": {
        const start = this.path(args[0] || ".");
        const at = args.indexOf("-name"),
          pattern = at >= 0 ? args[at + 1] : undefined;
        const reg = pattern
          ? new RegExp(
              "^" +
                pattern
                  .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                  .replace(/\*/g, ".*")
                  .replace(/\?/g, ".") +
                "$",
            )
          : null;
        fs.stat(start);
        return ok(
          [...fs.entries.keys()]
            .filter(
              (p) =>
                (p === start || p.startsWith(start + "/")) &&
                (!reg || reg.test(p.split("/").pop()!)),
            )
            .sort()
            .join("\n") + "\n",
        );
      }
      case "wc": {
        const text = content(),
          counts = [
            (text.match(/\n/g) || []).length,
            text.trim() ? text.trim().split(/\s+/).length : 0,
            new TextEncoder().encode(text).length,
          ];
        const flags = args.filter((a) => a.startsWith("-")).join("");
        return ok(
          counts
            .filter((_, i) => !flags || flags.includes(["l", "w", "c"][i]))
            .join("  ") + "\n",
        );
      }
      case "head":
      case "tail": {
        const i = args.indexOf("-n");
        const count = i >= 0 ? Number(args[i + 1]) : 10;
        if (!Number.isInteger(count) || count < 0)
          throw Error("invalid line count");
        if (i >= 0) args.splice(i, 2);
        const text = content(),
          lines = text.split("\n");
        if (lines.at(-1) === "") lines.pop();
        return ok(
          (name === "head"
            ? lines.slice(0, count)
            : count
              ? lines.slice(-count)
              : []
          ).join("\n") + (count && lines.length ? "\n" : ""),
        );
      }
      case "ps":
      case "top":
        return ok(
          " PID  STATE       KIND         NAME\n" +
            this.kernel
              .taskInfo()
              .map(
                (t) =>
                  `${String(t.pid).padStart(4)}  ${t.state.padEnd(11)} ${t.kind.padEnd(12)} ${t.name}${t.exitCode !== undefined ? " [exit " + t.exitCode + "]" : ""}`,
              )
              .join("\n") +
            "\n",
        );
      case "uname":
        return ok(
          "DIORAMA 0.1 / Rust/WebAssembly kernel / wasm32 WASI preview1 / " +
            navigator.userAgent +
            "\n",
        );
      case "date":
        return ok(new Date().toString() + "\n");
      case "env":
        return ok(
          Object.entries(this.env)
            .filter(([k]) => k !== "?")
            .map(([k, v]) => k + "=" + v)
            .join("\n") + "\n",
        );
      case "export":
        for (const a of args) {
          const m = a.match(/^([A-Za-z_]\w*)=(.*)$/s);
          if (!m) throw Error("use export NAME=value");
          this.env[m[1]] = m[2];
        }
        return ok();
      case "which":
        return ok(
          args
            .map((c) =>
              commands.includes(c)
                ? "/bin/" + c
                : fs.exists(this.path(c))
                  ? this.path(c)
                  : `${c}: not found`,
            )
            .join("\n") + "\n",
        );
      case "history":
        return ok(
          this.history
            .map((s, i) => `${String(i + 1).padStart(3)}  ${s}`)
            .join("\n") + "\n",
        );
      case "clear":
        return { ...ok(), clear: true };
      case "trace":
      case "dmesg":
        if (args[0] === "clear") {
          this.kernel.events = [];
          this.kernel.notify();
          return ok();
        }
        return ok(
          this.kernel.events
            .map(
              (e) =>
                `${e.time.toFixed(2).padStart(10)}ms  [${e.pid}] ${e.layer}/${e.op}(${e.args}) → ${e.result}${e.duration ? "  " + e.duration.toFixed(2) + "ms" : ""}`,
            )
            .join("\n") + "\n",
        );
      case "kill":
        if (!args[0]) throw Error("PID required");
        this.kernel.cancel(Number(args[0]));
        return ok();
      case "sleep": {
        const seconds = Number(args[0]);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60)
          throw Error("sleep accepts 0..60 seconds");
        this.kernel.state(task, "waiting");
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(Error("Interrupted"));
          };
          const timer = setTimeout(() => {
            task.controller.signal.removeEventListener("abort", abort);
            resolve();
          }, seconds * 1000);
          task.controller.signal.addEventListener("abort", abort, {
            once: true,
          });
        });
        return ok();
      }
      case "cc": {
        const source = args.find((a) => a.endsWith(".c"));
        if (!source) throw Error("use cc source.c -o executable [-O2]");
        const i = args.indexOf("-o"),
          out = i >= 0 ? args[i + 1] : "a.out";
        if (!out) throw Error("-o needs filename");
        const flags = args.filter(
          (a, j) => a !== source && a !== "-o" && (i < 0 || j !== i + 1),
        );
        const r = await this.compiler.compile(
          this.path(source),
          this.path(out),
          flags,
          task.pid,
          task.controller.signal,
        );
        return {
          stdout: `Compiled ${out} (${r.binary?.length} bytes) in ${r.duration.toFixed(1)} ms\n`,
          stderr: r.diagnostics,
          code: 0,
        };
      }
      case "vision": {
        const op = args[0] || "status";
        if (op === "status") return ok(this.vision.describe() + "\n");
        if (op === "models")
          return ok(
            "yolo26n · local ONNX detection\nyolo26-seg · local ONNX instance segmentation\n",
          );
        if (!["detect", "segment"].includes(op))
          throw Error("use vision status/models/detect/segment");
        const modelIndex = args.indexOf("--model");
        if (
          modelIndex >= 0 &&
          !["yolo26-seg", "yolo26n"].includes(args[modelIndex + 1])
        )
          throw Error("Supported local models: yolo26n, yolo26-seg");
        const r = await this.vision.inferPath(
          this.path(args[1] || "/samples/street.jpg"),
          op === "segment",
          task.pid,
          task.controller.signal,
        );
        return ok(
          args.includes("--json")
            ? JSON.stringify(this.vision.json(r), null, 2) + "\n"
            : r.boxes
                .map(
                  (b) =>
                    `${b.name}  ${(b.conf * 100).toFixed(1)}%  [${b.x1.toFixed(0)}, ${b.y1.toFixed(0)}, ${b.x2.toFixed(0)}, ${b.y2.toFixed(0)}]`,
                )
                .join("\n") +
                `\n${r.boxes.length} objects · ${r.speed.inference.toFixed(1)} ms inference\nResults: /tmp/vision/${op === "segment" ? "segments" : "detections"}.json\n`,
        );
      }
      case "reset":
        await this.reset();
        return ok(
          "Saved workspace reset. Reload to boot the initial filesystem.\n",
        );
      default:
        if (name.includes("/") || fs.exists(this.path(name))) {
          const r = await this.compiler.execute(
            this.path(name),
            args,
            stdin,
            this.cwd,
            this.env,
            task.pid,
            task.controller.signal,
          );
          return { stdout: r.stdout, stderr: r.stderr, code: r.exitCode };
        }
        throw Error(`${name}: command not found. Try help.`);
    }
  }
}
