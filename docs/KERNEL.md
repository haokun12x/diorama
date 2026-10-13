# Kernel and shell contract

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
