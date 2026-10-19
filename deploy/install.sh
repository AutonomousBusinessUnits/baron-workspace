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
user=abu-$business
state=/var/lib/abu/$business
source=$state/source
node=/opt/abu/harness-node/bin/node
[ -x "$node" ] && [ -e "$source/.git" ] && id "$user" >/dev/null
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
install -d -m 0700 -o "$user" -g "$user" "$state/workspace"
cat >"/etc/systemd/system/baron-workspace@$business.service" <<EOF
[Unit]
Description=Baron workspace for $business
After=network-online.target
Wants=network-online.target
ConditionPathIsDirectory=$source

[Service]
Type=simple
User=$user
Group=$user
WorkingDirectory=$source
Environment=PATH=/opt/abu/harness-node/bin:/opt/abu/harness-cli/node_modules/.bin:/usr/local/bin:/usr/bin:/bin
Environment=T3CODE_BARON_ORIGIN=$parent_origin
ExecStart=$node $destination/dist/bin.mjs serve --host 127.0.0.1 --port 3773 --base-dir $state/workspace --auto-bootstrap-project-from-cwd $source
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "baron-workspace@$business.service"
systemctl restart "baron-workspace@$business.service"
systemctl is-active --quiet "baron-workspace@$business.service"
printf 'Baron workspace installed for %s at release %s; loopback port 3773.\n' "$business" "$release"
