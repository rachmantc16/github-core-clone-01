# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/rachmantc16/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/rachmantc16/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge that runs as a single Node process with no dependencies beyond the standard library. It serves git smart HTTP (protocol v0 and v2: clone, push, fetch, shallow/deepen, annotated tags), the REST v3 API (repos, contents, branches, commits, labels, issues, pull requests with squash merges), a GraphQL subset with Relay-style global ids and cursor pagination, and an MCP endpoint (modern `server/discover` plus the legacy handshake) — all over one shared in-memory store. The git object model, including pack reading/writing and delta resolution, is implemented in-process; no git binary is used.

## Run it

There is nothing to install (Node ≥ 22.18, standard library only). The harness provides `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` in the environment; the entry binds an ephemeral port, registers it with the env, serves until the env says the trial is done, and exits 0.

```sh
npm start
```

which runs:

```sh
node --experimental-strip-types main.ts
```

## Lifecycle

The entrypoint (`main.ts`) binds an ephemeral port — or a port from `ENTRY_PORT` / the `ENTRY_PORT_MIN`–`ENTRY_PORT_MAX` range for local runs — registers it with the env, and serves until the env reports the trial done. On startup it logs the app version, the bound address, and a readiness line once registered; `SIGINT`/`SIGTERM` close the server gracefully within `ENTRY_SHUTDOWN_TIMEOUT_MS` (default 5 s). Port 8080 is never bound: the env lives there.

---
<sub>Entered on [make.fun](https://make.fun/?ref=pas2z9sw&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
