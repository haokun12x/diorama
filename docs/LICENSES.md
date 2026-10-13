# Dependency and asset license audit

The application is AGPL-3.0-only, with its full source linked from the public UI. Third-party files keep their own terms; this table identifies the relevant source and distribution notices. No SAM3 code or weights are redistributed.

| Component | Pinned source | Terms / attribution |
|---|---|---|
| DIORAMA application | this repository | AGPL-3.0-only; LICENSE |
| @ultralytics/yolo, Rust/WASM inference | npm 0.0.51 / official ultralytics/inference | AGPL-3.0; original source notices retained; worker-loader and telemetry modifications are documented |
| YOLO26n detection and segmentation ONNX weights | ultralytics/assets release v8.4.0 | Ultralytics AGPL-3.0 model terms; same-origin distribution; exact hashes and original download URLs in assets-manifest.json |
| ONNX Runtime Web | pyke ort-web distribution 1.27.0 | MIT, Microsoft copyright; public/licenses/ONNX-Runtime-MIT.txt; runtime vendored unchanged except the global export needed by the module worker |
| browsercc orchestration | npm 0.1.1 | MIT, Daniel Bertalan; public/toolchain/LICENSE and public/licenses/browsercc-MIT.txt |
| Clang / LLD / compiler-rt / libc++ | browsercc's LLVM 20.1.2 build | Apache-2.0 WITH LLVM-exception; LLVM license is distributed in public/licenses |
| WASI sysroot | browsercc's WASI SDK 25 artifacts | wasi-libc and musl component licenses and notices; distributed in public/licenses/wasi-libc-LICENSE.txt |
| Emscripten glue | compiler package | MIT / LLVM-derived notices; public/licenses/Emscripten-LICENSE.txt |
| Custom Rust/WASM kernel and WASI implementation | crates/kernel, Rust 1.90.0 | Application AGPL-3.0-only; implemented here rather than using an external WASI shim |
| Rust standard library | rust-lang/rust 1.90.0 | MIT OR Apache-2.0; both official notices distributed under public/licenses |
| serde / serde_core / serde_json, itoa | Cargo.lock | MIT OR Apache-2.0; exact versions and full notices in cargo-runtime-notices.txt |
| memchr / zmij | Cargo.lock | Unlicense OR MIT / MIT; full notices distributed |
| Rust build-time macros and Unicode tables | Cargo.lock | MIT OR Apache-2.0; unicode-ident additionally Unicode-3.0; all notices distributed |
| React / React DOM | npm 19.2.0 | MIT |
| xterm.js / fit addon | npm 6.0.0 / 0.11.0 | MIT |
| CodeMirror | npm 6.0.2 and locked modules | MIT |
| Vite / Vitest / TypeScript / Playwright | package-lock.json | MIT / MIT / Apache-2.0 / Apache-2.0; development/build dependencies |
| street.jpg and people.jpg | ultralytics/ultralytics assets bus.jpg and zidane.jpg | Bundled from the official AGPL-3.0 repository; file source paths and its license are linked below |
| Instrument Serif / DM Sans / IBM Plex Mono | Google Fonts | SIL Open Font License; downloaded by browser stylesheet, not embedded in repository; local fallbacks included |

Image sources: [bus.jpg](https://github.com/ultralytics/ultralytics/blob/main/ultralytics/assets/bus.jpg), [zidane.jpg](https://github.com/ultralytics/ultralytics/blob/main/ultralytics/assets/zidane.jpg), and the [upstream repository license](https://github.com/ultralytics/ultralytics/blob/main/LICENSE). No unrelated scraped photos or videos are used.

Model source and terms: [official model assets](https://github.com/ultralytics/assets/releases/tag/v8.4.0), [Ultralytics license guidance](https://www.ultralytics.com/license), [official inference package](https://github.com/ultralytics/inference/tree/main/web).

The browsercc package is MIT, but that does not relicense its LLVM or libc binaries. Their notices accompany deployment separately. Upstream LLVM's license text includes third-party component sections. The wasi-libc notice includes its musl subcomponents. Full npm dependency versions and integrity hashes are in package-lock.json; Rust versions and crate checksums are in crates/kernel/Cargo.lock. build-kernel.mjs generates Rust dependency notices from the locked package sources and a kernel-manifest.json recording the built module’s SHA-256, size, target, ABI, and toolchain. Generated deployment artifacts are built from those packages; no gated weights, credentials, or proprietary toolkit files are included.
