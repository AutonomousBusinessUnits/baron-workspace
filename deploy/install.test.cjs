const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const install = read("install.sh");
const persist = read("persist.sh");
const bootstrap = read("provider-bootstrap.ts");

const MISSING_FOUNDER = "Install the platform release that creates the founder user first.";

for (const [name, script] of [
  ["install.sh", install],
  ["persist.sh", persist],
]) {
  test(`${name} takes the founder from the business's unit record`, () => {
    assert.match(script, /\/etc\/abu\/harness\/\$business\/unit\.json/);
    assert.match(script, /founder_user/);
    assert.ok(script.includes(MISSING_FOUNDER));
  });

  test(`${name} no longer uses the routine run user`, () => {
    assert.doesNotMatch(script, /user=abu-\$business/);
    assert.doesNotMatch(script, /\/home\/\$user\b/);
  });

  test(`${name} is valid bash`, () => {
    const result = spawnSync("bash", ["-n", path.join(__dirname, name)], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });
}

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
  assert.match(persist, /^home=\/home\/\$founder$/m);
});

test("persist.sh retires the run user's mount units and hands each entry to the founder", () => {
  assert.match(persist, /old_home=\/home\/abu-\$business/);
  assert.match(persist, /systemctl stop "\$old_unit"/);
  assert.match(persist, /systemctl disable "\$old_unit"/);
  assert.match(persist, /rm -f "\/etc\/systemd\/system\/\$old_unit"/);
  assert.match(persist, /chown -R "\$founder:\$founder" "\$retained"/);
  assert.match(persist, /marker=\$state\/\.\$entry-owner/);
  assert.match(persist, /baron-root-backup/);
});

test("provider-bootstrap.ts takes the founder from the unit record", () => {
  assert.doesNotMatch(bootstrap, /abu-\$\{slug\}/);
  assert.match(bootstrap, /\/etc\/abu\/harness\/\$\{slug\}\/unit\.json/);
  assert.match(bootstrap, /founder_user/);
});
