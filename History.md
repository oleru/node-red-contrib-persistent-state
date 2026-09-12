0.6.1 - 2026-09-12
==================

  * Correct global context reads to use `global.get("state")` in the README,
    node help, and technical documentation.
  * Document value reads in Function nodes and custom node implementations,
    including variable state names and initialization requirements.
  * Replace a pending stability timer when the stream minimum-delta rule
    takes over, preventing early writes during continued movement.
  * Measure stream write intervals from the completed write rather than the
    timestamp of the saved sample.
  * Add regression coverage for the delta transition, 35 seconds of continuous
    movement, final-value persistence, and five seconds of unchanged idle files.

0.6.0 - 2026-09-09
==================

  * Start next development cycle for high-frequency stream persistence controls,
    including configurable save cadence, value hysteresis, and stable-value
    handling.
  * Add number-only `Stream values` configuration to the `shared-state` editor:
    `Minimum delta`, `Stream interval`, and `Stable delay`.
  * Apply stream persistence at runtime so fast numeric updates still flow
    through immediately while disk writes are gated by delta, interval, and
    quiet/stable delay.
  * Allow partial runtime tuning through `msg.streamPersistence`, define
    `Stream interval = -1` as stable-value-only persistence, and use `-1` as
    the disabled value for `Stable delay`.

0.5.0 - 2026-09-09
==================

  * Start next development cycle for per-state directory layout and explicit
    migration fallback.
  * Convert recovered compact and legacy values through the current
    `shared-state` data type configuration before activating them. Converted
    values are rewritten as compact generations, and invalid active
    generations can fall back to a valid `previous.json`.
  * Move storage to one directory per state:
    `<sharedStateDir>/<StateName>/config.json`, `active.json`, and
    `previous.json`.
  * Restrict `State Name` to `^[A-Za-z_][A-Za-z0-9_]*$` so the Node-RED state
    key can safely be used directly as the filesystem directory name.
  * Remove the `Legacy file` editor option from active `v0.5.0` behavior.
  * Add `Default Value` to `shared-state` configuration. When it is blank, the
    runtime uses the selected type default: Number `0`, String `""`, Boolean
    `false`, and Object `null`. Defaults are only used when no valid persisted
    value can be recovered.
  * Document the implemented `factory-defaults` design node, deployment-facing
    `factory-defaults.json` format, runtime reset commands, batch validation,
    and Node-RED status behavior.
  * Add the initial `factory defaults` node with file validation, template
    generation, `factoryReset` / `generateTemplate` / `validateFile` runtime
    commands, and batch reset through the existing durable value store.
  * Default blank legacy `History Keep` fields to `"0"` in the
    `shared-state` editor so new config nodes validate consistently even when
    Node-RED skips falsy numeric default values while building the dialog.
  * Scan shared-state config nodes from the active Node-RED editor model when
    opening the `defaults` editor, with the server-side flow listing kept as a
    fallback.
  * Include active `get state` and `set state` nodes in the `defaults` editor
    scan so newly added state users can contribute their referenced
    `shared-state` configuration before deployment.
  * Fall back to visible `get state` / `set state` canvas labels when
    Node-RED has not yet exposed a newly edited state through the active editor
    node model.
  * Report missing `shared-state` config references on `get state` and
    `set state` nodes as explicit node errors/status instead of leaking
    `undefined` or null-reference errors.
  * Report invalid numeric updates with the affected state name and original
    value before persistence validation runs.
  * Clean up README and factory-defaults documentation for the `v0.5.0`
    release.

0.4.0 - 2026-09-08
==================

  * Start next development cycle.
  * Add an internal persistent value-store module with canonical JSON,
    SHA-256 checksum wrapping, synced staged writes, `active.json` /
    `previous.json` generations, sequence-based recovery, and isolated tests.
  * Validate that persisted values are JSON-compatible, including scalar
    values, arrays, and nested object trees.
  * Wire the state node to the compact value store while continuing to write
    the legacy state file for compatibility.
  * Prefer valid compact value generations on startup, migrate legacy state
    files into the compact store, and recover from `previous.json` when
    `active.json` is corrupt.
  * Slim the value generation file to dynamic fields only: `value`,
    `previous`, `sequence`, `timestamp`, and a flat SHA-256 `checksum`.
  * Read early `v0.4.0` wrapped value files and rewrite them to the flat
    compact format during startup recovery.
  * Serialize writes per state and coalesce rapid updates so only the latest
    pending runtime value is persisted after an in-flight write completes.
  * Add a per-state `Legacy file` option. It defaults to updating the original
    state file with `value` / `prev` for compatibility, but can be disabled so
    the legacy file acts as configuration metadata only while compact value
    generations remain the active persistent value source.

0.3.0 - 2026-09-08
==================

  * Make state file read/write failures visible and distinguish missing files
    from corrupted or inaccessible state files.
  * Quarantine invalid JSON state files with a `.corrupt.<timestamp>` suffix
    so a later valid write can recreate the active state file without deleting
    the failed input.
  * Retry writes once after recreating the storage directory when it is missing.
  * Schedule a delayed trailing write when `saveInterval` suppresses an
    immediate write, so the latest runtime value is eventually persisted even
    if no further changes arrive.
  * Mark active history handling as deprecated. New shared-state nodes default
    `historyCount` to `0`, and the runtime keeps `history` as an empty
    compatibility field.

0.2.0 - 2026-09-08
==================

  * Changed get/set shared-state node editor color from light green to a
    sharper green so this maintained fork is easier to identify in flows.
  * Added a design plan for splitting per-state config from redundant
    checksum-protected runtime value storage.
  * Added an analysis of how `timestamp` and `history[].ts` currently affect
    persistence decisions.
  * Persist the current `value` even when `historyCount` is `0`.
  * Save on backwards wall-clock movement instead of letting a future
    `history[].ts` suppress persistence.

1.6.1 - 01/09/2022
==================

  * Fixed an "undefined" when reading ps from history and there isn't any… @colincoder

1.6.0 - 01/08/2022
==================

  * Added object clone on set and compare @colincoder
  * Added ability to fire only once @colincoder

1.5.1 - 09/01/2020
==================

  * Fixed boolean change misfire under certain conditions
    (see https://github.com/lorenwest/node-red-contrib-state/issues/5)

1.5.0 - 05/20/2020
==================

  * Added state label
  * Added data types with inbound type conversion
  * Added tags for classification

1.4.2 - 03/31/2020
==================

  * Fixed a history/persist issue #3

1.4.1 - 03/22/2020
==================

  * Moved is-valid-var-name from to dependencies

1.4.0 - 03/08/2020
==================

  * Publish animated gif
  * Assure state names are valid JS variables

1.3.1 - 02/26/2020
==================

  * Better documentation for set state node

1.3.0 - 02/26/2020
==================

  * Provide output for SET nodes
  * Initialize global state so it's always available

1.2.1 - 02/21/2020
==================

  * Improved documentation

1.2.0 - 02/03/2020
==================

  * Changed get/set node categories to 'common' for node-red 1.0.

1.1.0 - 02/02/2020
==================

  * Don't save state if history set to 0


1.0.0 - 01/31/2020
==================

  * Initial publish
