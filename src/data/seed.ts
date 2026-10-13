import type { Kernel } from "../kernel/kernel";
import { projects, projectReadme } from "./projects";
import { samples } from "./samples";
export const commands = [
  "help",
  "pwd",
  "ls",
  "cd",
  "cat",
  "echo",
  "mkdir",
  "touch",
  "rm",
  "cp",
  "mv",
  "grep",
  "find",
  "wc",
  "head",
  "tail",
  "ps",
  "top",
  "uname",
  "date",
  "clear",
  "history",
  "env",
  "export",
  "which",
  "dmesg",
  "cc",
  "trace",
  "vision",
  "kill",
  "sleep",
  "reset",
];
export function seed(k: Kernel) {
  const fs = k.fs;
  for (const d of [
    "/bin",
    "/dev",
    "/etc",
    "/home/visitor/projects",
    "/tmp/vision",
    "/usr",
    "/var/log",
    "/samples",
  ])
    fs.mkdir(d, true);
  for (const name of commands)
    fs.write(
      "/bin/" + name,
      `DIORAMA BusyBox-inspired TypeScript utility: ${name}\n`,
    );
  for (const name of ["stdin", "stdout", "stderr", "null"])
    fs.write("/dev/" + name, "");
  fs.write(
    "/etc/motd",
    "DIORAMA / a miniature computing world\nVirtual kernel. Real Clang. Real WebAssembly. Local neural perception.\n",
  );
  fs.write(
    "/home/visitor/README.md",
    "# Welcome to DIORAMA\n\nYour browser is the machine.\n\nTry:\n  ls\n  cat hello.c\n  cc hello.c -o hello\n  ./hello\n  trace show\n  cat /proc/runtime\n  ls projects\n  vision detect /samples/street.jpg --json\n\nYour workspace persists in IndexedDB on this browser. No server receives your C source.\nUse Ctrl+C to cancel a running task. Use reset to erase your saved workspace.\n",
  );
  for (const [name, source] of Object.entries(samples))
    fs.write("/home/visitor/" + name, source);
  for (const p of projects) {
    fs.mkdir("/home/visitor/projects/" + p.id, true);
    fs.write("/home/visitor/projects/" + p.id + "/README.md", projectReadme(p));
  }
  fs.write(
    "/usr/KERNEL.md",
    "# DIORAMA kernel\n\nA TypeScript virtual runtime, not Linux. Cooperative task dispatch runs on the browser event loop. Synchronous WASM guests run in dedicated workers with restricted WASI imports and 64 MiB linear-memory maxima. Workers are terminated on cancellation or timeout. No fork, threads, signals, sockets, symlinks, or native devices.\n\nInspect /proc/tasks, /proc/mounts, /proc/runtime.\n",
  );
  fs.write(
    "/samples/README.md",
    "street.jpg and desk.jpg are same-origin bundled images. On first inference the image bytes are added to this VFS. YOLO26 weights load only on request.\n",
  );
  k.proc();
  k.trace(
    1,
    "kernel",
    "boot",
    "memfs + virtual /proc + persistent workspace",
    "ready",
  );
}
