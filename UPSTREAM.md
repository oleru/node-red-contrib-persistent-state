# Upstream Baseline

This repository is a Torka/MDC-maintained fork of:

- Repository: https://github.com/lorenwest/node-red-contrib-state
- Package: `node-red-contrib-state`
- Upstream version: `1.6.1`
- Upstream branch: `master`
- Baseline commit: `61e3964a03d92a0527c7ea353b6f17c8f610e23b`
- Baseline commit URL: https://github.com/lorenwest/node-red-contrib-state/commit/61e3964a03d92a0527c7ea353b6f17c8f610e23b
- License: MIT, see `LICENSE.txt`
- MIT reference: https://opensource.org/license/mit

## Fork Intent

The fork keeps the existing Node-RED node type names and public message/state
shape as the initial compatibility contract for Torka, Sealight, Neva and MDC
flows.

The first implementation branch is:

```text
codex/persistent-state-baseline
```

The first hardening work should be developed from this baseline, with runtime
changes documented in `History.md` and release tags used for installation.
