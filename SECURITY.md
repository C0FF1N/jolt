# Security policy

Jolt gives software on your computer control of a browser tab you connect, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private reporting: on the repository, open the **Security** tab and
choose **Report a vulnerability**. Include what you found, how to reproduce it, and the version (shown in the extension
popup and by `npx jolt-mcp --version`).

You can expect an acknowledgement within 7 days and a status update within 14 days. This is a one-maintainer project, so
fixes follow as quickly as is realistic; critical issues come first. Please give a reasonable time to fix before any
public disclosure; credit is given if you want it.

## Supported versions

Only the latest 1.x release of the extension and the `jolt-mcp` package receives fixes.

## Scope

In scope: the extension (`apps/extension`), the server (`apps/server`), the setup script (`scripts/setup.mjs`), and
anything that lets a web page or another local party read or drive a tab without the user connecting it, bypass the
loopback/origin/host checks, or escalate the extension's permissions.

Out of scope: what your MCP client or its AI provider does with data once you connect a tab (that is governed by that
client), the unmodified upstream copy in `baseline/`, and issues that require the attacker to already control your
browser profile or operating-system account.

## What is already documented

[docs/security.md](docs/security.md) describes the trust model, every control that is enforced (and which test covers
it), and the **known limitations**, including the lack of a pairing secret between the extension and the server. A report
that restates a documented limitation is still welcome if you have a concrete improvement.

## Hardening you can rely on

Loopback-only listener; web-page origins and non-loopback `Host` headers rejected; one explicitly connected tab; no
content scripts; no remote code (enforced at build time); password values never included in snapshots; answers from local
servers validated before use.
