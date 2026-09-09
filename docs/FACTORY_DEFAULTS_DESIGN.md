# Factory Defaults Design

Status: implemented in `v0.5.0`. The helper module, Node-RED node, editor
controls, file validation, template writing, and runtime commands are part of
the package.

## Goal

The package should support a controlled factory-default workflow for many
persistent shared-state values at once.

The design must support two use cases:

- a commissioning/design user who wants Node-RED to generate and validate a
  complete default-value template;
- a deployment process that wants to provide a known `factory-defaults.json`
  file as the interface for site-specific default values.

Factory defaults are not ordinary startup recovery. They must only be applied
when an explicit factory-reset command is run.

## File Location

The factory-default file lives at the shared-state root:

```text
<sharedStateDir>/factory-defaults.json
```

Per-state runtime files remain in their own directories:

```text
<sharedStateDir>/<StateName>/config.json
<sharedStateDir>/<StateName>/active.json
<sharedStateDir>/<StateName>/previous.json
```

## File Format

The factory-default file is JSON:

```json
{
  "schema": "persistent-state.factory-defaults.v1",
  "defaults": {
    "myEnabled": false,
    "myNumber": 0,
    "mySettings": {
      "mode": "auto",
      "limits": [1, 2, 3]
    },
    "myText": ""
  }
}
```

The `defaults` object maps `State Name` to a JSON-compatible value.

Valid values include:

- `null`
- strings
- finite numbers
- booleans
- arrays
- nested plain-object JSON trees

The runtime must use `Object.hasOwn(defaults, stateName)` semantics. Values such
as `0`, `""`, `false`, and `null` are real factory-default values, not missing
values.

## Value Selection Rule

When a factory reset is explicitly requested for a state, select the reset value
in this order:

1. Use the value from `factory-defaults.json` if the file is enabled and the
   state exists in `defaults`.
2. Otherwise use the `defaultValue` configured on the `shared-state` node.
3. Otherwise use the type default:

```text
Number  -> 0
String  -> ""
Boolean -> false
Object  -> null
```

All selected values must be converted and validated through the current
`shared-state` data type configuration before they are written.

If a configured Object default is filled in, it must be valid JSON. If it is not
valid JSON, that state must fail validation and must not be written.

## Design Node

Add a third Node-RED editor node:

```text
factory-defaults
```

This node appears in the palette as `defaults`. It is a design and
administration node, not a normal state value node.

The editor lists active `shared-state` variables in the current flow set. It
collects candidates from the active Node-RED editor model, active
`get state` / `set state` node references, and a visible-canvas fallback for
state nodes that have been edited but not fully materialized in the editor model
yet. The deployed server-side flow list remains a fallback when browser-side
state discovery is unavailable.

For each state, the user can:

- include or exclude the state from this factory-default scenario;
- see the state name and configured data type;
- see or edit the proposed factory-default value;
- use the state node's `defaultValue`;
- use the deterministic type default;
- optionally copy the current runtime value into the factory-default field.

If only a visible canvas label is available before deployment, the editor can
list the state name but cannot know all config metadata yet. In that case it
uses the deterministic type/default fallback until the real `shared-state`
config node is available.

The design node exposes these actions:

- `Load from file`
- `Validate file`
- `Generate template`
- `Generate missing only`
- `Write file`

`Generate template` creates a full `factory-defaults.json` from the selected
states. For each selected state it uses:

1. an explicit value already configured in the factory-defaults node;
2. otherwise the state node's `defaultValue`;
3. otherwise the state type default.

`Generate missing only` reads the existing file and adds only selected states
that are missing. It must not overwrite values already present in
`factory-defaults.json`.

`Write file` writes a canonical, pretty-formatted `factory-defaults.json` so the
file is stable in source control and easy to inspect during deployment.

## Runtime Commands

Factory reset is available through JSON commands. A command may reset all
states selected by the factory-defaults node or a specific list of states.

Example:

```json
{
  "command": "factoryReset",
  "source": "factory-defaults.json",
  "states": ["myNumber", "myMode"],
  "confirm": true
}
```

Example for all states in the configured scenario:

```json
{
  "command": "factoryReset",
  "source": "factory-defaults.json",
  "all": true,
  "confirm": true
}
```

The command requires an explicit confirmation field. The runtime does not
perform a factory reset from an accidental or partial message.

If confirmation is missing, the node reports a red status and emits:

```text
factoryReset requires confirm: true
```

## Batch Behavior

For many values, factory reset should be handled as a batch:

1. Resolve the target states.
2. Load and validate `factory-defaults.json` if file use is enabled.
3. Resolve the candidate value for every target state.
4. Convert and validate every candidate value.
5. Report validation failures before writing where possible.
6. Write valid states through the normal `active.json` / `previous.json`
   generation mechanism.
7. Return a machine-readable result.

Result shape:

```json
{
  "ok": true,
  "updated": ["myNumber", "myMode"],
  "skipped": [],
  "failed": []
}
```

If some states fail and others succeed, `ok` is `false`, with a clear `failed`
list. Failures are never silent.

## File Validation And Node Status

If the user has enabled use of `factory-defaults.json`, the file becomes an
explicit dependency and validation state must be visible in Node-RED.

Status mapping:

```text
green dot   loaded and valid
yellow ring file missing; fallback to shared-state defaultValue/type default
red ring    file exists but has invalid JSON, invalid schema, or invalid format
red dot     factory reset was attempted and one or more selected states failed
grey ring   file use is disabled
```

Rules:

- If file use is disabled, a missing file is not an error.
- If file use is enabled and the file is missing, show a yellow warning and use
  fallback values.
- If the file exists but is invalid, show a red error and do not use values from
  that file.
- If a state is missing from a valid file, use the state's `defaultValue`.
- If a state exists in a valid file with `null`, use `null`.
- If a state exists in a valid file but cannot be converted to the configured
  type, do not write that state and include it in the failure report.

Both runtime status and editor/admin validation endpoints should return the same
validation result so the design dialog and deployed runtime agree.

## Startup Behavior

The runtime must not automatically apply `factory-defaults.json` on boot.

Normal startup remains:

1. recover `active.json` or `previous.json`;
2. recover from supported migration sources;
3. initialize from `defaultValue` or type default only when no valid runtime
   value exists.

Factory defaults are applied only by an explicit factory-reset command.

## Deployment Contract

`factory-defaults.json` is the deployment-facing interface for default values.
It may be generated by Node-RED design tooling, checked into deployment assets,
or written manually by a deployment process.

The design node should make the file easy to generate, but runtime validation
must still be strict. A malformed deployment file must produce a visible error
instead of being guessed or partially interpreted.

## Implementation Notes

The `v0.5.0` implementation uses `lib/factoryDefaultsStore.js` for
`factory-defaults.json` validation/canonicalization and `lib/factoryDefaults.js`
for the Node-RED node. Factory reset writes through the same durable
`active.json` / `previous.json` value-store path as ordinary state changes, so
checksums, sequence handling, type conversion, and recovery behavior stay
consistent.

Further UI polish can still be added without changing the file format or
command contract.

## Accepted Decisions

- `factory-defaults.json` lives at `<sharedStateDir>/factory-defaults.json`.
- The file is a deployment interface, not a boot-time override.
- The design node should be able to generate a full template from all selected
  active `shared-state` variables.
- Missing values in `factory-defaults.json` fall back to `shared-state`
  `defaultValue`, then type default.
- Falsy JSON values are valid defaults and must not be treated as missing.
- If file use is enabled, file validation problems must be visible on the node
  status.
