# Example flow persistent write frequency analysis

Source inspected:

- Source: anonymized Node-RED flow test case
- Branch: not applicable
- Flow: example `flows.json`

This is a static Node-RED flow analysis. It estimates which persistent
variables are most likely to write to disk when the system is in sweep mode,
assuming the represented device is running and position feedback is active.

## Important distinction

There are two different frequencies:

1. How often a `set-shared-state` node receives a message.
2. How often `node-red-contrib-state` actually writes the state file.

The current component writes only when the value changes and the node's
`saveInterval` gate allows the write.

## Highest expected disk write rate

### `RuntimeHoursCounter`

Expected disk write rate: about once per minute while the equipment is on.

Evidence:

- In the runtime tab, an inject node repeats every 1 second.
- It sends payload `0.000278`, which is approximately one second expressed in
  hours.
- A switch only passes the update when equipment state is active.
- A function increments `global.RuntimeHoursCounter`.
- The result is sent to `set-shared-state` for `RuntimeHoursCounter`.
- The shared-state config has `saveInterval: "60000"`.

Interpretation:

- The variable is updated in memory every second while active state is present.
- It is persisted at most every 60 seconds.
- In continuous-operation mode, this is likely the most regular persistent
  write.

## High message rate, but deliberately delayed persistence

### `Axis1_PositionActual`

Expected disk write rate during continuous sweep: low, usually only after
position updates stop for 10 seconds.

Evidence:

- A protocol adapter function converts raw position feedback.
- It sends position values through a link node.
- A dashboard numeric field receives this feedback.
- The dashboard node has `passthru: true`.
- Before `set-shared-state Axis1_PositionActual`, there is a trigger node with:
  - `duration: "10"`
  - `units: "s"`
  - `extend: true`
  - `op1type: "nul"`
  - `op2type: "payl"`
- The shared-state config has `saveInterval: "0"`.

Interpretation:

- If feedback arrives repeatedly during sweep, the trigger keeps extending.
- The persistent state is not written for every feedback value.
- It writes the latest value after 10 seconds without new updates.
- If feedback is sparse or pauses between movements, it can write after each
  quiet period.

### `Axis2_PositionActual`

Expected disk write rate during continuous movement: low, same behavior as
`Axis1_PositionActual`.

Evidence:

- A protocol adapter function converts raw position feedback.
- It sends position values through a link node.
- A dashboard numeric field receives this feedback.
- The dashboard node has `passthru: true`.
- Before `set-shared-state Axis2_PositionActual`, there is a trigger node with:
  - `duration: "10"`
  - `units: "s"`
  - `extend: true`
  - `op1type: "nul"`
  - `op2type: "payl"`
- The shared-state config has `saveInterval: "0"`.

Interpretation:

- Same as horizontal position.
- The variable may see high live message traffic, but disk writes should be
  delayed until feedback quiets for 10 seconds.

## Movement parameters, usually not written by the control loop itself

The example control loop reads these persistent variables:

- `Axis1_LimitNegative`
- `Axis1_LimitPositive`
- `Axis2_LimitNegative`
- `Axis2_LimitPositive`
- `Axis1_AllowedNegative`
- `Axis1_AllowedPositive`
- `Axis2_AllowedNegative`
- `Axis2_AllowedPositive`

These variables have `saveInterval: "1000"`.

They are written from UI numeric fields and from an external register-write
path. The control loop itself reads these values and uses them to choose
targets; it does not directly persist them on every iteration.

Interpretation:

- If an external controller repeatedly writes these H registers during sweep,
  they could persist at up to about once per second per changing variable.
- In normal operation where the limits are just configuration, they are
  not expected to be frequent disk writers.

## Control-loop reads

The example control-loop node is triggered by an inject node that repeats every
1 second.

It reads persistent/global values such as:

- `Axis1_PositionActual`
- `Axis2_PositionActual`
- `Axis1_LimitNegative`
- `Axis1_LimitPositive`
- `Axis2_LimitNegative`
- `Axis2_LimitPositive`
- `Axis1_AllowedNegative`
- `Axis1_AllowedPositive`
- `Axis2_AllowedNegative`
- `Axis2_AllowedPositive`

It changes command/register state in memory, but the inspected path does not
show it directly writing these values through `set-shared-state`.

## Lower expected write rate

These variables are likely operator setup/configuration values and are not
expected to write continuously in sweep mode:

- `Axis1_Speed`
- `Axis2_Speed`
- `Register_104`
- `Register_105`
- `Register_106`
- `Register_107`
- `Register_118`
- `Register_120`
- `Register_150`
- `Register_151_00`
- `Register_200`
- `Register_210`
- `Register_220`
- `Register_260`
- `Register_261`
- `Register_310`
- `Register_312`
- `Register_314`
- `Register_316`
- `Axis1_PositionPulseRatio`
- `Axis2_PositionPulseRatio`
- `Axis1_InitValue`
- `Axis2_InitValue`
- `SystemMaxPowerAxis1`
- `SystemMaxPowerAxis2`
- `SystemMaxPowerAux`
- `SystemType`
- `StartupDelay`
- `SafeModeAxis1`
- `SafeModeAxis2`
- `SafeModeAux`
- `AlarmLimitRuntime`
- `StrikeCounter`
- `SystemLock`

Some of these can be updated by UI, initialization, external writes, or reset
flows, but they do not appear to be written continuously by the sweep loop.

## Practical ranking for SD wear risk

1. `RuntimeHoursCounter`
   - Most regular expected disk writer in sweep/lamp-on mode.
   - About one write per minute because of `saveInterval: "60000"`.

2. `Axis1_PositionActual` and `Axis2_PositionActual`
   - High live message rate, but persistence is delayed by a 10 second
     extendable trigger.
   - Expected to write when movement/feedback quiets, not continuously during
     uninterrupted sweep.

3. Movement/sector limit registers
   - `Axis1_LimitNegative`, `Axis1_LimitPositive`, `Axis2_LimitNegative`,
     `Axis2_LimitPositive`, `Axis1_AllowedNegative`,
     `Axis1_AllowedPositive`, `Axis2_AllowedNegative`,
     `Axis2_AllowedPositive`.
   - Can write up to once per second if an external register writer keeps changing
     them.
   - Not expected to write often if they behave as configuration.

4. Remaining setup/configuration variables
   - Mostly operator or initialization driven.

## Recommendation for the persistent-state fork

For write endurance and robustness tests, start with these scenarios:

1. `RuntimeHoursCounter` as the regular long-running counter case.
2. `Axis1_PositionActual` and `Axis2_PositionActual` as high-message-rate,
   delayed-persistence cases.
3. Limit/register variables as external-register-write cases.

This gives good coverage of the three relevant patterns: periodic counter,
position feedback, and externally written configuration/register values.
