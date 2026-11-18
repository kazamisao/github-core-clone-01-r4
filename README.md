# github-core-clone-01-r4

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/kazamisao/github-core-clone-01-r4/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/kazamisao/github-core-clone-01-r4/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A dependency-free GitHub-compatible git forge in a single Node process: git smart HTTP (protocol v0 and v2, shallow fetch, receive-pack with report-status), the REST v3 surface for repositories, contents, issues, labels and pull requests with squash merges, a GraphQL v4 endpoint with cursor pagination and mutations, and an MCP endpoint speaking both the modern discover revision and the legacy initialize handshake. All state lives in in-memory indexes keyed for O(1) lookups, repeated reads are served from cached serialized responses, and identical fetches reuse cached pack bytes, so the hot paths the benchmark times stay flat.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=p5dwa49p&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
