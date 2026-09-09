# Persistent Value Store Design

Status: implementation notes for `0.5.0`. The compact value store is integrated
into the Node-RED state runtime using one directory per state.

## Goal

The fork should keep the existing Node-RED node types and flow-facing behavior,
but split state definition from durable runtime value storage.

Each state now has a directory below `sharedStateDir`. `config.json` contains
per-variable configuration metadata, while `active.json` and `previous.json`
contain compact redundant value generations.

The main design requirement is power-loss tolerance: removing power at any point
during a write must not destroy the last accepted value. On restart, the node
must deterministically recover either the newest valid value generation or a
documented safe default, and it must log which path was used.

## Compatibility Contract

Before a `v1.0.0` release, this fork prioritizes a clean storage model over
upstream file compatibility. It still preserves:

- Node-RED type names: `shared-state`, `get-shared-state`, `set-shared-state`.
- Existing flow configuration nodes and references.
- Existing `msg.payload` and `msg.state` shape for readers.
- Existing `global.state.<name>` shape as far as practical.
- Existing type conversion, range, unit and label metadata.

The implementation may add internal metadata fields, status messages and log
messages as long as existing flows keep working.

## File Roles

Each state uses this directory:

```text
<sharedStateDir>/<StateName>/
```

The `State Name` is also the directory name and must match:

```text
^[A-Za-z_][A-Za-z0-9_]*$
```

This allows ASCII letters, digits, and underscore only, with the first
character limited to an ASCII letter or underscore. It deliberately excludes
hyphen, `$`, spaces, dots, slashes, Unicode letters, and national characters.

### Config File

The config file path is:

```text
<sharedStateDir>/<StateName>/config.json
```

This file is the human-readable state definition/config file. Runtime values do
not belong in this file.

Suggested config payload:

```json
{
  "schema": "persistent-state.config.v1",
  "name": "myNumber",
  "config": {
    "id": "5c0abe9a3ed25508",
    "type": "shared-state",
    "name": "myNumber",
    "lbl": "",
    "tags": "",
    "historyCount": 0,
    "dataType": "num",
    "precision": "",
    "numMin": "",
    "numMax": "",
    "unit": "",
    "saveInterval": "2000"
  },
  "valueStore": {
    "layout": "state-directory-v1"
  }
}
```

Open point: decide whether the config file should be rewritten on every deploy
or only when the config changes. The preferred default is only when the config
changes.

Current implementation note: `config.json` is still rewritten when a value is
persisted, but it contains only metadata, not the runtime value. A later
implementation can reduce this further by writing the config file only on
deploy/config change.

### Value Directory

Value generations live beside `config.json`:

```text
<sharedStateDir>/<StateName>/
```

Files:

```text
config.json
active.json
previous.json
staged.json.tmp
commit.json.tmp
```

Only `active.json` and `previous.json` are durable generations. Temporary files
are ignored during startup unless a later implementation explicitly supports
finishing an interrupted two-phase commit.

## Value File Format

The value file should contain only the current value and the dynamic metadata
needed to validate and order generations.

`value` and `previous` must support all JSON-compatible values used by Node-RED
flows:

- `null`
- strings
- finite numbers
- booleans
- arrays
- nested plain-object JSON trees

Values that JSON cannot preserve safely, such as `undefined`, functions,
symbols, `NaN`, `Infinity`, class instances, dates as objects, and circular
references, should be rejected before writing the value generation. If a flow
needs to persist those concepts, it should convert them into explicit JSON
values first, for example an ISO timestamp string instead of a `Date` object.

Compact value generation:

```json
{
  "value": 7,
  "previous": 6,
  "sequence": 42,
  "timestamp": 1788787909167,
  "checksum": "..."
}
```

The checksum must be calculated from a canonical JSON representation of
all fields except `checksum`, not from pretty-printed file bytes. The first
implementation uses a stable stringify helper with sorted object keys.

Static metadata such as schema, state name, and data type belongs in the state
configuration and path context, not in every value generation. Recovery still
validates old wrapped `payload`/`checksum` generations from early `v0.4.0`
development so existing local test files can migrate forward on the next write.

## Ordering

Use `sequence` as the primary ordering key.

Rules:

- Increment `sequence` after a value has been accepted in memory.
- Persist the accepted value with the next sequence.
- On startup, pick the valid generation with the highest sequence.
- If two valid generations have the same sequence but different values, treat
  that as a recovery warning and prefer `active.json`.
- Do not compare wall-clock timestamps to decide which value is newest.

Open point: decide whether sequence should be global per state only, or include a
repository-wide generation counter. Per-state sequence is simpler and sufficient
for this fork.

## Write Algorithm

All writes for one state must be serialized. A state should never have two
concurrent filesystem commits in flight.

The runtime uses a coalescing write pump. If a new value arrives while a write is
already in progress, it does not enqueue every intermediate value. It marks that
another write is needed, lets the current write finish, then writes one snapshot
of the latest runtime value. This keeps disk I/O bounded during fast updates
while still converging on the newest accepted state.

For example:

```text
runtime accepts: 10, 11, 12, 13
disk may persist: 10, then 13
```

The intermediate `11` and `12` values are not retained as durable generations.
This is intentional because `history` is deprecated and the value store is a
recovery mechanism, not a full event log.

In a compact value generation, `previous` means the previous runtime value at
the moment that snapshot was accepted. The file `previous.json` has a different
meaning: it is the previous successfully persisted generation. Those two values
can differ when rapid runtime updates are coalesced.

Preferred write flow:

1. Validate and type-convert the new value.
2. Update in-memory state.
3. Build a new compact value generation with incremented `sequence`.
4. Write the generation to `staged.json.tmp`.
5. Flush the file contents.
6. Close the staged file.
7. Copy current `active.json` to `previous.json.tmp`, when it exists.
8. Rename `staged.json.tmp` to `active.json`.
9. Flush the containing directory where the platform supports it.
10. Rename `previous.json.tmp` to `previous.json`.
11. Emit change notification after the active generation has been committed.

On Windows, POSIX-style directory `fsync` is not always practical from Node.js.
The implementation should still use same-directory writes and renames, and it
should document the exact durability guarantee per platform.

The old active generation is copied instead of renamed before replacement. This
keeps `active.json` usable if power is lost before the staged generation becomes
the new active generation. If a failure happens after `active.json` is replaced
but before `previous.json` is updated, startup recovery must still accept the
new active generation.

## Startup Recovery

Startup recovery should inspect:

```text
active.json
previous.json
staged.json.tmp
previous.json.tmp
commit.json.tmp
```

Initial implementation rules:

- Ignore temporary files for value selection.
- Validate `active.json`.
- Validate `previous.json`.
- Select the valid generation with the highest sequence.
- If no value generation exists, try importing the legacy config/value file.
- If legacy import succeeds, write a fresh `active.json`.
- If no valid value exists, use the configured default if one exists.
- If no valid value or default exists, initialize as the current code does, but
  log a distinct "missing value" warning.

Validation must distinguish:

- missing value file;
- unreadable file;
- invalid JSON;
- checksum mismatch;
- unsupported legacy schema;
- wrong legacy state name;
- wrong legacy data type;
- value outside configured range;
- recovered from previous generation;
- defaulted.

These conditions should be visible in Node-RED logs and, where helpful, node
status.

## Migration Sources

`v0.5.0` writes only the state-directory layout. During development it may read
the previous `v0.4.0` value directory as an import source:

```text
<sharedStateDir>/.values/<StateName>/active.json
<sharedStateDir>/.values/<StateName>/previous.json
```

When a value is recovered from this layout, the runtime writes it back to:

```text
<sharedStateDir>/<StateName>/active.json
```

If an old top-level file exists at `<sharedStateDir>/<StateName>`, it blocks
the new directory path. The runtime moves that file aside to
`<sharedStateDir>/<StateName>.legacy.<timestamp>.json` before creating the
state directory.

Legacy `history` must not be treated as redundancy. As of `v0.3.0`, the field is
kept in `msg.state` and global context for compatibility, but the runtime keeps
it as an empty array and does not actively maintain it.

Upstream `1.6.1` top-level value-file import is not a priority before `v1.0.0`.
The fork is currently used only by our projects, so development can favor a
clean directory model over broad backwards compatibility.

## Root Path Option

The supported root setting is:

```js
functionGlobalContext: {
  sharedStateDir: "/opt/data/node-red-shared-state"
}
```

Resolution order:

1. Use `sharedStateDir` when set.
2. Otherwise use `./shared-state`.

Separate config/value roots are deliberately avoided in `v0.5.0`; one
per-state directory is simpler to inspect and back up on Raspberry Pi systems.

## v0.5.0 Directory Layout

`v0.5.0` moves from the previous transition layout:

```text
shared-state/
  myNumber
  .values/
    myNumber/
      active.json
      previous.json
```

to one directory per state:

```text
shared-state/
  myNumber/
    config.json
    active.json
    previous.json
```

The `State Name` is both the Node-RED state key and the filesystem
directory name. To keep that deterministic across Raspberry Pi/Linux, Windows,
manual edits, backup tools, and shell scripts, the fork should reject special
characters instead of converting names.

Rule:

```text
^[A-Za-z_][A-Za-z0-9_]*$
```

This allows ASCII letters, digits, and underscore only, with the first
character limited to an ASCII letter or underscore. It deliberately excludes
hyphen, `$`, spaces, dots, slashes, Unicode letters, and national characters,
even though JavaScript would allow some of those forms.

`v0.5.0` fallback and migration is explicit:

1. Prefer the new per-state directory layout when `config.json` or
   `active.json` exists.
2. If the new layout is missing, recover from the current `v0.4.0`
   `.values/<stateName>/active.json` and `.values/<stateName>/previous.json`.
3. After successful recovery from an old layout, write the new per-state
   directory files.
4. Leave old files in place during the first `v0.5.0` migration so rollback to
   `v0.4.0` remains possible.
5. Log which source was used: new layout, v0.4 layout, previous
   generation, or default/missing.

## Data Type Changes During Recovery

Recovered values must be normalized through the current `shared-state`
configuration before they become active runtime state. This keeps the compact
value store independent from static type metadata while still respecting the
Node-RED flow configuration.

Examples:

- `dataType` changed from `num` to `str`: recovered `7` becomes `"7"`.
- `dataType` changed from `str` to `num`: recovered `"7"` becomes `7`.
- `dataType` changed from `str` to `num`: recovered `"abc"` is not a valid
  runtime number and that generation is skipped.

Recovery policy:

1. Validate checksum and sequence first.
2. Try the newest valid generation.
3. Convert `value` through the same type conversion used by normal set-state
   updates.
4. Convert `previous` when possible; if only `previous` is incompatible, keep
   the current value and set `previous` to `null`.
5. If `value` cannot be represented as JSON after conversion, skip that
   generation and try the next valid generation.
6. If a generation is converted, rewrite it as a fresh compact generation so
   later boots do not repeat the migration.

This makes data type changes explicit and recoverable instead of silently
booting with a value whose JavaScript type no longer matches the node config.

## Checksums

Use Node.js `crypto.createHash("sha256")`.

Checksum scope:

- Canonicalize the compact generation with sorted object keys.
- Exclude the `checksum` field itself.
- Include `value`, `previous`, `sequence`, and `timestamp`.

Checksum failure must make that generation invalid. It must never silently fall
back to default while a valid previous generation exists.

## Power-Loss Cases

The implementation must tolerate power loss:

- before the temporary file is created;
- while writing the temporary file;
- after the temporary file is written but before rename;
- after replacing `active.json`;
- after replacing `active.json` but before `previous.json` is updated;
- while logging or updating config.

Expected outcome: after restart, either the old value or the new value is
recovered. A truncated, empty or checksum-invalid value file must not erase the
last valid generation.

## Test Plan

Add tests before changing production behavior:

- load legacy file and migrate to value-store format;
- reject truncated JSON and recover `previous.json`;
- reject checksum mismatch and recover `previous.json`;
- recover `active.json` when `previous.json` is corrupt;
- ignore stale temporary files;
- save when wall clock moves backwards;
- preserve value through repeated restart with invalid wall clock;
- serialize rapid writes to one state;
- enforce numeric min/max during recovery;
- log missing/corrupt/recovered/defaulted cases distinctly.

The tests should use temporary directories and direct module-level helpers where
possible. Node-RED runtime integration tests can come after the storage helper is
covered.

## Implementation Phases

### Phase 1: Storage Helpers

Create a small internal storage module, for example:

```text
lib/persistentStore.js
```

Responsibilities:

- canonical JSON stringify;
- checksum wrapping and validation;
- same-directory staged write;
- active/previous generation recovery;
- strict state-name validation;
- v0.4 value-directory migration helpers.

Implemented as `lib/persistentStore.js` with isolated `node:test` coverage and
wired into the Node-RED state node.

### Phase 2: State Node Integration

Update `lib/state.js` to:

- initialize config and value paths;
- recover runtime value from `persistentStore`;
- keep `exposedState()` compatible, including `history: []` as a deprecated
  field;
- write current value through `persistentStore`;
- serialize writes per state;
- log recovery conditions.

Implemented runtime path:

- writes compact value generations through `persistentStore`;
- writes config metadata to `<sharedStateDir>/<StateName>/config.json`;
- prefers valid compact generations during startup;
- migrates a `v0.4.0` `.values/<StateName>` directory into the state directory
  layout when the new layout has no compact generation;
- moves an old top-level `<sharedStateDir>/<StateName>` file aside if it blocks
  directory creation;
- recovers from `previous.json` when `active.json` is corrupt.
- serializes overlapping writes and coalesces queued updates so only the latest
  runtime state is persisted after an in-flight write completes.
- converts recovered values through the current data type configuration before
  activating them.

Remaining work in this phase is to improve visible Node-RED recovery/status
messages.

### Phase 3: Hardening

Add:

- node status for recovered/defaulted/corrupt cases;
- platform-specific durability notes;
- fault-injection tests for abrupt interruption.

### Phase 4: Release

Before tagging the next release:

- run storage tests on Windows;
- run the package in local Node-RED 5 / Node.js 24;
- test install from GitHub branch;
- create a state, write values, restart Node-RED, verify recovery;
- test corrupt `active.json` and valid `previous.json`;
- update `History.md` from `Unreleased` to the release date.

## Decisions Needed

- Is one previous generation enough, or do critical states need more than one?
- Should missing/corrupt critical values inhibit operation, raise a visible
  alarm, or default?

## Accepted Decisions

- `history` remains in `msg.state`, global context, and persisted JSON for
  compatibility only.
- New state nodes default `historyCount` to `0`.
- Runtime code keeps `history` empty instead of appending entries on value
  changes.
- `history` is not a recovery source. The compact value-store design will use
  explicit active/previous generations with checksums.
- One `sharedStateDir` root with one directory per state is the active `v0.5.0`
  layout.
- `State Name` must match `^[A-Za-z_][A-Za-z0-9_]*$` and is used directly as
  the filesystem directory name.
