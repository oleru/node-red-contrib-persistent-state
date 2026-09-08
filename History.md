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
    sharper green so the Torka-maintained fork is easier to identify in flows.
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
