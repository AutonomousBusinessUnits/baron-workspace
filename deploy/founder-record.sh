#!/usr/bin/env bash
# Sourced by install.sh and persist.sh, which run as root. Never run on its own.

# Sets founder, founder_uid and founder_home from the host's unit record for business $1.
# A host without the record is not ready, so this exits the calling script.
load_founder() {
  local business=$1 record
  record=$(/opt/abu/harness-node/bin/node -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); const slot=r.slot; if(r.unit!==process.argv[2]||!Number.isInteger(slot)||slot<0||slot>8||r.founder_user!=="abu-founder-"+slot||r.founder_uid!==2101+slot)process.exit(1); console.log(r.founder_user+" "+r.founder_uid)' "/etc/abu/harness/$business/unit.json" "$business" 2>/dev/null) || {
    printf 'Install the platform release that creates the founder user first.\n' >&2
    exit 1
  }
  read -r founder founder_uid <<<"$record"
  [ "$(id -u "$founder")" = "$founder_uid" ]
  founder_home=$(getent passwd "$founder" | cut -d: -f6)
  [ "$founder_home" = /home/"$founder" ]
}

# The founder owns everything below their home and can replace any directory there with a
# symlink. A root operation that follows one applies to its target, so root touches a path
# below the home only after this walks every component and finds no symlink. The workspace
# service is stopped while the installer runs, so no founder process races the check.
# Usage: refuse_symlinks_under <home> <path>
refuse_symlinks_under() {
  local home=$1 path=$2 current rest part
  local -a parts
  case $path in
    "$home"/*) ;;
    *) printf 'Workspace path is outside the founder home.\n' >&2; return 1 ;;
  esac
  current=$home
  [ ! -L "$current" ] || { printf 'The founder home is a symlink.\n' >&2; return 1; }
  rest=${path#"$home"/}
  IFS=/ read -ra parts <<<"$rest"
  for part in "${parts[@]}"; do
    case $part in
      '' | . | ..) printf 'Workspace path is not canonical.\n' >&2; return 1 ;;
    esac
    current=$current/$part
    [ ! -L "$current" ] || { printf 'Workspace path crosses a symlink.\n' >&2; return 1; }
  done
}

# Makes directories (and their parents) as the founder with mode 0700, so a symlink the founder
# planted resolves with the founder's own rights. Root never uses `install -d` below their home.
founder_mkdir() {
  runuser -u "$founder" -- bash -c 'umask 077; exec mkdir -p -m 0700 -- "$@"' _ "$@"
}

# Ends every process the founder has. The workspace service is stopped, but the founder can also
# hold processes outside its cgroup (a login session, a stray daemon). Any of them could swap a
# directory for a symlink between a check and root's use of the path, so the installer
# refuses to go on while one exists. SSH, cron and at are denied to the founder by the host installer.
quiesce_founder() {
  local attempt
  loginctl terminate-user "$founder" 2>/dev/null || true
  pkill -KILL -U "$founder_uid" || true
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -U "$founder_uid" >/dev/null || return 0
    sleep 0.5
    pkill -KILL -U "$founder_uid" || true
  done
  printf 'The founder still has running processes. Stop them, then install again.\n' >&2
  exit 1
}

# After a bind mount: the literal target is a mount point, no component below the home is a
# symlink, it resolves to itself, and it is the retained directory. A swap that mounted the
# retained directory over some other directory fails one of these.
# Usage: verify_bind_mount <home> <target> <retained>
verify_bind_mount() {
  local home=$1 target=$2 retained=$3
  refuse_symlinks_under "$home" "$target" || return 1
  mountpoint -q "$target" || { printf 'Workspace path is not a mount.\n' >&2; return 1; }
  [ "$(realpath -e -- "$target")" = "$target" ] || { printf 'Workspace path resolves elsewhere.\n' >&2; return 1; }
  [ "$target" -ef "$retained" ] || { printf 'Workspace path is not the retained directory.\n' >&2; return 1; }
}
