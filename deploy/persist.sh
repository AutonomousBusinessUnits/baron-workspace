#!/usr/bin/env bash
# Preserve the user's home paths while keeping their contents on the retained business disk.
set -euo pipefail
umask 077
business=${1:?business slug}
[[ $business =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ && ${#business} -le 40 ]]
[ "$(id -u)" = 0 ]
mountpoint -q /var/lib/abu
user=abu-$business
home=/home/$user
state=/var/lib/abu/$business/coding-workspace
[ "$(getent passwd "$user" | cut -d: -f6)" = "$home" ]
! systemctl is-active --quiet "baron-workspace@$business.service"
install -d -m 0700 "$state"
install -d -m 0700 -o "$user" -g "$user" "$home/.local" "$home/.local/share"
for entry in project state codex; do
  case $entry in
    project) target=$home/workspace ;;
    state) target=$home/.local/share/baron-workspace ;;
    codex) target=$home/.codex ;;
  esac
  retained=$state/$entry
  [ ! -L "$retained" ] && [ ! -L "$target" ]
  if mountpoint -q "$target"; then
    [ "$target" -ef "$retained" ] || { printf 'Workspace path has an unexpected mount.\n' >&2; exit 1; }
  else
    if [ ! -d "$retained" ]; then
      pending=$state/.$entry-migration
      [ ! -e "$pending" ] || { printf 'Reconcile the interrupted workspace migration first.\n' >&2; exit 1; }
      install -d -m 0700 -o "$user" -g "$user" "$pending"
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
    install -d -m 0700 -o "$user" -g "$user" "$target"
  fi
  [ -d "$retained" ] && [ "$(stat -c %u "$retained")" = "$(id -u "$user")" ]
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
