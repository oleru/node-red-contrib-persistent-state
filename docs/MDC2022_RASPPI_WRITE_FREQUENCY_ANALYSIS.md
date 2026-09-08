# MDC2022 raspPI persistent write frequency analysis

Source inspected:

- Repository: `oleru/MDC2022`
- Branch: `main`
- Flow: `raspPI/flows.json`

This is a static Node-RED flow analysis. It estimates which persistent
variables are most likely to write to disk when the system is in sweep mode,
assuming the lamp is running and position feedback is active.

## Important distinction

There are two different frequencies:

1. How often a `set-shared-state` node receives a message.
2. How often `node-red-contrib-state` actually writes the state file.

The current component writes only when the value changes and the node's
`saveInterval` gate allows the write.

## Highest expected disk write rate

### `myHoursOfUseLamp`

Expected disk write rate: about once per minute while the lamp is on.

Evidence:

- In tab `R60`, inject node `Timer 1/3600 hours` repeats every 1 second.
- It sends payload `0.000278`, which is approximately one second expressed in
  hours.
- The switch only passes the update when `LampOnOff == 3`.
- Function `Update myHoursOfUseLamp` increments `global.myHoursOfUseLamp`.
- The result is sent to `set-shared-state` for `myHoursOfUseLamp`.
- The shared-state config has `saveInterval: "60000"`.

Interpretation:

- The variable is updated in memory every second while lamp-on state is active.
- It is persisted at most every 60 seconds.
- In sweep mode with lamp on, this is likely the most regular persistent write.

## High message rate, but deliberately delayed persistence

### `Horizontal_pos_act`

Expected disk write rate during continuous sweep: low, usually only after
position updates stop for 10 seconds.

Evidence:

- MODBUS function `Horiz. pos. RAW=>ACT.` converts raw position feedback.
- It sends position values through `link out Horiz Pos Raw`.
- The R50 dashboard receives this through `link in Horiz Pos`.
- Dashboard node `Horizontal Heading` has `passthru: true`.
- Before `set-shared-state Horizontal_pos_act`, there is a trigger node with:
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

### `Vertical_pos_act`

Expected disk write rate during continuous sweep: low, same behavior as
`Horizontal_pos_act`.

Evidence:

- MODBUS function `Vert. pos. RAW=>ACT.` converts raw position feedback.
- It sends position values through `link out Vert Pos Raw`.
- The R50 dashboard receives this through `link in Vert Pos`.
- Dashboard node `Vertical Heading` has `passthru: true`.
- Before `set-shared-state Vertical_pos_act`, there is a trigger node with:
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

## Sweep parameters, usually not written by the sweep loop itself

The R60 sweep state machine reads these persistent variables:

- `H302` horizontal sweep negative limit
- `H304` horizontal sweep positive limit
- `H306` vertical sweep negative limit
- `H308` vertical sweep positive limit
- `H318` horizontal allowed sector negative limit
- `H320` horizontal allowed sector positive limit
- `H322` vertical allowed sector negative limit
- `H324` vertical allowed sector positive limit

These variables have `saveInterval: "1000"`.

They are written from UI numeric fields and from the R60 FINS memory-write path
through `link out H`. The sweep state machine itself reads these values and
uses them to choose targets; it does not directly persist them on every sweep
iteration.

Interpretation:

- If an external controller repeatedly writes these H registers during sweep,
  they could persist at up to about once per second per changing variable.
- In normal sweep operation where the limits are just configuration, they are
  not expected to be frequent disk writers.

## Sweep state machine loop

The node `Handle State machine for Sweep` is triggered by an inject node that
repeats every 1 second.

It reads persistent/global values such as:

- `Horizontal_pos_act`
- `Vertical_pos_act`
- `H302`
- `H304`
- `H306`
- `H308`
- `H318`
- `H320`
- `H322`
- `H324`

It changes command/register state in memory, but the inspected path does not
show it directly writing these values through `set-shared-state`.

## Lower expected write rate

These variables are likely operator setup/configuration values and are not
expected to write continuously in sweep mode:

- `Horizontal_speed`
- `Vertical_speed`
- `H104`
- `H105`
- `H106`
- `H107`
- `H118`
- `H120`
- `H150`
- `H151_00`
- `H200`
- `H210`
- `H220`
- `H260`
- `H261`
- `H310`
- `H312`
- `H314`
- `H316`
- `Horizontal_pos_puls_ratio`
- `Vertical_pos_puls_ratio`
- `HorizontalInitValue`
- `VerticalInitValue`
- `SystemMaxPowerHoriz`
- `SystemMaxPowerVert`
- `SystemMaxPowerFocus`
- `SystemType`
- `IgnitionTime`
- `LimpModeHor`
- `LimpModeVert`
- `LimpModeFocus`
- `myAlarmLimitLamp`
- `myTimesOfStrikesLamp`
- `SL`

Some of these can be updated by UI, initialization, FINS writes, or reset
flows, but they do not appear to be written continuously by the sweep loop.

## Practical ranking for SD wear risk

1. `myHoursOfUseLamp`
   - Most regular expected disk writer in sweep/lamp-on mode.
   - About one write per minute because of `saveInterval: "60000"`.

2. `Horizontal_pos_act` and `Vertical_pos_act`
   - High live message rate, but persistence is delayed by a 10 second
     extendable trigger.
   - Expected to write when movement/feedback quiets, not continuously during
     uninterrupted sweep.

3. Sweep/sector limit H registers
   - `H302`, `H304`, `H306`, `H308`, `H318`, `H320`, `H322`, `H324`.
   - Can write up to once per second if an external FINS writer keeps changing
     them.
   - Not expected to write often if they behave as configuration.

4. Remaining setup/configuration variables
   - Mostly operator or initialization driven.

## Recommendation for the persistent-state fork

For write endurance and robustness tests, start with these scenarios:

1. `myHoursOfUseLamp` as the regular long-running counter case.
2. `Horizontal_pos_act` and `Vertical_pos_act` as high-message-rate,
   delayed-persistence cases.
3. `H302`/`H304`/`H306`/`H308` as external-register-write cases.

This gives good coverage of the three relevant patterns: periodic counter,
position feedback, and externally written configuration/register values.
