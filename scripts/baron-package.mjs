#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
const destination = process.argv[2] && NodePath.resolve(process.argv[2]);
if (!destination || NodeFS.existsSync(destination))
  throw new Error("Pass a new staging directory outside the checkout.");
if (destination === root || destination.startsWith(`${root}/`))
  throw new Error("Stage outside the checkout.");
const revision = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
if (
  NodeChildProcess.execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim()
)
  throw new Error("Commit the fork changes before packaging a release.");
const server = NodePath.join(root, "apps/server");
if (!NodeFS.existsSync(NodePath.join(server, "dist/client/index.html")))
  throw new Error("Build t3, including its web client, first.");
const source = JSON.parse(NodeFS.readFileSync(NodePath.join(server, "package.json"), "utf8"));
const dependencies = Object.fromEntries(
  Object.keys(selectCliRuntimeExternalDependencies(source.dependencies)).map((name) => [
    name,
    JSON.parse(
      NodeFS.readFileSync(NodePath.join(server, "node_modules", name, "package.json"), "utf8"),
    ).version,
  ]),
);
NodeFS.mkdirSync(destination, { recursive: true });
NodeFS.cpSync(NodePath.join(server, "dist"), NodePath.join(destination, "dist"), {
  recursive: true,
});
NodeFS.cpSync(NodePath.join(root, "LICENSE"), NodePath.join(destination, "LICENSE"));
NodeFS.cpSync(NodePath.join(root, "deploy/install.sh"), NodePath.join(destination, "install.sh"));
NodeFS.cpSync(NodePath.join(root, "deploy/persist.sh"), NodePath.join(destination, "persist.sh"));
NodeFS.cpSync(
  NodePath.join(root, "deploy/founder-record.sh"),
  NodePath.join(destination, "founder-record.sh"),
);
NodeFS.cpSync(
  NodePath.join(root, "deploy/provider-bootstrap.ts"),
  NodePath.join(destination, "provider-bootstrap.ts"),
);
NodeFS.writeFileSync(
  NodePath.join(destination, "package.json"),
  `${JSON.stringify({ name: "@autonomousbusinessunits/baron-workspace", version: `0.1.0-baron.${revision.slice(0, 12)}`, private: true, type: "module", dependencies }, null, 2)}\n`,
);
NodeFS.writeFileSync(
  NodePath.join(destination, "release.json"),
  `${JSON.stringify({ version: 1, repository: "https://github.com/AutonomousBusinessUnits/baron-workspace", revision })}\n`,
);
// Resolve platform-specific optional dependencies for the EC2 target, not the build Mac.
NodeChildProcess.execFileSync(
  "npm",
  [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--os=linux",
    "--cpu=x64",
    "--no-audit",
    "--no-fund",
  ],
  { cwd: destination, stdio: "inherit" },
);
console.log(JSON.stringify({ directory: destination, revision }));
