# Persistence policy decision

Date: 2026-09-08

Status: Accepted for `v0.2.0` implementation planning

## Decision

Keep the existing `saveInterval` meaning for standard state variables.

Add an explicit opt-in persistence policy for position-like values instead of
reusing `saveInterval = 0` as a special position mode.

Proposed modes:

- `standard`
- `position`

`standard` remains compatible with the original component:

- Persist only when the value changes.
- Use `saveInterval` as the minimum interval between disk writes.
- `saveInterval = 0` means persist every accepted changed value.

`position` is for physical position feedback such as:

- `Horizontal_pos_act`
- `Vertical_pos_act`

The position policy should support:

- `minPersistDelta`, for example `0.5` degrees.
- `checkpointIntervalMs`, for example `5000`.
- `quietPersistDelayMs`, for example `10000`.
- Comparison against last successfully persisted value, not only the previous
  runtime value.
- Robust storage using active/previous/temp files and checksum.

## Rationale

Most existing `saveInterval = 0` variables are configuration, setup,
register-like, boolean, or string values. They normally idle and only write
after an actual operator, initialization, reset, or external register change.

They should not inherit numeric delta logic. For these variables, a small value
change may be meaningful, and for boolean/string values a numeric threshold does
not make sense.

Physical position values are different. They can receive frequent updates while
the searchlight moves, and can also oscillate slightly because of AB counter
behavior, sea motion, wind, or vibration. These values need controlled
checkpointing rather than immediate write-on-every-change or delayed write only
after complete quiet.

## Consequences

Existing flows stay compatible by default.

Only variables explicitly configured with `position` policy receive the new
delta/checkpoint behavior.

The first expected production candidates are:

- `Horizontal_pos_act`
- `Vertical_pos_act`

`myHoursOfUseLamp` should remain standard state. It may be slowed down by
increasing `saveInterval`, because it is not operationally critical.

## Implementation Notes

Position policy should write when both conditions are true:

- Absolute difference between current value and last successfully persisted
  value is at least `minPersistDelta`.
- At least `checkpointIntervalMs` has passed since the last successful
  persistence.

It should also write the final settled value after `quietPersistDelayMs` without
new meaningful movement.

Power-loss warning should not trigger a special panic write before robust
storage is implemented. Once robust storage exists, it may request a checkpoint
only if the last successful checkpoint is older than the configured threshold.

## Related Analysis

- `docs/MDC2022_RASPPI_WRITE_FREQUENCY_ANALYSIS.md`
- `docs/FILE_IO_FAILURE_ANALYSIS.md`
- `docs/PERSISTENT_VALUE_STORE_DESIGN.md`
