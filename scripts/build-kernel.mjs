import { spawnSync } from "node:child_process";
import {
  mkdir,
  copyFile,
  readFile,
  writeFile,
  readdir,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
const root = new URL("../", import.meta.url);
const result = spawnSync(
  "cargo",
  ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown"],
  { cwd: new URL("crates/kernel/", root), stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
await mkdir(new URL("src/kernel/native/", root), { recursive: true });
await copyFile(
  new URL(
    "crates/kernel/target/wasm32-unknown-unknown/release/diorama_kernel.wasm",
    root,
  ),
  new URL("src/kernel/native/core.wasm", root),
);
console.log("Rust/WASM kernel built");
const binary = await readFile(new URL("src/kernel/native/core.wasm", root));
await writeFile(
  new URL("public/kernel-manifest.json", root),
  JSON.stringify(
    {
      language: "Rust",
      toolchain: "1.90.0",
      target: "wasm32-unknown-unknown",
      abi: 1,
      bytes: binary.length,
      sha256: createHash("sha256").update(binary).digest("hex"),
      source: "https://github.com/haokun12x/diorama/tree/main/crates/kernel",
    },
    null,
    2,
  ) + "\n",
);
const metadata = spawnSync(
  "cargo",
  ["metadata", "--locked", "--offline", "--format-version", "1"],
  { cwd: new URL("crates/kernel/", root), encoding: "utf8" },
);
if (metadata.status !== 0) throw Error(metadata.stderr);
let notices = "DIORAMA Rust kernel dependencies, including build-time macros\n";
for (const p of JSON.parse(metadata.stdout).packages) {
  if (!p.source) continue;
  notices += `\n--- ${p.name} ${p.version} (${p.license}) ---\n`;
  const directory = dirname(p.manifest_path);
  for (const file of await readdir(directory, { withFileTypes: true }))
    if (file.isFile() && /^(license|copying)/i.test(file.name))
      notices +=
        file.name +
        "\n" +
        (await readFile(join(directory, file.name), "utf8")) +
        "\n";
}
await mkdir(new URL("public/licenses/", root), { recursive: true });
await writeFile(
  new URL("public/licenses/cargo-runtime-notices.txt", root),
  notices,
);
