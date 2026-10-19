# Contributing to Jolt

Thanks for helping. Small, focused pull requests with tests are the easiest to review and merge.

## Set up

You need Node 22+ and pnpm (`corepack enable` gives you the right version).

```bash
git clone https://github.com/C0FF1N/jolt.git
cd jolt
corepack enable
pnpm install
pnpm -r build        # server (dist/index.js + the single-file dist/jolt-server.mjs) and the extension (apps/extension/dist)
pnpm -r typecheck
pnpm test            # unit, tool-contract, protocol end-to-end, discovery, packaging (needs the build above)
```

Load `apps/extension/dist` in Chrome (`chrome://extensions` → Developer mode → Load unpacked) and run `pnpm run setup`
to register your build with your MCP client. Rebuild and click the extension's reload icon after changes.

## Layout

| Path | What |
|---|---|
| `apps/server` | the MCP server (`jolt-mcp`): tools, WebSocket link to the extension, `/info` discovery |
| `apps/extension` | the Chrome extension (MV3): service worker, popup, AI cursor, discovery and reconnect logic |
| `packages/*` | small shared modules (config, messaging types) |
| `baseline/` | an **unmodified copy of the upstream Browser MCP server**, used only as the reference in benchmarks and compatibility tests. Do not edit it. |
| `bench/` | tests that need more than a unit (end-to-end over real WebSockets) and the real-browser scripts |
| `store/` | Chrome Web Store listing copy and generated images |
| `docs/` | documentation, including the security model |

## Real-browser checks

`bench/src/real-ux.mjs`, `real-smoke.mjs` and `real-resilience.mjs` drive a real Chromium with a throw-away profile
(they never touch your own). They need a Playwright Chromium; set `JOLT_BENCH_CHROME` to a Chromium executable if yours
is elsewhere. Run them when you change the extension's connection or popup behaviour:

```bash
cd bench
node src/real-ux.mjs                      # discovery, two clients, cursor, reconnect (screenshots go to bench/results/ux)
node src/real-smoke.mjs
node src/real-resilience.mjs --idle=45
```

## Pull requests

- Write the test first when you can; a bug fix should come with a test that failed before it.
- Keep functions small and files focused (200-400 lines typical). Prefer immutability and early returns.
- Validate input at boundaries (everything from the page, the network and the other side of the WebSocket is untrusted).
- Use [conventional commit](https://www.conventionalcommits.org) messages (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`...).
- Update the docs and `CHANGELOG.md` for user-visible changes.
- `pnpm -r typecheck` and `pnpm test` must pass; CI runs them on Linux and Windows.

### Extension permissions are a hard line

The Chrome Web Store rejects unused or unjustified permissions, and users deserve a minimal set. Adding a permission,
a host permission or a content script needs a written justification in the pull request and an edit to
`ALLOWED_PERMISSIONS` in `scripts/package-extension.mjs`; CI fails otherwise. Also keep the extension free of `eval`,
`new Function`, remote code and sourcemaps (the same script checks this).

### Security issues

Please do **not** open a public issue. Follow [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), the same as the
rest of the project. Do not add code you do not have the right to contribute, and keep third-party notices intact.

## Conduct

Be kind and assume good faith; see the [Code of Conduct](CODE_OF_CONDUCT.md).
