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
      assert.match(line, /"\$(retained|checkout|destination)"\s*$/, line);
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
  before(install, 'refuse_symlinks_under "$founder_home" "$checkout"', "git clone", 'chown -R "$founder:$founder" "$checkout"');
  before(install, 'refuse_symlinks_under "$founder_home" "$workspace_state"', "founder_mkdir");
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

test("provider-bootstrap.ts takes the founder from the unit record", () => {
  assert.doesNotMatch(bootstrap, /abu-\$\{slug\}/);
  assert.match(bootstrap, /\/etc\/abu\/harness\/\$\{slug\}\/unit\.json/);
  assert.match(bootstrap, /founder_user/);
});
