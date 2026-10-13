import {
  cp,
  readFile,
  writeFile,
  mkdir,
  stat,
  rm,
  readdir,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
await mkdir("public/toolchain", { recursive: true });
await cp("node_modules/browsercc/dist", "public/toolchain", {
  recursive: true,
});
await rm("public/toolchain/stdc++.h.pch", { force: true });
// Preserve genuine Clang/LLD output bytes and support full VFS source paths.
let cc = await readFile("public/toolchain/index.js", "utf8");
cc = cc.replace(
  "module: await WebAssembly.compile(output),",
  "module: await WebAssembly.compile(output),\n        binary: output,",
);
cc = cc.replace(
  "clang.FS.writeFile(inputName, inputFile);",
  'clang.FS.mkdirTree(inputName.split("/").slice(0,-1).join("/") || "/");\n    clang.FS.writeFile(inputName, inputFile);',
);
cc = cc.replace(
  "clang.FS.writeFile(fileName, source);",
  'clang.FS.mkdirTree(fileName.split("/").slice(0,-1).join("/") || "/");\n    clang.FS.writeFile(fileName, source);',
);
await writeFile("public/toolchain/index.js", cc);
await cp("node_modules/browsercc/LICENSE", "public/toolchain/LICENSE");
await mkdir("public/yolo", { recursive: true });
await cp("node_modules/@ultralytics/yolo/dist", "public/yolo/dist", {
  recursive: true,
});
await cp("node_modules/@ultralytics/yolo/pkg", "public/yolo/pkg", {
  recursive: true,
});
// ort-web's upstream loader uses DOM script tags. Load the same official runtime in a module worker instead.
const snippets = "public/yolo/pkg/snippets/ort-web-4c80a52e3fc0a0d5";
await writeFile(
  snippets + "/_loader.js",
  `// DIORAMA worker adapter; original package: @ultralytics/yolo 0.0.51, AGPL-3.0.\nlet loaded=false;\nexport async function initRuntime(features,dist){\n if(loaded)return false;\n const base=dist?.baseUrl || new URL('../../../../ort/',import.meta.url).href;\n const name=dist?.scriptName || (features & 2 ? 'ort.webgpu.min.js':'ort.wasm.min.js');\n await import(new URL(name,base).href);\n globalThis.ort.env.wasm.numThreads=1;\n globalThis.ort.env.wasm.proxy=false;\n globalThis.ort.env.wasm.wasmPaths=base;\n loaded=true;return true;\n}\n`,
);
await writeFile(
  snippets + "/_telemetry.js",
  "// DIORAMA disables upstream domain telemetry.\nexport function trackSessionInit(){return false;}\n",
);
await mkdir("public/models", { recursive: true });
await mkdir("public/ort", { recursive: true });
const sources = [
  [
    "public/models/yolo26n.onnx",
    "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.onnx",
  ],
  [
    "public/models/yolo26n-seg.onnx",
    "https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n-seg.onnx",
  ],
  ...[
    "ort.wasm.min.js",
    "ort.webgpu.min.js",
    "ort-wasm-simd-threaded.wasm",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.jsep.mjs",
    "ort-wasm-simd-threaded.asyncify.wasm",
    "ort-wasm-simd-threaded.asyncify.mjs",
  ].map((f) => [
    "public/ort/" + f,
    "https://cdn.pyke.io/0/pyke:ort-rs/web@1.27.0/" + f,
  ]),
];
let expected = [];
try {
  expected = JSON.parse(await readFile("public/assets-manifest.json", "utf8"));
} catch {}
const manifest = [];
for (const [file, url] of sources) {
  let exists = true;
  try {
    await stat(file);
  } catch {
    exists = false;
  }
  if (!exists) {
    const response = await fetch(url);
    if (!response.ok) throw Error(`${url}: ${response.status}`);
    let data = Buffer.from(await response.arrayBuffer());
    if (file.endsWith(".min.js"))
      data = Buffer.concat([data, Buffer.from("\n;globalThis.ort=ort;\n")]);
    await writeFile(file, data);
  }
  const data = await readFile(file);
  const hash = createHash("sha256").update(data).digest("hex");
  const pin = expected.find((x) => x.file === path.basename(file));
  if (pin && pin.sha256 !== hash) throw Error(`Asset hash mismatch: ${file}`);
  manifest.push({
    file: path.basename(file),
    source: url,
    bytes: data.length,
    sha256: hash,
  });
  console.log(file, data.length);
}
await writeFile(
  "public/assets-manifest.json",
  JSON.stringify(manifest, null, 2) + "\n",
);

await mkdir("public/licenses", { recursive: true });
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
let notices = "DIORAMA third-party npm runtime notices\n\n";
for (const [dir, info] of Object.entries(lock.packages)) {
  if (!dir || info.dev) continue;
  const names = await readdir(dir);
  const file = names.find((n) => /^licen[cs]e(?:[.-]|$)/i.test(n));
  if (file) {
    notices +=
      `\n--- ${dir} ${info.version} ---\n` +
      (await readFile(dir + "/" + file, "utf8")) +
      "\n";
  }
}
await writeFile("public/licenses/npm-runtime-notices.txt", notices);

// A small real executable makes the first guest interaction possible without downloading LLVM.
await mkdir("public/examples", { recursive: true });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url =
    input instanceof URL
      ? input.href
      : typeof input === "string"
        ? input
        : input.url;
  if (url.startsWith("file:")) {
    const data = await readFile(new URL(url));
    return new Response(data, {
      headers: { "content-length": String(data.length) },
    });
  }
  return originalFetch(input, init);
};
try {
  const { compile } = await import("../public/toolchain/index.js");
  const source = await readFile("src/data/sample-hello.c", "utf8");
  const result = await compile({
    source,
    fileName: "sample-hello.c",
    flags: ["-O2", "-Wl,--max-memory=67108864", "-Wl,-z,stack-size=1048576"],
  });
  if (!result.binary) throw Error(result.compileOutput);
  await writeFile("public/examples/sample-hello.wasm", result.binary);
  console.log("Prebuilt WASI sample", result.binary.length, "bytes");
} finally {
  globalThis.fetch = originalFetch;
}
