const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const install = read("install.sh");
const persist = read("persist.sh");
const helper = read("founder-record.sh");
const bootstrap = read("provider-bootstrap.ts");

const MISSING_FOUNDER = "Install the platform release that creates the founder user first.";
const code = (script) => script.split("\n").filter((line) => !/^\s*#/.test(line));

for (const name of ["install.sh", "persist.sh", "founder-record.sh"]) {
  test(`${name} is valid bash`, () => {
    const result = spawnSync("bash", ["-n", path.join(__dirname, name)], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });
}

test("the founder comes from the unit record, validated once in the shared helper", () => {
  assert.match(helper, /\/etc\/abu\/harness\/\$business\/unit\.json/);
  assert.match(helper, /founder_user/);
  assert.ok(helper.includes(MISSING_FOUNDER));
  for (const script of [install, persist]) {
    assert.match(script, /^source .*founder-record\.sh"$/m);
    assert.match(script, /^load_founder "\$business"$/m);
    assert.doesNotMatch(script, /founder_user|unit\.json/);
    assert.doesNotMatch(script, /user=abu-\$business/);
    assert.doesNotMatch(script, /\/home\/\$user\b/);
  }
});

test("the helper ships in the release", () => {
  const packager = fs.readFileSync(path.join(__dirname, "../scripts/baron-package.mjs"), "utf8");
  assert.match(packager, /deploy\/founder-record\.sh/);
});

test("the workspace unit runs as the founder with the run paths hidden", () => {
  assert.match(install, /^User=\$founder$/m);
  assert.match(install, /^Group=\$founder$/m);
  assert.match(
    install,
    /^InaccessiblePaths=\/opt\/abu\/harness-releases \/var\/lib\/abu\/\$business\/runs \/var\/lib\/abu\/\$business\/browser \/home\/abu-\$business$/m,
  );
  for (const directive of ["ProtectSystem=full", "NoNewPrivileges=true", "PrivateTmp=true"]) {
    assert.match(install, new RegExp(`^${directive}$`, "m"));
  }
});

test("the workspace record names the founder user", () => {
  const write = install
    .split("\n")
    .find((line) => line.includes("/etc/abu/baron-workspace/$business.json"));
  assert.ok(write, "install.sh writes the workspace record");
  assert.match(write, /user:process\.argv\[4\]/);
  assert.match(write, /"\$founder"/);
});

test("the checkout lives in the founder's home", () => {
  assert.match(install, /^checkout=\$founder_home\/workspace$/m);
  assert.match(install, /^workspace_state=\$founder_home\/\.local\/share\/baron-workspace$/m);
});

test("persist.sh binds the retained entries into the founder's home", () => {
  assert.match(persist, /project\) target=\$home\/workspace/);
  assert.match(persist, /state\) target=\$home\/\.local\/share\/baron-workspace/);
  assert.match(persist, /codex\) target=\$home\/\.codex/);
  assert.match(persist, /^home=\$founder_home$/m);
});

test("persist.sh retires the run user's mount units and hands each entry to the founder", () => {
  assert.match(persist, /old_home=\/home\/abu-\$business/);
  assert.match(persist, /systemctl stop "\$old_unit"/);
  assert.match(persist, /systemctl disable "\$old_unit"/);
  assert.match(persist, /rm -f "\/etc\/systemd\/system\/\$old_unit"/);
  assert.match(persist, /chown -hR "\$founder:\$founder" "\$retained"/);
  assert.match(persist, /marker=\$state\/\.\$entry-owner/);
  assert.match(persist, /baron-root-backup/);
});

test("persist.sh refuses a hard link in a retained entry before it chowns", () => {
  const guard = 'find "$retained" ! -type d -links +1 -print -quit';
  assert.ok(persist.includes(guard));
  assert.ok(persist.indexOf(guard) < persist.indexOf('chown -hR "$founder:$founder" "$retained"'));
  assert.match(persist, /hard link[^\n]*\\n' >&2\n\s+exit 1/);
  // The same expression, run on a real tree: silent for plain files, a hit for a shared inode.
  const { mkdtempSync, writeFileSync, linkSync, mkdirSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const { execFileSync } = require("node:child_process");
  const retained = mkdtempSync(join(tmpdir(), "baron-retained-"));
  try {
    mkdirSync(join(retained, "sub"));
    writeFileSync(join(retained, "sub", "a"), "x");
    const hits = () =>
      execFileSync("bash", ["-c", `retained=$1; ${guard}`, "_", retained], { encoding: "utf8" });
    assert.equal(hits(), "");
    linkSync(join(retained, "sub", "a"), join(retained, "b"));
    assert.notEqual(hits(), "");
  } finally {
    rmSync(retained, { recursive: true, force: true });
  }
});

test("root creates nothing below the founder's home with install -d", () => {
  for (const script of [install, persist]) {
    for (const line of code(script).filter((l) => /\binstall -d\b/.test(l))) {
      assert.doesNotMatch(line, /\$home|\$founder_home|\$target|\$checkout|\$workspace_state/, line);
    }
  }
  assert.match(persist, /^founder_mkdir "\$home\/\.local\/share"$/m);
  assert.match(persist, /^ {4}founder_mkdir "\$target"$/m);
  assert.match(install, /^founder_mkdir "\$workspace_state"$/m);
  assert.match(helper, /runuser -u "\$founder" -- bash -c 'umask 077; exec mkdir -p -m 0700/);
});

test("root chowns only paths the founder cannot redirect", () => {
  for (const script of [install, persist]) {
    for (const line of code(script).filter((l) => /\bchown\b/.test(l))) {
      assert.match(line, /"\$(retained|checkout|clone|destination)"\s*$/, line);
    }
  }
});

test("every root operation on a founder-home path follows a symlink check of that path", () => {
  const before = (script, guard, ...uses) => {
    const lines = code(script);
    const guarded = lines.findIndex((l) => l.includes(guard));
    assert.notEqual(guarded, -1, `${guard} is missing`);
    for (const use of uses) {
      const at = lines.findIndex((l) => l.includes(use));
      assert.notEqual(at, -1, `${use} is missing`);
      assert.ok(guarded < at, `${guard} must come before ${use}`);
    }
  };
  before(
    persist,
    'refuse_symlinks_under "$home" "$target"',
    'mountpoint -q "$target"',
    'cp -a "$target/."',
    'mv "$target" "$backup"',
    'founder_mkdir "$target"',
    'systemctl start "$unit"',
  );
  before(persist, 'refuse_symlinks_under "$home" "$backup"', 'mv "$target" "$backup"');
  before(install, 'refuse_symlinks_under "$founder_home" "$checkout"', "git clone", 'chown -hR "$founder:$founder" "$checkout"');
  before(install, 'refuse_symlinks_under "$founder_home" "$workspace_state"', "founder_mkdir");
  // The recovery path stats and chowns the checkout's .git, so the second check precedes both.
  const lines = code(install);
  const checks = lines.flatMap((l, i) => (l.includes('refuse_symlinks_under "$founder_home" "$checkout"') ? [i] : []));
  assert.equal(checks.length, 2, "once before the clone, once before the recovery");
  assert.ok(checks[1] < lines.findIndex((l) => l.includes('stat -c %u "$checkout/.git"')));
  assert.ok(checks[1] < lines.findIndex((l) => l.includes('chown -hR "$founder:$founder" "$checkout"')));
});

test("no git command runs as root in the founder's checkout", () => {
  const gitLines = code(install).filter((l) => /\bgit\b/.test(l) && !/^\s*(if|\[)/.test(l));
  assert.ok(gitLines.length >= 2, "install.sh runs git for the clone and the switch");
  for (const line of gitLines) {
    if (line.includes('git clone --no-hardlinks "$source" "$clone"')) {
      // Root clones only into a root-owned folder it made itself, never into the checkout.
      assert.doesNotMatch(line, /\$checkout/, line);
      continue;
    }
    assert.match(line, /^\s*runuser -u "\$founder" -- env HOME="\$founder_home" git /, line);
  }
  assert.match(install, /^ {2}clone_parent=\$\(mktemp -d \/var\/tmp\/baron-workspace-clone\.XXXXXX\)$/m);
  assert.match(install, /^ {2}clone=\$clone_parent\/checkout$/m);
  assert.doesNotMatch(install, /^\s*git -C "\$checkout"/m);
});

test("the checkout is handed to the founder before the founder switches its branch", () => {
  const lines = code(install);
  const at = (needle) => {
    const i = lines.findIndex((l) => l.includes(needle));
    assert.notEqual(i, -1, `${needle} is missing`);
    return i;
  };
  const clone = at("git clone --no-hardlinks");
  const chownClone = at('chown -hR "$founder:$founder" "$clone"');
  const copy = at('cp -a "$clone/." "$checkout/"');
  const chownCheckout = at('chown -hR "$founder:$founder" "$checkout"');
  const sw = at("switch -c baron-workspace");
  assert.ok(clone < chownClone && chownClone < copy, "clone, then hand over, then place it");
  assert.ok(copy < sw && chownCheckout < sw, "every hand-over precedes the switch");
  // The copy and the switch both run as the founder.
  assert.match(lines[copy], /runuser -u "\$founder" --/);
  assert.match(lines[sw], /runuser -u "\$founder" --/);
  // A .git still owned by root (a failed earlier run) is finished by the same switch.
  assert.match(install, /if \[ "\$\(stat -c %u "\$checkout\/\.git"\)" = 0 \]; then\n\s+chown -hR "\$founder:\$founder" "\$checkout"\n\s+make_branch=true\nfi/);
  assert.match(install, /if \[ "\$make_branch" = true \]; then\n\s+runuser -u "\$founder" -- env HOME="\$founder_home" git -C "\$checkout" switch -c baron-workspace\nfi/);
});

// refuse_symlinks_under needs no root, so it runs here against a planted layout.
function refuse(home, target) {
  return spawnSync(
    "bash",
    ["-c", 'source "$1"; refuse_symlinks_under "$2" "$3"', "_", path.join(__dirname, "founder-record.sh"), home, target],
    { encoding: "utf8" },
  );
}

test("refuse_symlinks_under walks every component below the home", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baron-founder-home-"));
  try {
    const home = path.join(root, "home");
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(path.join(home, ".local/share"), { recursive: true });
    fs.mkdirSync(path.join(elsewhere, "share"), { recursive: true });

    assert.equal(refuse(home, `${home}/.local/share/baron-workspace`).status, 0, "absent leaf");
    assert.equal(refuse(home, `${home}/.local/share`).status, 0, "real directories");
    assert.equal(refuse(home, `${home}/workspace`).status, 0, "absent directory");

    fs.renameSync(path.join(home, ".local"), path.join(home, ".l"));
    fs.symlinkSync(elsewhere, path.join(home, ".local"));
    const ancestor = refuse(home, `${home}/.local/share/baron-workspace`);
    assert.equal(ancestor.status, 1, "a symlinked ancestor");
    assert.match(ancestor.stderr, /symlink/);

    fs.symlinkSync(elsewhere, path.join(home, "workspace"));
    assert.equal(refuse(home, `${home}/workspace`).status, 1, "a symlinked leaf");

    assert.equal(refuse(home, `${elsewhere}/share`).status, 1, "a path outside the home");
    assert.equal(refuse(home, `${home}/../elsewhere/share`).status, 1, "a dot-dot component");
    assert.equal(refuse(home, `${home}//x`).status, 1, "an empty component");

    const linkedHome = path.join(root, "linked-home");
    fs.symlinkSync(home, linkedHome);
    assert.equal(refuse(linkedHome, `${linkedHome}/x`).status, 1, "a symlinked home");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the installer ends the founder's processes before it touches their home", () => {
  assert.match(helper, /loginctl terminate-user "\$founder"/);
  assert.match(helper, /pkill -KILL -U "\$founder_uid"/);
  assert.match(helper, /pgrep -U "\$founder_uid"/);
  const order = (script, first, second) => {
    const lines = code(script);
    const a = lines.findIndex((l) => l.includes(first));
    const b = lines.findIndex((l) => l.includes(second));
    assert.ok(a !== -1 && b !== -1 && a < b, `${first} must come before ${second}`);
  };
  order(install, "systemctl stop", "quiesce_founder");
  order(install, "quiesce_founder", 'bash "$destination/persist.sh"');
  order(persist, "is-active", "quiesce_founder");
  order(persist, "quiesce_founder", "founder_mkdir");
  order(persist, "quiesce_founder", "refuse_symlinks_under");
});

// Stand-ins for the process tools, so quiesce_founder runs without root or real processes.
function quiesce(survivors) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "baron-quiesce-"));
  try {
    const shim = (name, body) => {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    shim("loginctl", "exit 1");
    shim("pkill", "exit 1");
    shim("sleep", "exit 0");
    shim("pgrep", survivors ? "exit 0" : "exit 1");
    return spawnSync(
      "bash",
      ["-c", 'source "$1"; founder=abu-founder-1; founder_uid=2102; quiesce_founder; echo continued', "_", path.join(__dirname, "founder-record.sh")],
      { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } },
    );
  } finally {
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

test("quiesce_founder refuses to continue while the founder has a process", () => {
  const alive = quiesce(true);
  assert.equal(alive.status, 1);
  assert.match(alive.stderr, /founder still has running processes/);
  assert.doesNotMatch(alive.stdout, /continued/);
  const clear = quiesce(false);
  assert.equal(clear.status, 0, clear.stderr);
  assert.match(clear.stdout, /continued/);
});

test("persist.sh verifies each mount and unmounts one that is not the retained directory", () => {
  assert.match(persist, /verify_bind_mount "\$home" "\$target" "\$retained" \|\| \{\n\s+systemctl stop "\$unit" \|\| true\n\s+exit 1/);
  const lines = code(persist);
  const start = lines.findIndex((l) => l.includes('systemctl start "$unit"'));
  assert.ok(lines[start + 1].includes("verify_bind_mount"), "the check follows the mount at once");
  assert.match(helper, /mountpoint -q "\$target"/);
  assert.match(helper, /realpath -e -- "\$target"/);
});

function verifyMount(home, target, retained) {
  return spawnSync(
    "bash",
    ["-c", 'source "$1"; verify_bind_mount "$2" "$3" "$4"', "_", path.join(__dirname, "founder-record.sh"), home, target, retained],
    { encoding: "utf8" },
  );
}

test("verify_bind_mount refuses a target that is a symlink, crosses one, or is no mount", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baron-mount-check-"));
  try {
    const home = path.join(root, "home");
    const retained = path.join(root, "retained");
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(path.join(home, "dir"), { recursive: true });
    fs.mkdirSync(retained);
    fs.mkdirSync(path.join(elsewhere, "dir"), { recursive: true });

    const plain = verifyMount(home, `${home}/dir`, retained);
    assert.equal(plain.status, 1);
    assert.match(plain.stderr, /not a mount/);

    fs.symlinkSync(retained, path.join(home, "link"));
    const leaf = verifyMount(home, `${home}/link`, retained);
    assert.equal(leaf.status, 1);
    assert.match(leaf.stderr, /symlink/);

    fs.symlinkSync(elsewhere, path.join(home, "moved"));
    const ancestor = verifyMount(home, `${home}/moved/dir`, retained);
    assert.equal(ancestor.status, 1);
    assert.match(ancestor.stderr, /symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verify_bind_mount accepts a real bind mount and refuses one that hides another directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "baron-mount-real-"));
  try {
    const home = path.join(root, "home");
    const retained = path.join(root, "retained");
    const other = path.join(root, "other");
    for (const dir of [path.join(home, "dir"), retained, other]) fs.mkdirSync(dir, { recursive: true });
    // An unprivileged user namespace lets this run without root; skip where the host forbids it.
    const probe = spawnSync("unshare", ["-rm", "true"]);
    if (probe.status !== 0) return t.skip("user and mount namespaces are unavailable");
    const run = (body) =>
      spawnSync(
        "unshare",
        ["-rm", "bash", "-c", `source "$1"; ${body}`, "_", path.join(__dirname, "founder-record.sh"), home, retained, other],
        { encoding: "utf8" },
      );
    const good = run('mount --bind "$2" "$1/dir"; verify_bind_mount "$1" "$1/dir" "$2"');
    assert.equal(good.status, 0, good.stderr);
    const wrong = run('mount --bind "$3" "$1/dir"; verify_bind_mount "$1" "$1/dir" "$2"');
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /not the retained directory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provider-bootstrap.ts takes the founder from the unit record", () => {
  assert.doesNotMatch(bootstrap, /abu-\$\{slug\}/);
  assert.match(bootstrap, /\/etc\/abu\/harness\/\$\{slug\}\/unit\.json/);
  assert.match(bootstrap, /founder_user/);
});
