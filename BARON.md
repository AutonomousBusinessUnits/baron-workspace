# Baron Workspace

This fork puts T3 Code's web interface in Baron. Each business's existing EC2
host runs one server as its unprivileged `abu-<slug>` user. Chat, files, terminals,
Git and previews act on an unprivileged working copy on that host. Autonomous business
routines keep their existing harness and scheduler.

The fork retains T3's MIT license and third-party notices. Upstream is
<https://github.com/pingdotgg/t3code>, initially pinned at
`9448aa572a75082a6434889ba0981c553d9eef3c`.

## Build and install

Install the pinned dependencies, run `pnpm exec vp run --filter t3 build`, and commit
the changes. `node scripts/baron-package.mjs /absolute/new/staging-directory` stages
the server and web app, resolves its runtime dependencies for Linux x64, and records
the source commit. Archive that directory and record the archive's SHA-256 before
uploading it through the existing host artifact transport.

On the selected EC2 host, verify the archive's SHA-256, extract it to a root-only
staging directory and run:

```sh
bash install.sh <business-slug> <fork-commit> https://trybaron.ai
```

The installer verifies the host's recorded business, existing Linux user and source
checkout. It installs `baron-workspace@<slug>.service`, bound to `127.0.0.1:3773`,
with a persistent checkout at `/home/abu-<slug>/workspace` and state under that
user's `.local/share/baron-workspace`. The checkout is seeded from the canonical
source without shared Git objects; upgrades preserve the founder's work. The
root-owned canonical source is never made readable or writable by this user.
Publishing changes back to the operating source still needs its existing review
and reconciliation path. The installer creates no EC2 instance, inbound rule or
API key. If no Codex login exists, it signs in using the business's already declared
`/abu/<slug>/secrets/openai_key`, passed to Codex through stdin. Existing founder
logins are preserved. Never give the workspace Baron's or the platform's keys.

Use SSM port forwarding for operator validation. A founder-facing deployment needs
an authenticated HTTPS/WebSocket transport to the same loopback service and a
separate browser origin for each business. Do not expose port 3773 publicly.

Set `T3CODE_BARON_ORIGIN` to the exact parent origin. HTML responses then restrict
framing to that origin. Baron requests a one-use sign-in through the business's existing signed portal. The portal verifies the current founder and encrypts its reply to that request; SSM retains no usable credential. The browser exchanges the launch link automatically, then uses T3's normal scoped session. Framing is
not authentication. Baron binds its workspace page to the business's enrolled
EC2 instance, through `BARON_T3_WORKSPACES` in the platform checkout.

## Verify and roll back

Verify the service, open Workspace in Baron, open a terminal, check `uname -s` and the
working directory, then write and read a nonsecret marker on the business's own
host. An agent answer additionally requires a successful provider turn; a running
server does not prove model access.

Stop access with `systemctl disable --now baron-workspace@<slug>.service` and remove
that business's Baron binding. Preserve its workspace state and canonical source.
Reinstall a previous verified release to roll back the executable.
