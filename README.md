node-red-contrib-persistent-state
=================================

Persistent shared-state nodes for Node-RED with hardened value storage.

This repository is forked from
[lorenwest/node-red-contrib-state](https://github.com/lorenwest/node-red-contrib-state),
starting at upstream commit
[`61e3964a03d92a0527c7ea353b6f17c8f610e23b`](https://github.com/lorenwest/node-red-contrib-state/commit/61e3964a03d92a0527c7ea353b6f17c8f610e23b)
(`node-red-contrib-state` 1.6.1).

This fork keeps the existing Node-RED node types and flow-facing message shape,
while hardening persistence for isolated, power-cycled installations.

## Project Scope

This fork is intended to:

- preserve the existing `shared-state`, `get-shared-state`, and `set-shared-state`
  node types;
- keep the existing flow-facing node contracts stable during the pre-1.0
  migration phase;
- document all material changes from the upstream baseline;
- retain the original MIT license and copyright notice.

Hardening work includes monotonic save gating, atomic file replacement,
validated recovery, last-known-good generations for critical state, and explicit
logging of missing, corrupt, recovered and defaulted values.

`v0.5.0` uses one directory per state below `shared-state`. Each directory
contains `config.json`, `active.json`, and `previous.json`. Runtime values are
stored only in the compact value generations; `config.json` contains state
definition metadata, including the optional `defaultValue`.

See [Persistent Value Store Design](docs/PERSISTENT_VALUE_STORE_DESIGN.md) for
the storage design. See [Factory Defaults Design](docs/FACTORY_DEFAULTS_DESIGN.md)
for the factory reset and deployment-default workflow. See
[Timestamp Usage Analysis](docs/TIMESTAMP_USAGE_ANALYSIS.md) for timestamp,
history, and `saveInterval` behavior.

## Installation From GitHub

To replace the original package:

```sh
npm remove node-red-contrib-state
npm install github:oleru/node-red-contrib-persistent-state#v0.5.0
```

For SSH-based installation:

```sh
npm install git+ssh://git@github.com/oleru/node-red-contrib-persistent-state.git#v0.5.0
```

For the current development branch after `v0.5.0`:

```sh
npm install git+ssh://git@github.com/oleru/node-red-contrib-persistent-state.git#codex/v0.6.0
```

Restart Node-RED after installation.

Do not install this package alongside the original `node-red-contrib-state` in the
same Node-RED user directory, because both packages currently register the same
Node-RED node types.

## Compatibility Notes

`v0.3.0` changes `saveInterval` handling. When a changed value arrives before
the interval has elapsed, the runtime value still updates immediately, and the
latest value is now written later when the interval expires.

The original behavior skipped that disk write completely unless another value
change arrived later. Flows that implicitly depended on skipped writes never
reaching disk should review this change before upgrading.

`v0.3.0` also deprecates active history handling. The `history` field remains in
`msg.state`, global context, and the persisted JSON for compatibility, but it is
kept as an empty array and is no longer used to decide whether a value should be
saved. New state configurations default `historyCount` to `0`. Use `value`,
`prev`, and `timestamp` for current and previous value handling.

`v0.5.0` normalizes recovered values through the current
`shared-state` data type configuration. For example, a stored numeric `7` is
recovered as `"7"` after changing the node from Number to String. If the newest
generation cannot be converted safely, recovery can try the previous compact
generation before falling back to migration sources or defaults.

`v0.5.0` also makes `State Name` the filesystem folder name. State names must
match `^[A-Za-z_][A-Za-z0-9_]*$`: ASCII letters, digits, and underscore only,
starting with a letter or underscore. Hyphens, `$`, spaces, dots, slashes,
Unicode letters, and national characters are rejected.

`defaultValue` is used only when no valid persisted value can be recovered. When
the field is left blank, the runtime uses the selected data type default:
Number `0`, String `""`, Boolean `false`, and Object `null`. Filled Object
defaults must be valid JSON.

`v0.5.0` also adds an initial `factory defaults` node. It can validate and
write `<sharedStateDir>/factory-defaults.json`, generate a template from active
`shared-state` variables, and apply selected defaults by an explicit JSON
command with `confirm: true`.

`v0.6.0` development adds number-only `Stream values` persistence controls for
fast-changing numeric signals. The runtime value and change events still update
on every accepted change, but disk writes can be gated by minimum value delta,
stream write interval, and stable-value delay.

New storage layout:

```text
shared-state/
  factory-defaults.json
  myNumber/
    config.json
    active.json
    previous.json
```

### v0.5.0 Runtime Files

Each state directory contains:

- `config.json` - state metadata from the `shared-state` config node, including
  data type, unit fields, tags, and `defaultValue`;
- `active.json` - newest validated runtime value generation;
- `previous.json` - previous validated runtime value generation, used as the
  first recovery fallback if `active.json` is missing, corrupt, or invalid for
  the current data type.

The compact value files contain only dynamic runtime data:

```json
{
  "value": 14,
  "previous": 7,
  "sequence": 12,
  "timestamp": 1788871747022,
  "checksum": "..."
}
```

The checksum is SHA-256 over the canonical JSON payload without the checksum
field. It is used for integrity checking and generation recovery, not for
security or access control.

### Error Reporting

The fork reports common state errors as explicit Node-RED node errors and
statuses. Missing config references, invalid numeric values, non-JSON-compatible
payloads, corrupt value files, and factory-default validation problems should
show a clear message instead of leaking generic `undefined` or null-reference
errors.

### Stream Values

`Stream values` is available only when `Data Type` is `Number`. It is intended
for high-frequency numeric streams such as position, heading, or sensor values
where every runtime update matters, but every tiny movement should not
necessarily hit the SD card.

Default stream settings:

- `Minimum delta`: `1` value unit
- `Stream interval`: `3000` ms
- `Stable delay`: `1000` ms

When enabled, the state node:

- updates `msg.state`, global context, and downstream change events normally;
- writes immediately when the value has moved by at least `Minimum delta` and
  the `Stream interval` allows a new write;
- queues only the latest runtime value when updates arrive faster than the
  write interval;
- writes a changed value after `Stable delay` when the value has remained the
  same through the delay period, even if identical samples keep arriving;
- treats `Stream interval = -1` as disabled periodic delta persistence, useful
  when only stable-value persistence should write to disk;
- treats `Stable delay = -1` as disabled stable-value persistence;
- treats `0` as immediate write when that rule matches.

Stream persistence parameters can be tuned at runtime without changing the
state value payload. Send overrides on the message that updates the state:

```json
{
  "payload": 42,
  "streamPersistence": {
    "minPersistDelta": 5,
    "streamSaveInterval": -1,
    "streamStableDelay": 1500
  }
}
```

The shorter aliases `minimumDelta`, `streamInterval`, and `stableDelay` are
also accepted. Runtime overrides stay active for that `shared-state` node until
the node is redeployed or restarted. Only include the parameters that should
change; omitted parameters keep their current runtime/configured value.

## Upstream README

The original upstream README content follows.

This contributes [Node-RED](http://nodered.org/) nodes for defining logical state,
sharing that state across nodes, tracking history, and triggering flows based on change.

![](https://github.com/lorenwest/node-red-contrib-state/blob/master/img/AnimatedExample.gif)

Shared state with history is persisted, remaining stable across reboots of Node-RED.

## Logical State

State associated with a physical device is considered physical state. Logical state 
are computations such as "Person Is In The Room", usually a combination of physical
state and some computation.

Logical state helps with system understanding. "Person Is In The Room" may be the
combination of many physical and logical states, and can be used for example, 
in determining room HVAC profile.

These nodes provide a place to represent that logical state, share it with other
nodes, persist it, keep history, and provide state change triggers for flows.

## Data Typing

State nodes can specify data types offering inbound type conversions, min/max
limiting, and unit of measure awareness and conversion.

## Setting State

State is set by sending the value to the setState node in the _msg.payload_. After saving
to disk, the new state is made available to all mechanisms described in the _Getting State_
section below.

If data type is specified, setting state will assure the correct data type is represented.

State nodes with compatible units of measure can be chained for unit of measure conversion.

## Factory Defaults

The `defaults` node is used for commissioning and controlled reset
workflows. It lists active `shared-state` variables in the editor, can generate
or validate `factory-defaults.json`, and accepts runtime JSON commands.

Reset all states selected in the node:

```json
{
  "command": "factoryReset",
  "all": true,
  "confirm": true
}
```

Generate or extend the deployment defaults file:

```json
{"command":"generateTemplate","missingOnly":true}
```

Factory reset values are selected from `factory-defaults.json`, then from the
state's configured `defaultValue`, then from the type default. Values such as
`0`, `""`, `false`, and `null` are treated as explicit defaults.

## Getting State

Once state is set and persisted using the _Setting State_ section above, the new state is
made available with the getState node and in the global state context.

### The getState Node

The getState node can be dropped onto any flow to trigger a message on initialization, and on
state change. The _msg.topic_ contains the state name, the _msg.payload_ contains the state value,
and the _msg.state_ object contains an object with the following structure 
`{value:value, prev:prev_value, timestamp:num, history:history, config:config}`. In this fork,
`history` is a deprecated compatibility field kept as an empty array. Timestamps are milliseconds from the Unix epoch
because they serialize nicely, they work well for `Date()` construction, and they simplify
computing durations between timestamps. The `config` element is the state configuration, containing
any metadata defined on the state node such as data type, unit of measure, etc.

### Shared State with Global Context

The global context object contains a _state_ element - an object containing the current state 
and history for all state elements in all flows. This is available for all function and
custom nodes needing to use logical state to perform their task.

The keys in the _state_ object are the state names, and the values are the same structure
as the _msg.state_ object defined in the getState node above.

An example using the function node:

```
let isRoomOccupied = global.get("state").isRoomOccupied.value;
```

Another useful way to obtain shared state is to add it to a message using the _Change_ node:

![](https://raw.githubusercontent.com/lorenwest/node-red-contrib-state/master/img/ChangeNode.png)

## Shared State Storage

Shared state is saved onto the filesystem on state change. This assures stability
across server restarts.

Each state is written to a file in a _./shared-state_ directory within the current Node-RED application
directory. If that isn't a good place to save state on your system, the global context _sharedStateDir_ 
value can be used to override this default. 

This can be placed in the _settings.js_ file under the _functionGlobalContext_ property.

Example settings.js:

```
  functionGlobalContext: {
    sharedStateDir: '/opt/data/node-red-shared-state'
  },
```

See the 
[Global Context](https://nodered.org/docs/user-guide/writing-functions#global-context) 
discussion for further information.

## See Also

* [Representing Binary State with Confidence](https://github.com/lorenwest/node-red-contrib-state/wiki/Binary-State-with-External-Validation)

## Historical Upstream Installation

The original upstream package can be installed from the Node-RED palette as
`node-red-contrib-state`. This maintained fork is installed from GitHub using
the commands above until it is published through npm.

## License

MIT License. See [LICENSE.txt](LICENSE.txt), the
[upstream license](https://raw.githubusercontent.com/lorenwest/node-red-contrib-state/master/LICENSE.txt),
and the [MIT license reference](https://opensource.org/license/mit) for more details.
