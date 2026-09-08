# Persistence policy decision

Date: 2026-09-08

Status: Accepted for `v0.2.0` implementation planning

## Decision

Keep the existing `saveInterval` meaning for standard state variables.

Add explicit opt-in persistence policies for data categories that need behavior
beyond standard configuration persistence. Do not reuse `saveInterval = 0` as a
hidden signal for any specialized policy.

Proposed modes:

- `standard`
- `sampledNumeric`

`standard` remains compatible with the original component:

- Persist only when the value changes.
- Use `saveInterval` as the minimum interval between disk writes.
- `saveInterval = 0` means persist every accepted changed value.

`sampledNumeric` is for measured numeric feedback where values may update often
or oscillate slightly, but where persistence should represent useful
checkpoints instead of every sample. Examples include physical position,
heading, level, pressure, or other numeric process values.

The sampled numeric policy should support:

- `minPersistDelta`, in the unit of the value.
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

Measured numeric feedback values are different. They can receive frequent
updates while the physical system changes, and can also oscillate slightly
because of sensors, counters, vibration, noise, environmental movement, or
rounding. These values need controlled checkpointing rather than immediate
write-on-every-change or delayed write only after complete quiet.

The original discussion used searchlight position as a concrete case, but the
decision is about data categories:

- Configuration and register-like values use `standard`.
- Sampled/measured numeric feedback can opt in to `sampledNumeric`.
- Counters and statistics can usually stay `standard` and use a longer
  `saveInterval` if they are not operationally critical.

## Consequences

Existing flows stay compatible by default.

Only variables explicitly configured with a specialized policy receive
delta/checkpoint behavior.

The first expected production candidates from the MDC2022 raspPI case are:

- `Horizontal_pos_act`
- `Vertical_pos_act`

Those are examples of physical position feedback and should not define the
whole feature.

The MDC2022 `myHoursOfUseLamp` case is an example of a non-critical statistic.
It should remain standard state and can be slowed down by increasing
`saveInterval`.

## Implementation Notes

The sampled numeric policy should write when both conditions are true:

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
