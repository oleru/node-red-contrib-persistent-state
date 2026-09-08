# Persistent Value Store Design

Status: design plan for `0.3.0`. Some compatibility-preserving runtime
corrections are already implemented; the compact redundant value store remains
planned work.

## Goal

The fork should keep the existing Node-RED node types and flow-facing behavior,
but split state definition from durable runtime value storage.

The current upstream-compatible state file should be treated primarily as a
per-variable configuration and migration source. The current value should move to
a small redundant value-store format that contains only the current value,
metadata required for recovery, and a checksum over the persisted payload.

The main design requirement is power-loss tolerance: removing power at any point
during a write must not destroy the last accepted value. On restart, the node
must deterministically recover either the newest valid value generation or a
documented safe default, and it must log which path was used.

## Compatibility Contract

The first implementation must preserve:

- Node-RED type names: `shared-state`, `get-shared-state`, `set-shared-state`.
- Existing flow configuration nodes and references.
- Existing `msg.payload` and `msg.state` shape for readers.
- Existing `global.state.<name>` shape as far as practical.
- Import of existing `./shared-state/<stateName>` files.
- Existing type conversion, range, unit and label metadata.

The implementation may add internal metadata fields, status messages and log
messages as long as existing flows keep working.

## File Roles

### Config File

The existing state file path should remain:

```text
<sharedStateDir>/<stateName>
```

This file should become the human-readable state definition/config file. It may
also act as the migration source for legacy installations.

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
  "legacyImportedFrom": "upstream-1.6.1"
}
```

Open point: decide whether the config file should be rewritten on every deploy
or only when the config changes. The preferred default is only when the config
changes.

### Value Directory

Each state should get an internal value directory:

```text
<sharedStateDir>/.values/<stateName>/
```

This keeps the public config filename stable while isolating recovery mechanics.

Suggested files:

```text
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

## Legacy Import

The upstream `1.6.1` file contains:

```json
{
  "value": 7,
  "prev": 6,
  "timestamp": 1788787909167,
  "history": [],
  "config": {}
}
```

On first startup with the new store:

1. Read the legacy file from `<sharedStateDir>/<stateName>`.
2. Validate `value` against the current config.
3. Use the legacy `value` as the initial runtime value.
4. Start sequence at `1`.
5. Write `active.json`.
6. Rewrite or preserve the top-level file as config according to the config-file
   policy.

Legacy `history` must not be treated as redundancy. As of `v0.3.0`, the field is
kept in `msg.state`, global context, and persisted JSON for compatibility, but
the runtime keeps it as an empty array and does not actively maintain it.

This deliberately keeps the file and message shape familiar while removing
history as a source of persistence decisions. Current value handling should use
top-level `value`, `prev`, and `timestamp`. Future recovery must use the compact
value-store generations, sequence numbers, and checksums instead of history.

## Config Path Option

Add an optional global setting for explicit config/value roots:

```js
functionGlobalContext: {
  sharedStateDir: "/opt/data/node-red-shared-state",
  sharedStateConfigDir: "/opt/data/node-red-shared-state/config",
  sharedStateValueDir: "/opt/data/node-red-shared-state/values"
}
```

Resolution order:

1. Use `sharedStateConfigDir` and `sharedStateValueDir` when both are set.
2. Otherwise use `sharedStateDir` with `.values` below it.
3. Otherwise use `./shared-state` with `.values` below it.

Open point: decide whether separate config/value directories are needed for
Torka/Sealight/Neva, or whether a single `sharedStateDir` remains simpler.

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
- legacy import helpers.

Implemented in `v0.4.0` as `lib/persistentStore.js` with isolated
`node:test` coverage. This module is not yet wired into the Node-RED state node.

### Phase 2: State Node Integration

Update `lib/state.js` to:

- initialize config and value paths;
- recover runtime value from `persistentStore`;
- keep `exposedState()` compatible, including `history: []` as a deprecated
  field;
- write current value through `persistentStore`;
- serialize writes per state;
- log recovery conditions.

Implemented in `v0.4.0` for the first migration-safe runtime path:

- writes compact value generations through `persistentStore`;
- continues writing the legacy `<sharedStateDir>/<stateName>` file;
- prefers valid compact generations during startup;
- migrates a legacy state file into the compact store when no compact
  generation exists;
- recovers from `previous.json` when `active.json` is corrupt.

Remaining work in this phase is to serialize overlapping writes explicitly and
improve visible Node-RED recovery/status messages.

### Phase 3: Hardening

Add:

- optional separate config/value directories;
- node status for recovered/defaulted/corrupt cases;
- platform-specific durability notes;
- fault-injection tests for abrupt interruption.

### Phase 4: Release

Before tagging `v0.2.0`:

- run storage tests on Windows;
- run the package in local Node-RED 5 / Node.js 24;
- test install from GitHub branch;
- create a state, write values, restart Node-RED, verify recovery;
- test corrupt `active.json` and valid `previous.json`;
- update `History.md` from `Unreleased` to the release date.

## Decisions Needed

- Should the visible `<sharedStateDir>/<stateName>` file become config-only in
  `0.2.0`, or should we first keep it unchanged and add value files beside it?
- Is one previous generation enough, or do critical states need more than one?
- Should missing/corrupt critical values inhibit operation, raise a visible
  alarm, or default?
- Should config/value roots be separate settings, or is one `sharedStateDir`
  sufficient for now?

## Accepted Decisions

- `history` remains in `msg.state`, global context, and persisted JSON for
  compatibility only.
- New state nodes default `historyCount` to `0`.
- Runtime code keeps `history` empty instead of appending entries on value
  changes.
- `history` is not a recovery source. The compact value-store design will use
  explicit active/previous generations with checksums.
