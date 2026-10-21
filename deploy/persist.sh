#!/usr/bin/env bash
# Preserve the founder's home paths while keeping their contents on the retained business disk.
set -euo pipefail
umask 077
business=${1:?business slug}
[[ $business =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ && ${#business} -le 40 ]]
[ "$(id -u)" = 0 ]
mountpoint -q /var/lib/abu
node=/opt/abu/harness-node/bin/node
# The founder user comes from the host's unit record; the routine run user keeps no workspace files.
founder_record=$("$node" -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); const slot=r.slot; if(r.unit!==process.argv[2]||!Number.isInteger(slot)||slot<0||slot>8||r.founder_user!=="abu-founder-"+slot||r.founder_uid!==2101+slot)process.exit(1); console.log(r.founder_user+" "+r.founder_uid)' "/etc/abu/harness/$business/unit.json" "$business" 2>/dev/null) || {
  printf 'Install the platform release that creates the founder user first.\n' >&2
  exit 1
}
read -r founder founder_uid <<<"$founder_record"
[ "$(id -u "$founder")" = "$founder_uid" ]
home=/home/$founder
old_home=/home/abu-$business
run_uid=$(id -u "abu-$business")
state=/var/lib/abu/$business/coding-workspace
[ "$(getent passwd "$founder" | cut -d: -f6)" = "$home" ]
! systemctl is-active --quiet "baron-workspace@$business.service"
install -d -m 0700 "$state"
install -d -m 0700 -o "$founder" -g "$founder" "$home/.local" "$home/.local/share"
for entry in project state codex; do
  case $entry in
    project) target=$home/workspace ;;
    state) target=$home/.local/share/baron-workspace ;;
    codex) target=$home/.codex ;;
  esac
  retained=$state/$entry
  # An earlier install bound this entry into the routine run user's home. Retire that mount.
  case $entry in
    project) old_target=$old_home/workspace ;;
    state) old_target=$old_home/.local/share/baron-workspace ;;
    codex) old_target=$old_home/.codex ;;
  esac
  old_unit=$(systemd-escape --path --suffix=mount "$old_target")
  if [ -e "/etc/systemd/system/$old_unit" ]; then
    systemctl stop "$old_unit"
    systemctl disable "$old_unit" 2>/dev/null || true
    rm -f "/etc/systemd/system/$old_unit"
    systemctl daemon-reload
  fi
  [ ! -L "$retained" ] && [ ! -L "$target" ]
  if mountpoint -q "$target"; then
    [ "$target" -ef "$retained" ] || { printf 'Workspace path has an unexpected mount.\n' >&2; exit 1; }
  else
    if [ ! -d "$retained" ]; then
      pending=$state/.$entry-migration
      [ ! -e "$pending" ] || { printf 'Reconcile the interrupted workspace migration first.\n' >&2; exit 1; }
      install -d -m 0700 -o "$founder" -g "$founder" "$pending"
      if [ -d "$target" ]; then cp -a "$target/." "$pending/"; fi
      sync -f "$pending"
      mv "$pending" "$retained"
    fi
    # A replacement root disk can have fresh files here. Retain those separately; the retained disk is authoritative.
    if [ -e "$target" ] && [ -n "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
      backup=$target.baron-root-backup
      [ ! -e "$backup" ] || { printf 'Reconcile the existing root-disk workspace backup first.\n' >&2; exit 1; }
      mv "$target" "$backup"
    fi
    install -d -m 0700 -o "$founder" -g "$founder" "$target"
  fi
  [ -d "$retained" ]
  # Hand an entry the routine run user wrote to the founder. An interrupted chown can leave the
  # top directory handed over and its contents not, so the marker records a finished entry.
  marker=$state/.$entry-owner
  if [ "$(cat "$marker" 2>/dev/null || true)" != "$founder_uid" ]; then
    owner=$(stat -c %u "$retained")
    [ "$owner" = "$run_uid" ] || [ "$owner" = "$founder_uid" ] || { printf 'Workspace state has an unexpected owner.\n' >&2; exit 1; }
    chown -R "$founder:$founder" "$retained"
    sync -f "$retained"
    printf '%s\n' "$founder_uid" >"$marker"
  fi
  unit=$(systemd-escape --path --suffix=mount "$target")
  cat >"/etc/systemd/system/$unit" <<EOF
[Unit]
Description=Retained Baron workspace $entry for $business
RequiresMountsFor=/var/lib/abu
Before=baron-workspace@$business.service

[Mount]
What=$retained
Where=$target
Type=none
Options=bind
EOF
  systemctl daemon-reload
  systemctl start "$unit"
  [ "$target" -ef "$retained" ]
done
