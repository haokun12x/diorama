# Truthful limits

- DIORAMA implements its kernel and WASI system services in Rust/WebAssembly. It provides a virtual computing environment with a restricted syscall subset; it does not boot Linux or emulate PC hardware. Browser JavaScript supplies the shell, UI, clocks, entropy, storage transport, and worker control.
- Scheduling is cooperative at task dispatch and uses browser workers for execution. It cannot suspend/resume a WASM instruction stream. Cancelling a guest terminates its worker.
- Pipes are sequential, finite UTF-8 buffers. There is no interactive stdin, job-control shell, fork, signals, threads, sockets, or native devices.
- Guest writes merge at successful completion; cancellation loses in-worker changes. This is transactional application semantics, not POSIX write visibility.
- Guest filesystem links, rename, and symlinks are denied. The shell itself implements ordinary VFS move/copy operations.
- The editor builds one C translation unit. Allowed flags are documented; standard C headers are provided by the actual sysroot. C++ and arbitrary build systems are outside the UI scope.
- Guest memory is bounded to 64 MiB, each Rust kernel instance to 256 MiB, but LLVM/ONNX use separate and larger browser allocations. Observed guest memory statistics are not peak JS/process heap measurements.
- YOLO26 model input is fixed at 640×640. Segmentation supports model classes, not promptable open-vocabulary segmentation. SAM3 was cancelled by the owner.
- The browser must support WebAssembly SIMD for the selected compiler and inference artifacts. GPU availability depends on adapter/driver/browser. CPU WASM supplies the supported fallback.
- IndexedDB persistence is local to the browser and origin. Debouncing means very recent writes can precede the next saved snapshot. Exporting a workspace is not implemented.
- Font files load from Google Fonts when accessible, with local serif/sans/monospace fallbacks. Core functionality is independent of those fonts. Heavyweight runtime/model assets are hosted on the same origin.
- Technical background is represented only by the verified public repositories. No private projects, unverified publications, awards, or invented benchmarks are included.
