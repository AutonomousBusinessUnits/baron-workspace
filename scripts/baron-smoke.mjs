#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { WsRpcGroup } from "../packages/contracts/src/rpc.ts";

const { values } = NodeUtil.parseArgs({
  options: { receipt: { type: "string" }, url: { type: "string" }, yes: { type: "boolean" } },
});
if (!values.receipt || !values.url || !values.yes)
  throw new Error("Use --receipt <install receipt> --url <private SSM tunnel origin> --yes.");
const receipt = JSON.parse(NodeFS.readFileSync(values.receipt, "utf8"));
const { slug, instanceId } = receipt.target;
if (
  !/^[a-z][a-z0-9-]*$/.test(slug) ||
  !/^i-[a-f0-9]+$/.test(instanceId) ||
  !/^[a-f0-9]{40}$/.test(receipt.release.revision)
)
  throw new Error("Invalid installation receipt.");
const base = new URL(values.url);
if (!["localhost", "127.0.0.1"].includes(base.hostname))
  throw new Error("Use a loopback SSM forward.");
const aws = (args) =>
  JSON.parse(
    NodeChildProcess.execFileSync(
      "aws",
      [...args, "--profile", "agents", "--region", "us-east-1", "--output", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
const send = (script) =>
  aws([
    "ssm",
    "send-command",
    "--instance-ids",
    instanceId,
    "--document-name",
    "AWS-RunShellScript",
    "--parameters",
    JSON.stringify({ commands: [script] }),
  ]).Command.CommandId;
async function completion(commandId) {
  for (let attempt = 0; attempt < 45; attempt++) {
    let result;
    try {
      result = aws([
        "ssm",
        "get-command-invocation",
        "--command-id",
        commandId,
        "--instance-id",
        instanceId,
      ]);
    } catch {}
    if (result?.Status === "Success") return result.StandardOutputContent;
    if (result && !["Pending", "InProgress", "Delayed"].includes(result.Status))
      throw new Error(`Remote smoke preparation ended ${result.Status}.`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Remote smoke preparation timed out.");
}
const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = publicKey.export({ type: "spki", format: "pem" });
const cli = `/opt/abu/baron-workspace/releases/${receipt.release.revision}/dist/bin.mjs`;
const state = `/home/abu-${slug}/.local/share/baron-workspace`;
const issueCode = `const cp=require('node:child_process'),c=require('node:crypto');const invoke=(args)=>cp.execFileSync('runuser',['-u',${JSON.stringify(`abu-${slug}`)},'--','/opt/abu/harness-node/bin/node',${JSON.stringify(cli)},'auth','session',...args,'--base-dir',${JSON.stringify(state)}],{encoding:'utf8'}); for(const old of JSON.parse(invoke(['list','--json']))) {if(old.client?.label==='Baron EC2 terminal smoke')invoke(['revoke',old.sessionId]);} const s=JSON.parse(invoke(['issue','--ttl','10m','--label','Baron EC2 terminal smoke','--json']));const key=c.randomBytes(32),iv=c.randomBytes(12),cipher=c.createCipheriv('aes-256-gcm',key,iv);const data=Buffer.concat([cipher.update(s.token,'utf8'),cipher.final()]);console.log(JSON.stringify({sessionId:s.sessionId,key:c.publicEncrypt({key:${JSON.stringify(pem)},oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),data:data.toString('base64'),tag:cipher.getAuthTag().toString('base64')}));`;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const issued = JSON.parse(
  await completion(send(`/opt/abu/harness-node/bin/node -e ${quote(issueCode)}`)),
);
if (!/^[a-f0-9-]{36}$/.test(issued.sessionId)) throw new Error("Invalid smoke session id.");
const sessionKey = NodeCrypto.privateDecrypt(
  { key: privateKey, oaepHash: "sha256" },
  Buffer.from(issued.key, "base64"),
);
const decipher = NodeCrypto.createDecipheriv(
  "aes-256-gcm",
  sessionKey,
  Buffer.from(issued.iv, "base64"),
);
decipher.setAuthTag(Buffer.from(issued.tag, "base64"));
const token = Buffer.concat([
  decipher.update(Buffer.from(issued.data, "base64")),
  decipher.final(),
]).toString();
try {
  const html = await fetch(base);
  if (
    html.status !== 200 ||
    !html.headers.get("content-security-policy")?.includes(receipt.target.baronOrigin)
  )
    throw new Error("The embedded page did not pass its HTTP check.");
  const ticketReply = await fetch(new URL("/api/auth/websocket-ticket", base), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!ticketReply.ok) throw new Error(`WebSocket ticket refused: ${ticketReply.status}.`);
  const { ticket } = await ticketReply.json();
  const socket = new URL("/ws", base);
  socket.protocol = "ws:";
  socket.searchParams.set("wsTicket", ticket);
  socket.searchParams.set("orchestrationProtocol", "2");
  const transport = RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
    Layer.provide(Layer.mergeAll(Socket.layerWebSocket(socket.href), RpcSerialization.layerJson)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
  const marker = `baron-${NodeCrypto.randomUUID()}`;
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(WsRpcGroup);
        const config = yield* client["server.getConfig"]({});
        const shell = yield* client["orchestration.subscribeShell"]({}).pipe(
          Stream.filter((e) => e.kind === "snapshot"),
          Stream.runHead,
        );
        if (shell._tag === "None") throw new Error("No remote shell snapshot.");
        const snapshot = shell.value.snapshot;
        let thread = snapshot.threads[0];
        if (!thread) {
          const project = snapshot.projects[0];
          const provider = config.providers.find((p) => p.enabled && p.models.length > 0);
          if (!project || !provider)
            throw new Error(
              JSON.stringify({
                reason: "No project or provider",
                projectCount: snapshot.projects.length,
                providers: config.providers.map((p) => ({
                  id: p.instanceId,
                  enabled: p.enabled,
                  installed: p.installed,
                  models: p.models.length,
                })),
              }),
            );
          const model = provider.models.find((m) => m.isDefault) ?? provider.models[0];
          const launched = yield* client["orchestration.launchThread"]({
            commandId: NodeCrypto.randomUUID(),
            projectId: project.id,
            title: "Baron terminal verification",
            modelSelection: { instanceId: provider.instanceId, model: model.slug },
            runtimeMode: "approval-required",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
          });
          thread = { id: launched.threadId, projectId: project.id };
        }
        const cwd = `/home/abu-${slug}/workspace`;
        const terminal = { threadId: thread.id, terminalId: `baron-smoke-${marker}` };
        yield* client["terminal.open"]({ ...terminal, cwd, cols: 100, rows: 24 });
        const ready = yield* Deferred.make();
        let output = "";
        yield* client["terminal.observe"](terminal).pipe(
          Stream.runForEach((event) => {
            output +=
              event.type === "output"
                ? event.data
                : event.type === "snapshot"
                  ? event.snapshot.history
                  : "";
            return output.includes("BARON_OS=Linux") && output.includes(`BARON_READBACK=${marker}`)
              ? Deferred.succeed(ready, undefined)
              : Effect.void;
          }),
          Effect.forkScoped,
        );
        yield* client["terminal.write"]({
          ...terminal,
          data: `printf 'BARON_OS=%s\\n' "$(uname -s)"; printf '%s' '${marker}' > .baron-workspace-smoke; printf 'BARON_READBACK='; cat .baron-workspace-smoke; printf '\\n'\n`,
        });
        yield* Deferred.await(ready).pipe(Effect.timeout("20 seconds"));
        const file = yield* client["projects.readFile"]({
          cwd,
          relativePath: ".baron-workspace-smoke",
        });
        yield* client["terminal.close"](terminal);
        if (file.contents !== marker) throw new Error("Terminal/file readback disagrees.");
        return {
          instanceId,
          revision: receipt.release.revision,
          environmentId: config.environment.environmentId,
          projectId: thread.projectId,
          threadId: thread.id,
          cwd,
          http: true,
          framePolicy: true,
          authenticatedWebSocket: true,
          linuxTerminal: true,
          fileReadback: true,
        };
      }),
    ).pipe(Effect.provide(transport), Effect.timeout("45 seconds")),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await completion(
    send(
      `runuser -u ${quote(`abu-${slug}`)} -- /opt/abu/harness-node/bin/node ${quote(cli)} auth session revoke ${quote(issued.sessionId)} --base-dir ${quote(state)} >/dev/null`,
    ),
  );
}
