# Baron Workspace

This fork puts T3 Code's web interface in Baron. Each business's existing EC2
host runs one server as its unprivileged `abu-<slug>` user. Chat, files, terminals,
Git and previews act on that host's canonical source checkout. Autonomous business
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
with persistent state under `/var/lib/abu/<slug>/workspace`. It creates no EC2
instance, inbound rule, provider login or API key. Providers need that business's
own credentials. Never give the workspace Baron's or the platform's keys.

Use SSM port forwarding for operator validation. A founder-facing deployment needs
an authenticated HTTPS/WebSocket transport to the same loopback service and a
separate browser origin for each business. Do not expose port 3773 publicly.

Set `T3CODE_BARON_ORIGIN` to the exact parent origin. HTML responses then restrict
framing to that origin. T3's pairing and permission checks still apply; framing is
not authentication. Baron binds its workspace page to the business's enrolled
EC2 instance, through `BARON_T3_WORKSPACES` in the platform checkout.

## Verify and roll back

Verify the service, pair through T3, open a terminal, check `uname -s` and the
working directory, then write and read a nonsecret marker on the business's own
host. An agent answer additionally requires a successful provider turn; a running
server does not prove model access.

Stop access with `systemctl disable --now baron-workspace@<slug>.service` and remove
that business's Baron binding. Preserve its workspace state and canonical source.
Reinstall a previous verified release to roll back the executable.
