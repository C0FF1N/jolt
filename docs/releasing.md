# Releasing

One version number lives in four files (`package.json`, `apps/server/package.json`, `apps/extension/package.json`,
`apps/extension/manifest.json`); `node scripts/check-versions.mjs` fails if they differ, in CI and on release.

## Cut a release

1. Pick the version (semver). Edit the four files, add a `CHANGELOG.md` entry.
2. `pnpm install && pnpm -r build && pnpm -r typecheck && pnpm test`
3. `pnpm package:extension` → `release/jolt-extension-<version>.zip` (+ `.sha256`). The script refuses to zip anything the
   Chrome Web Store would reject: unlisted permissions, a bad version or description length, `eval` / `new Function` /
   remote scripts, sourcemaps, missing icons.
4. Optionally run the real-browser checks (see [CONTRIBUTING.md](../CONTRIBUTING.md)) and load the extracted zip once.
5. Commit, then tag and push: `git tag v<version> && git push origin v<version>`.

The `Release` workflow then re-runs the checks and tests, attaches the extension zip, its checksum, `jolt-server.mjs`
and `THIRD_PARTY_NOTICES.txt` to a GitHub release, and publishes `jolt-mcp` to npm with provenance **if** the repository
has an `NPM_TOKEN` secret (an npm automation token; create it on npmjs.com → Access Tokens). It is safe to re-run: an
existing release is updated and an npm version that is already published is skipped.

## First-time setup (once)

- **npm:** create/sign in to an npm account, make an automation token, add it as the `NPM_TOKEN` repository secret.
  The first publish claims the name `jolt-mcp` (check it is still free: `npm view jolt-mcp`).
- **GitHub:** repository Settings → Code security → enable **Private vulnerability reporting** (SECURITY.md relies on it).
- **Chrome Web Store:** follow the checklist in [store/LISTING.md](../store/LISTING.md).

## Publishing the extension

The Web Store is a manual upload (a developer account is required): dashboard → the Jolt item → Package → upload the zip
→ complete the listing from `store/LISTING.md` → submit for review. Each upload needs a higher version than the last, so
bump the version for every resubmission, including after a rejection.

## Regenerating the store images

`node scripts/make-store-assets.mjs` re-renders everything in `store/assets/` from `store/templates/` against the real
popup (needs a built extension and a Playwright Chromium). Icons: `node scripts/make-icons.mjs`.

## After the store approves it

Add the store link to `README.md` and `apps/server/README.md`.
