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
# The workspace runs as the business's founder user, never the routine run user. The host's
# unit record names the founder; a host without one is not ready.
founder_record=$("$node" -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); const slot=r.slot; if(r.unit!==process.argv[2]||!Number.isInteger(slot)||slot<0||slot>8||r.founder_user!=="abu-founder-"+slot||r.founder_uid!==2101+slot)process.exit(1); console.log(r.founder_user+" "+r.founder_uid)' "/etc/abu/harness/$business/unit.json" "$business" 2>/dev/null) || {
  printf 'Install the platform release that creates the founder user first.\n' >&2
  exit 1
}
read -r founder founder_uid <<<"$founder_record"
[ "$(id -u "$founder")" = "$founder_uid" ]
founder_home=$(getent passwd "$founder" | cut -d: -f6)
[ "$founder_home" = /home/"$founder" ]
checkout=$founder_home/workspace
workspace_state=$founder_home/.local/share/baron-workspace
# Refuse a source directory or host assigned to another business.
"$node" -e 'const fs=require("node:fs"); const h=JSON.parse(fs.readFileSync("/etc/abu/harness-host.json")); if(h.unit!==process.argv[1]||h.runtime!=="harness")process.exit(1); const u=new URL(process.argv[2]); if(u.origin!==process.argv[2] || !(u.protocol==="https:"||(u.protocol==="http:"&&["localhost","127.0.0.1"].includes(u.hostname))))process.exit(1)' "$business" "$parent_origin"
stage=$(cd "$(dirname "$0")" && pwd)
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
bash "$destination/persist.sh" "$business"
if [ ! -e "$checkout/.git" ]; then
  [ -z "$(find "$checkout" -mindepth 1 -maxdepth 1 -print -quit)" ]
  git clone --no-hardlinks "$source" "$checkout"
fi
# A checkout root still owns is this installer's own clone, from this run or an interrupted one.
# persist.sh made the folder the founder's, so git as root refuses it ("dubious ownership"): hand the
# clone over first, then make the branch as the founder, which also never runs the repository's hooks as root.
if [ "$(stat -c %u "$checkout/.git")" = 0 ]; then
  chown -R "$founder:$founder" "$checkout"
  runuser -u "$founder" -- env HOME="$founder_home" git -C "$checkout" switch -c baron-workspace
fi
[ -d "$checkout/.git" ] && [ ! -L "$checkout" ]
install -d -m 0700 -o "$founder" -g "$founder" "$founder_home/.local" "$founder_home/.local/share" "$workspace_state"
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
