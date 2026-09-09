# Timestamp Usage Analysis

Status: analysis of the upstream-compatible baseline and the `v0.2.0`/`v0.3.0`
runtime corrections.

## Question

Map where `timestamp` and `ts` are used today, and whether they are used to
select the current value.

## Summary

The upstream-compatible baseline does not use `timestamp` or `history[].ts` to
choose between multiple persisted values during startup. Startup reads one file
per state and accepts that file's top-level `value`.

The active behavioral use of timestamps is write gating: on update, the node
sets `timestamp = Date.now()`, compares it with `history[0].ts`, and only writes
the new state file when:

```js
node.config.historyCount > 0 &&
node.timestamp - prev_ts >= parseInt(node.config.saveInterval, 10)
```

In the baseline, this means a backwards-moving wall clock can prevent new values
from entering history and prevent the state file from being written. The
timestamp does not directly select the current value, but it can indirectly
prevent the desired current value from becoming the value stored on disk.

The first `v0.2.0` correction keeps the public fields, but changes the persistence
decision so:

- backwards wall-clock movement triggers a save instead of suppressing one;
- `historyCount = 0` clears history but no longer prevents the top-level
  `value` from being persisted;
- when there is no `history[0].ts`, the previous top-level `timestamp` is used
  as the save-interval reference.

The `v0.3.0` correction deprecates active history handling. The `history` field
still exists in `msg.state`, global context, and the legacy JSON file shape, but
it is kept as an empty array and is no longer appended to on value changes. New
state nodes default `historyCount` to `0`.

## Runtime Locations

### Initial Fields

File: `lib/state.js`

The state node initializes:

```js
node.timestamp = 0;
node.history = [];
```

These are part of the exposed state object and persisted legacy file shape.

### Exposed State Shape

File: `lib/state.js`

`exposedState()` returns:

```js
{
  value: node.value,
  prev: node.prev,
  timestamp: node.timestamp,
  history: node.history,
  config: node.config,
}
```

This object is used in:

- persisted state file writes;
- `global.state.<name>`;
- `msg.state` emitted by get/set nodes.

So `timestamp` and `history` are part of the public compatibility surface.
`timestamp` remains useful metadata. `history` is now a deprecated compatibility
field and should no longer drive persistence decisions.

### Update Path

File: `lib/state.js`

On every accepted value change:

```js
node.timestamp = Date.now();
```

Then the code reads the newest history timestamp:

```js
var prev_ts = 0;
if (node.history !== undefined &&
    node.history[0] !== undefined &&
    node.history[0].ts !== undefined)
  prev_ts = node.history[0].ts;
```

Then it decides whether to add the value to history and write the file:

```js
if (node.config.historyCount > 0 &&
    node.timestamp - prev_ts >= parseInt(node.config.saveInterval, 10)) {
  node.history.splice(0,0,{val:node.value, ts:node.timestamp});
  node.trimHistory();
  await writeFile(node.stateFile, JSON.stringify(node.exposedState()));
}
```

This was the only active timestamp-based decision found in the baseline runtime
code.

Effects:

- `saveInterval = 0` means every accepted changed value can be written, as long
  as `Date.now() - history[0].ts >= 0`.
- If wall-clock time moves backwards behind the newest stored `history[0].ts`,
  the expression becomes negative.
- While the expression is negative, the value still changes in memory and emits
  a change event, but the file is not updated.
- On restart, the file still contains the last successfully written value, not
  necessarily the last accepted runtime value.

### History Trimming

File: `lib/state.js`

`trimHistory()` treats the history array as newest-first:

```js
// history[0] = current, history[1] = current - 1, history[2] = current - 2, ...
let trimNum = node.history.length - node.config.historyCount;
if (trimNum > 0) {
  node.history.splice(node.history.length - trimNum, trimNum);
}
```

The timestamp is not used here. Ordering is produced by inserting each saved
value at index `0`, then trimming older tail entries.

### Startup From Global Context

File: `lib/state.js`

If `global.state.<name>` already exists, startup calls:

```js
node.initFromObj(thisState);
```

`initFromObj()` copies:

```js
node.value = external.value,
node.prev = external.prev,
node.timestamp = external.timestamp,
node.history = external.history,
```

No timestamp comparison occurs. The external object's top-level `value` is
accepted.

### Startup From Filesystem

File: `lib/state.js`

If there is no initialized global state, startup calls:

```js
let file = await readFile(node.stateFile);
node.initFromObj(JSON.parse(file));
```

Again, no timestamp comparison occurs. The parsed file's top-level `value` is
accepted.

This means today's file is authoritative as a whole. There is no recovery
selection between `value`, `history[0].val`, and timestamps.

### Get Node Emission

File: `lib/getState.js`

The get node emits:

```js
node.send({
  topic:node.sharedState.name,
  state: node.sharedState.exposedState(),
  payload:JSON.parse(JSON.stringify(node.sharedState.value)),
});
```

It does not inspect `timestamp` or `history[].ts`. It simply forwards the
current in-memory value and exposed metadata.

### Set Node

File: `lib/setState.js`

The set node only calls:

```js
node.sharedState.update(msg.payload, msg);
```

It does not inspect timestamps.

## Editor And Documentation Locations

### Node Help

File: `lib/getState.html`

Help text documents:

```text
timestamp - Timestamp of the state change in Date.now() format
history - an array of state change {val:value, ts:timestamp} objects, sorted newest to oldest
```

### README

File: `README.md`

README documents the public shape:

```text
{value:value, prev:prev_value, timestamp:num, history:history, config:config}
```

and describes timestamps as milliseconds from Unix epoch.

## Baseline Failure Mechanism

The defect is not "timestamp chooses an old value over a new value" directly.

The defect is:

1. A value is loaded from disk with a future or later `history[0].ts`.
2. The device restarts with wall-clock time earlier than that timestamp.
3. A new value is accepted in memory.
4. `Date.now() - history[0].ts` is negative or too small.
5. The new value is not added to history and the state file is not written.
6. If power is lost or Node-RED restarts, recovery reads the old file value.

So `ts` is an active persistence gate, not a recovery selection key.

## Implemented `v0.2.0` Correction

The first runtime correction changes the active decision to:

```text
previous timestamp = history[0].ts when present, otherwise previous top-level timestamp
elapsed = Date.now() - previous timestamp
save when clock moved backwards or elapsed >= saveInterval
```

When the save condition is met:

- `historyCount > 0` records the new value at `history[0]` and trims history;
- `historyCount = 0` writes the top-level `value` with an empty history array.

This preserves the legacy file shape while separating "persist current value"
from "retain history entries".

## Implemented `v0.3.0` Save Interval Correction

`saveInterval` now throttles immediate disk writes without losing the latest
accepted value.

The previous behavior was:

```text
accept changed value
if saveInterval has not elapsed:
  update runtime state only
  do not write now
  do not write later unless another value change arrives
```

That allowed runtime state and persisted file state to diverge. For example, a
Node-RED UI could show value `8` while the state file still contained `7`; a
restart would then recover `7`.

The `0.3.0` behavior is:

```text
accept changed value
if saveInterval has elapsed:
  persist immediately
else:
  schedule one delayed trailing write when the interval expires
```

If more values arrive while the delayed write is pending, the timer is not
duplicated. When the timer fires, it persists the latest runtime value.

This is a compatibility-affecting correction. Any previous flow that implicitly
depended on skipped `saveInterval` writes never reaching disk will now persist
the last accepted value after the interval. The intended meaning of
`saveInterval` is "do not write more often than this", not "drop writes that
arrive too early".

## Implemented `v0.3.0` History Deprecation

Active history maintenance is deprecated in this fork.

The runtime behavior is:

```text
accept changed value
update value, prev, and timestamp
keep history as []
persist exposed state when the save policy allows it
```

`historyCount` remains in node configuration so old flows import cleanly, but
new nodes default it to `0`. Existing files with historical entries are still
accepted during startup; the loaded runtime state normalizes `history` to an
empty array, and the next successful write compacts the file.

This closes the earlier open design point. `history` remains a compatibility
field only. It is not a recovery source, not a current-value selector, and not a
redundant backup of `value`.

## Design Implications

For the `v0.2.0` and `v0.3.0` direction, the smallest compatible changes are:

- keep top-level `timestamp` and `history` in `msg.state` for compatibility;
- stop using backwards wall-clock timestamps to suppress writes;
- use the last successfully persisted top-level timestamp as the save-interval
  reference;
- keep a runtime timer for delayed trailing writes when `saveInterval` blocks
  immediate persistence;
- allow the file's top-level `value` to remain authoritative during simple
  legacy startup;
- keep `history` empty and deprecated until a later major compatibility decision
  removes it from the public shape.

## Open Questions

- Should `saveInterval` throttle disk writes only, or should it also throttle
  legacy metadata updates?
- Should `timestamp` remain in the public `msg.state` object for compatibility
  even if it is informational only?
- Should startup keep accepting only top-level `value`, or should a valid
  compact value-store generation repair a missing top-level legacy value?
