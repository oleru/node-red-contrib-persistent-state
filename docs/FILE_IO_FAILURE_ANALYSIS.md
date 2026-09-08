# File I/O failure analysis

This note documents current `v0.2.0` behavior when the persistent state file is
missing, unreadable, invalid, unwritable, or temporarily locked.

The current implementation is still intentionally close to
`node-red-contrib-state`, so this is an evaluation of the existing behavior
rather than the target robust storage design.

## Relevant code paths

- Storage directory is resolved from global context `sharedStateDir`, or falls
  back to `./shared-state`.
- The directory is created with `mkdirp(stateDir)` during shared-state config
  node construction.
- The state file path is `<stateDir>/<stateName>`.
- Startup first uses the in-memory global `state` object if present.
- If no in-memory state exists, `initFromFS()` reads and parses the file.
- Updates change the in-memory value first, then conditionally write the file.

Current code references:

- `lib/state.js:79` creates the directory.
- `lib/state.js:84` builds the state file path.
- `lib/state.js:91` prefers already-loaded global state.
- `lib/state.js:120` starts value updates.
- `lib/state.js:157` writes the state file.
- `lib/state.js:162` catches write errors.
- `lib/state.js:302` starts filesystem initialization.
- `lib/state.js:305` reads the state file.
- `lib/state.js:306` parses the state file JSON.
- `lib/state.js:307` catches all read/parse errors.

## Current behavior matrix

| Case | Current behavior | User-visible signal | Runtime result | Persistence result |
| --- | --- | --- | --- | --- |
| State file is missing | `readFile()` throws `ENOENT`; catch returns | None | Node stays with config/default value | First eligible update creates file |
| State file is invalid JSON | `JSON.parse()` throws; catch returns | None | Node stays with config/default value | Next eligible update overwrites bad file |
| State file exists but is unreadable | `readFile()` throws, for example `EACCES`/`EPERM`; catch returns | None | Node stays with config/default value | Later writes may fail or overwrite if access changes |
| State path is a directory | `readFile()` throws, for example `EISDIR`; catch returns | None | Node stays with config/default value | Later writes fail |
| Storage directory cannot be created | `mkdirp()` error is logged | Node-RED error log | Node still continues | Later reads/writes likely fail |
| Write path is missing/invalid | `writeFile()` throws | Node-RED error log | In-memory value already changed | File is not updated |
| Write permission denied | `writeFile()` throws `EACCES`/`EPERM` | Node-RED error log | In-memory value already changed | File is not updated |
| File locked by another process | Platform dependent; usually write error on Windows if lock blocks writes | Node-RED error log | In-memory value already changed | File is not updated |
| Crash/power loss during write | Direct overwrite has no temp/rename/backup protection | Maybe no signal on restart | May start from default if file becomes invalid | File can be truncated or corrupt |

## Important consequences

### Missing file is acceptable today

Missing file is treated as first boot. This is useful for new variables and
fresh systems.

The downside is that missing and unreadable are indistinguishable. A deleted
file, a permission problem, a directory collision, and invalid JSON all result
in the same silent startup fallback.

### Invalid or unreadable file can silently reset state

`initFromFS()` catches everything and returns. That means a corrupted file does
not stop the node, does not mark status as degraded, and does not log the
problem.

For configuration-like values this is risky because the system can boot with
defaults while the operator sees a normal flow.

### Write errors happen after the in-memory value changes

`update()` currently assigns `prev`, `value`, `timestamp`, and `initialized`
before writing the file. If the file write fails, the catch block logs an error,
but the in-memory state remains changed.

This means the live Node-RED runtime may appear correct until restart, then
come back with the old persisted value or a default value.

### Direct writes are not power-loss safe

The file is written directly with `fs.writeFile()`. There is no temp file,
checksum, directory sync, or previous-generation backup.

If power disappears while Node.js is truncating or rewriting the file, the next
boot can see invalid JSON and silently fall back to defaults.

### There is no explicit lock protocol

The component has no lock file or interprocess coordination. Under normal
Node-RED operation one runtime owns the user directory, so this is usually fine.

If two Node-RED instances share the same `sharedStateDir`, last writer wins.
If another process holds a blocking lock, the write fails and is only logged.

## Current risk level

The existing behavior is usable for ordinary Node-RED convenience state, but it
is not yet robust enough for power-loss-tolerant persistent configuration.

Highest-risk cases:

1. Corrupt state file silently becoming default value on restart.
2. Write failure leaving runtime value different from persisted value.
3. Power loss during direct overwrite corrupting the only persisted copy.
4. Permission/lock issues not reflected in node status.

## Recommended first hardening step

Before introducing the full split config/value store, make file I/O failures
visible and classify them:

1. Treat `ENOENT` as normal first-boot only.
2. Log and set node status for invalid JSON, `EACCES`, `EPERM`, `EISDIR`, and
   other read failures.
3. On write failure, keep logging but also expose a degraded status/state flag
   so the flow can alarm.
4. Add tests for missing file, corrupt file, unreadable path, directory path,
   and failed write.

This is a small, compatibility-preserving improvement. It does not change the
file format and can be done before the more robust checksum and redundant
write protocol.

## Target robust behavior later

The robust value-store design should then replace direct overwrite with:

1. Write new value to a temp file in the same directory.
2. Flush the temp file.
3. Rename current active value to previous.
4. Rename temp to active.
5. Store checksum with the value.
6. On boot, validate active first, then recover from previous.
7. Never silently fall back to defaults when a persisted value exists but is
   invalid.

This matches the broader plan in `docs/PERSISTENT_VALUE_STORE_DESIGN.md`.
