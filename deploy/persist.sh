#!/usr/bin/env bash
# Preserve the founder's home paths while keeping their contents on the retained business disk.
set -euo pipefail
umask 077
business=${1:?business slug}
[[ $business =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ && ${#business} -le 40 ]]
[ "$(id -u)" = 0 ]
mountpoint -q /var/lib/abu
source "$(dirname "${BASH_SOURCE[0]}")/founder-record.sh"
load_founder "$business"
home=$founder_home
old_home=/home/abu-$business
run_uid=$(id -u "abu-$business")
state=/var/lib/abu/$business/coding-workspace
! systemctl is-active --quiet "baron-workspace@$business.service"
quiesce_founder
install -d -m 0700 "$state"
# Made as the founder: root never follows a founder-planted symlink to create or own a directory.
founder_mkdir "$home/.local/share"
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
  [ ! -L "$retained" ]
  refuse_symlinks_under "$home" "$target"
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
      refuse_symlinks_under "$home" "$backup"
      [ ! -e "$backup" ] || { printf 'Reconcile the existing root-disk workspace backup first.\n' >&2; exit 1; }
      mv "$target" "$backup"
    fi
    founder_mkdir "$target"
  fi
  [ -d "$retained" ]
  # Hand an entry the routine run user wrote to the founder. An interrupted chown can leave the
  # top directory handed over and its contents not, so the marker records a finished entry.
  marker=$state/.$entry-owner
  if [ "$(cat "$marker" 2>/dev/null || true)" != "$founder_uid" ]; then
    owner=$(stat -c %u "$retained")
    [ "$owner" = "$run_uid" ] || [ "$owner" = "$founder_uid" ] || { printf 'Workspace state has an unexpected owner.\n' >&2; exit 1; }
    # A routine run could have planted a hardlink to an inode it owns elsewhere; chown would hand
    # that inode to the founder along with the entry. An inode whose every name is in the entry
    # (pnpm links node_modules to its store) hands over nothing else, so only a name outside counts.
    if [ -n "$(find "$retained" ! -type d -links +1 -printf '%D:%i %n\n' | sort | uniq -c | awk '$1 != $3 { n++ } END { if (n) print n }')" ]; then
      printf 'Workspace state holds a hard link to a file outside it; remove it before the founder takes the entry.\n' >&2
      exit 1
    fi
    chown -hR "$founder:$founder" "$retained"
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
  verify_bind_mount "$home" "$target" "$retained" || {
    systemctl stop "$unit" || true
    exit 1
  }
done
