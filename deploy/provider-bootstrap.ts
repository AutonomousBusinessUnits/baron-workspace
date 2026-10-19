// @effect-diagnostics nodeBuiltinImport:off - Runs in the root installer before the T3 runtime starts, using only Node built-ins.
/** Bootstrap only the business's existing Codex API credential; never a platform login. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

export async function bootstrapBusinessCodex(input: {
  slug: string;
  manifest: string;
  hasLogin: boolean;
  readKey(reference: string): Promise<string>;
  login(key: string): Promise<void>;
}): Promise<{ status: "existing-login" | "configured" }> {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.slug) || input.slug.length > 40)
    throw new Error("Invalid workspace business.");
  if (input.hasLogin) return { status: "existing-login" };
  const reference = `/abu/${input.slug}/secrets/openai_key`;
  const declared = input.manifest.match(
    /^\s+openai:\s*["']?(ssm:\/[^\s"'#]+)["']?\s*(?:#.*)?$/m,
  )?.[1];
  if (declared !== `ssm:${reference}`)
    throw new Error("The workspace requires this business's declared OpenAI key.");
  const key = await input.readKey(reference);
  if (!key.trim()) throw new Error("The business provider key is unavailable.");
  await input.login(key);
  return { status: "configured" };
}

export async function installBusinessCodex(slug: string) {
  if (process.getuid?.() !== 0 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug))
    throw new Error("Managed root provider setup is required.");
  const host = JSON.parse(NodeFS.readFileSync("/etc/abu/harness-host.json", "utf8"));
  if (
    host.unit !== slug ||
    host.runtime !== "harness" ||
    host.account_id !== "313260780602" ||
    host.region !== "us-east-1"
  )
    throw new Error("The business host identity differs.");
  const home = `/home/abu-${slug}`;
  return bootstrapBusinessCodex({
    slug,
    manifest: NodeFS.readFileSync(`/var/lib/abu/${slug}/source/abus/${slug}/abu.yaml`, "utf8"),
    hasLogin: NodeFS.existsSync(`${home}/.codex/auth.json`),
    async readKey(reference) {
      try {
        const reply = JSON.parse(
          NodeChildProcess.execFileSync(
            "aws",
            [
              "ssm",
              "get-parameter",
              "--region",
              "us-east-1",
              "--name",
              reference,
              "--with-decryption",
              "--output",
              "json",
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 },
          ),
        );
        if (typeof reply.Parameter?.Value !== "string") throw new Error();
        return reply.Parameter.Value;
      } catch {
        throw new Error("The business provider key is unavailable.");
      }
    },
    async login(key) {
      try {
        NodeChildProcess.execFileSync(
          "runuser",
          [
            "-u",
            `abu-${slug}`,
            "--",
            "env",
            `HOME=${home}`,
            `CODEX_HOME=${home}/.codex`,
            "PATH=/opt/abu/harness-node/bin:/opt/abu/harness-cli/node_modules/.bin:/usr/bin:/bin",
            "codex",
            "login",
            "--with-api-key",
          ],
          {
            input: `${key}\n`,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 30_000,
            env: {
              PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
              LANG: "C.UTF-8",
            },
          },
        );
      } catch {
        throw new Error("The business provider login could not be configured.");
      }
    },
  });
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  installBusinessCodex(process.argv[2] ?? "").then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    () => {
      process.stderr.write("The business provider setup could not be verified.\n");
      process.exitCode = 1;
    },
  );
}
