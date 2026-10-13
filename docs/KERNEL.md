# Kernel and shell contract

The kernel and filesystem are implemented in crates/kernel as Rust compiled to wasm32-unknown-unknown. Kernel.call, FileSystem, and the shell are browser adapters to its C ABI. Files, task records, descriptor offsets, event history, and snapshot validation are owned by WASM, including the separate guest system instance. The shell parser and utility dispatch use TypeScript; their file/process operations reach the native kernel.

Kernel imports are diorama.clock_ms (performance.now), unix_ms (Date.now), and random_fill (crypto.getRandomValues). Core exports are memory, kernel_abi_version, kernel_alloc/dealloc, kernel_call, kernel_response_ptr/len, and kernel_data_ptr/len. Requests contain JSON metadata plus an optional byte blob; results contain JSON status/events plus an optional byte blob. The trusted browser adapter copies buffers across the boundary. The kernel has a 256 MiB linear-memory maximum, 1 MiB stack, 4,096 node limit, 32 MiB workspace limit, 8 MiB file limit, 128 task history, and 500 events.

Guest syscall implementations are in crates/kernel/src/wasi.rs. The worker handles guest pointers, copies buffers, and instantiates the same compiled kernel module in an independent WASM memory. Service-specific directory capabilities and write restrictions are enforced in Rust. Guest /proc reports the guest kernel namespace; the main inspector reports the authoritative browser namespace. Clocks have 1 ms resolution. Memory-backed sync/datasync and advise validate the descriptor and return success because file writes have already committed to that in-worker memory. They do not persist to a host disk.

Supported commands: `help pwd ls cd cat echo mkdir touch rm cp mv grep find wc head tail ps top uname date clear history env export which dmesg cc trace vision kill sleep reset` and executable VFS paths.

`ps` and `top` print the current actual runtime task table. `top` is a one-shot snapshot, not a CPU utilization monitor. `find` supports `-name` glob matching. `grep` supports JavaScript regular expressions with `-i`, `-v`, and `-n`. `ls` supports `-a` and `-l`; listings report bytes, not invented POSIX permissions. `cp -r`, `rm -r`/`-rf`, `mkdir -p`, `head -n`, `tail -n`, and `wc -l`/`-w`/`-c` are implemented subsets. Flags are deliberately narrower than BusyBox.

Quoting, escapes, `$NAME`, `${NAME}`, `$?`, pipelines, and input/output/stderr redirection are parsed, rather than matched against hard-coded command strings. Environment expansion preserves one token and does not implement POSIX field splitting. Command substitution, semicolon lists, &&/||, glob expansion in arbitrary commands, background jobs, scripts, interactive guest stdin, symlinks, permission bits, ownership, and filesystem devices are unsupported. Unsupported control operators produce an explicit error.

The initial hierarchy contains /bin, /dev, /etc, /home/visitor, /home/visitor/projects, /proc, /tmp, /usr, /var/log, and /samples. /bin contains descriptive files naming implemented JavaScript commands; those files are not executable BusyBox binaries. Guest executables have actual WASM magic bytes and execute through the compiler/runtime adapter.

`/proc/tasks`, `/proc/mounts`, and `/proc/runtime` are computed at read time. They describe DIORAMA, not Linux. The shell history is a bounded session history. User workspace files persist between reloads in this browser's IndexedDB. Browser storage clearing removes them. Snapshot transactions are debounced; closing the browser immediately after a write may precede persistence.

Useful sequences:

```sh
mkdir -p experiments/data
echo "red blue" > experiments/data/colors
echo "green" >> experiments/data/colors
cat experiments/data/colors | grep blue | wc -w
cat /proc/tasks
sleep 20
# press Ctrl+C or cancel that PID in the kernel inspector
```
