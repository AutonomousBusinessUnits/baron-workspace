#!/usr/bin/env bash
# Run as root on an already provisioned Baron business host. Never opens an inbound port.
set -euo pipefail
export PATH=/opt/abu/harness-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 077
business=${1:?business slug}
release=${2:?committed release SHA}
parent_origin=${3:?Baron origin}
[[ "$business" =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ && ${#business} -le 40 ]]
[[ "$release" =~ ^[a-f0-9]{40}$ ]]
[ "$(id -u)" = 0 ]
[ "$(uname -s)" = Linux ]
state=/var/lib/abu/$business
source=$state/source
node=/opt/abu/harness-node/bin/node
[ -x "$node" ] && [ -e "$source/.git" ]
stage=$(cd "$(dirname "$0")" && pwd)
# The workspace runs as the business's founder user, never the routine run user.
source "$stage/founder-record.sh"
load_founder "$business"
checkout=$founder_home/workspace
workspace_state=$founder_home/.local/share/baron-workspace
# Refuse a source directory or host assigned to another business.
"$node" -e 'const fs=require("node:fs"); const h=JSON.parse(fs.readFileSync("/etc/abu/harness-host.json")); if(h.unit!==process.argv[1]||h.runtime!=="harness")process.exit(1); const u=new URL(process.argv[2]); if(u.origin!==process.argv[2] || !(u.protocol==="https:"||(u.protocol==="http:"&&["localhost","127.0.0.1"].includes(u.hostname))))process.exit(1)' "$business" "$parent_origin"
"$node" -e 'const r=require(process.argv[1]); if(r.revision!==process.argv[2])process.exit(1)' "$stage/release.json" "$release"
destination=/opt/abu/baron-workspace/releases/$release
if [ ! -f "$destination/.installed" ]; then
  install -d -m 0755 /opt/abu/baron-workspace /opt/abu/baron-workspace/releases "$destination"
  cp -a "$stage/." "$destination/"
  (cd "$destination"; npm ci --omit=dev --no-audit --no-fund)
  chown -R root:root "$destination"
  chmod -R a+rX,go-w "$destination"
  touch "$destination/.installed"
fi
# Stop only this installed service before copying its SQLite state and provider login.
systemctl stop "baron-workspace@$business.service" 2>/dev/null || { ! systemctl is-active --quiet "baron-workspace@$business.service"; }
quiesce_founder
bash "$destination/persist.sh" "$business"
# Git never runs as root in a folder root does not own: persist.sh made the checkout the founder's,
# and Git as root there refuses it ("dubious ownership") and would run the repository's hooks as root.
# A new checkout is cloned by root into a root-owned folder, handed to the founder, then copied in
# by the founder; the branch is always made by the founder.
make_branch=false
if [ ! -e "$checkout/.git" ]; then
  refuse_symlinks_under "$founder_home" "$checkout"
  [ -z "$(find "$checkout" -mindepth 1 -maxdepth 1 -print -quit)" ]
  clone_parent=$(mktemp -d /var/tmp/baron-workspace-clone.XXXXXX)
  trap 'rm -rf "$clone_parent"' EXIT
  clone=$clone_parent/checkout
  git clone --no-hardlinks "$source" "$clone"
  chown -hR "$founder:$founder" "$clone"
  chmod 0711 "$clone_parent"
  runuser -u "$founder" -- env HOME="$founder_home" cp -a "$clone/." "$checkout/"
  rm -rf "$clone_parent"
  trap - EXIT
  make_branch=true
fi
refuse_symlinks_under "$founder_home" "$checkout"
refuse_symlinks_under "$founder_home" "$workspace_state"
# A .git root still owns is left by a failed run of an earlier installer: hand it to the founder too.
if [ "$(stat -c %u "$checkout/.git")" = 0 ]; then
  chown -hR "$founder:$founder" "$checkout"
  make_branch=true
fi
if [ "$make_branch" = true ]; then
  runuser -u "$founder" -- env HOME="$founder_home" git -C "$checkout" switch -c baron-workspace
fi
[ -d "$checkout/.git" ]
# Made as the founder: root never follows a founder-planted symlink to create or own a directory.
founder_mkdir "$workspace_state"
"$node" "$destination/provider-bootstrap.ts" "$business"
cat >"/etc/systemd/system/baron-workspace@$business.service" <<EOF
[Unit]
Description=Baron workspace for $business
After=network-online.target
Wants=network-online.target
ConditionPathIsDirectory=$source
RequiresMountsFor=$checkout $workspace_state $founder_home/.codex

[Service]
Type=simple
User=$founder
Group=$founder
WorkingDirectory=$checkout
Environment=PATH=/opt/abu/harness-node/bin:/opt/abu/harness-cli/node_modules/.bin:/usr/local/bin:/usr/bin:/bin
Environment=T3CODE_BARON_ORIGIN=$parent_origin
ExecStart=$node $destination/dist/bin.mjs start --no-browser --mode web --host 127.0.0.1 --port 3773 --base-dir $workspace_state --auto-bootstrap-project-from-cwd $checkout
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true
InaccessiblePaths=/opt/abu/harness-releases /var/lib/abu/$business/runs /var/lib/abu/$business/browser /home/abu-$business
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF
install -d -m 0700 /etc/abu/baron-workspace
"$node" -e 'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({slug:process.argv[2],revision:process.argv[3],user:process.argv[4]}),{mode:0o600})' "/etc/abu/baron-workspace/$business.json" "$business" "$release" "$founder"
systemctl daemon-reload
systemctl enable --now "baron-workspace@$business.service"
systemctl restart "baron-workspace@$business.service"
systemctl is-active --quiet "baron-workspace@$business.service"
ready=false
for attempt in {1..30}; do
  if curl --max-time 2 --fail --silent http://127.0.0.1:3773/ >/dev/null; then ready=true; break; fi
  sleep 1
done
[ "$ready" = true ] || { printf 'The workspace did not answer HTTP. Read its service journal.\n' >&2; exit 1; }
printf 'Baron workspace installed for %s at release %s; loopback port 3773.\n' "$business" "$release"
