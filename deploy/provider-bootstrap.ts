// @effect-diagnostics nodeBuiltinImport:off - Runs in the root installer before the T3 runtime starts, using only Node built-ins.
/** Bootstrap only the business's existing Codex API credential; never a platform login. */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
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

/** The founder user the host's unit record names; the routine run user never holds this login. */
function readFounder(slug: string): string {
  const unavailable = () =>
    new Error("Install the platform release that creates the founder user first.");
  let record;
  try {
    record = JSON.parse(NodeFS.readFileSync(`/etc/abu/harness/${slug}/unit.json`, "utf8"));
  } catch {
    throw unavailable();
  }
  if (
    record.unit !== slug ||
    !Number.isInteger(record.slot) ||
    record.slot < 0 ||
    record.slot > 8 ||
    record.founder_user !== `abu-founder-${record.slot}` ||
    record.founder_uid !== 2101 + record.slot
  )
    throw unavailable();
  return record.founder_user;
}

export const FOUNDER_TOOLS_BEGIN =
  "# baron-founder-tools: begin (the workspace installer writes this block; edits are replaced)";
export const FOUNDER_TOOLS_END = "# baron-founder-tools: end";
const FOUNDER_TOOLS_CONFLICT =
  "The founder's Codex config has its own [mcp_servers.business], or its config.toml isn't a regular file, so the business tools aren't registered; the install goes on.\n";
type FounderToolsStatus = "written" | "removed" | "conflict" | "unchanged";
const FOUNDER_TOOLS_STATUSES: ReadonlySet<string> = new Set<FounderToolsStatus>([
  "written",
  "removed",
  "conflict",
  "unchanged",
]);

const validSlug = (slug: string) =>
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 40;
const founderToolsClient = (slug: string) => `/opt/abu/founder-tools/${slug}/founder-mcp.mjs`;
function checkFounderTools(slug: string, client: string | null) {
  if (!validSlug(slug) || (client !== null && client !== founderToolsClient(slug)))
    throw new Error("Invalid founder tools.");
}

// Enough TOML to find table headers and keys; a name it can't read for certain counts as taken.
const KEY_PART = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const KEY = String.raw`${KEY_PART}(?:\s*\.\s*${KEY_PART})*`;
const HEADER = new RegExp(String.raw`^\s*(\[\[?)\s*(${KEY})\s*\]\]?\s*(?:#.*)?$`);
const KEY_LINE = new RegExp(String.raw`^\s*(${KEY})\s*=`);
const MULTILINE_QUOTES = ['"""', "'''"];
type TomlLine =
  | { kind: "header"; path: string[] | null; array: boolean }
  | { kind: "key"; path: string[] | null }
  | { kind: "string" }
  | { kind: "other" };

function keyParts(key: string): string[] | null {
  const parts: string[] = [];
  for (const part of key.match(new RegExp(KEY_PART, "g")) ?? []) {
    if (part.startsWith('"') && part.includes("\\")) return null;
    parts.push(/^["']/.test(part) ? part.slice(1, -1) : part);
  }
  return parts;
}

/** Each line's role; a line inside a multi-line string is only text. */
function classify(lines: readonly string[]): TomlLine[] {
  let open: string | null = null;
  const odd = (line: string, quote: string) => line.split(quote).length % 2 === 0;
  return lines.map((line): TomlLine => {
    if (open) {
      if (odd(line, open)) open = null;
      return { kind: "string" };
    }
    if (/^\s*#/.test(line)) return { kind: "other" };
    const header = HEADER.exec(line);
    const key = header ? null : KEY_LINE.exec(line);
    open = MULTILINE_QUOTES.find((quote) => odd(line, quote)) ?? null;
    if (header) return { kind: "header", path: keyParts(header[2]!), array: header[1] === "[[" };
    if (key) return { kind: "key", path: keyParts(key[1]!) };
    return { kind: "other" };
  });
}

const isBusinessTable = (line: TomlLine | undefined) =>
  line?.kind === "header" &&
  !line.array &&
  line.path?.length === 2 &&
  line.path[0] === "mcp_servers" &&
  line.path[1] === "business";

/** Drops this installer's block: its markers, its table and the table's keys, wherever they are. */
function withoutFounderTools(lines: readonly string[]): string[] {
  const kinds = classify(lines);
  const drop = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.trimEnd();
    if (kinds[i]!.kind !== "other") continue;
    if (text === FOUNDER_TOOLS_END) drop.add(i);
    if (text !== FOUNDER_TOOLS_BEGIN) continue;
    drop.add(i);
    if (i > 0 && lines[i - 1]!.trim() === "") drop.add(i - 1);
    if (!isBusinessTable(kinds[i + 1])) continue;
    // The table's keys end at the next header, comment or end marker; Codex may add tables after it.
    let last = i + 1;
    for (let j = i + 2; j < lines.length; j++) {
      if (kinds[j]!.kind === "key") last = j;
      else if (lines[j]!.trim() !== "") break;
    }
    for (let j = i + 1; j <= last; j++) drop.add(j);
    i = last;
  }
  return lines.filter((_, i) => !drop.has(i));
}

/** Whether a header or key defines mcp_servers.business, or leaves no room for that table. */
function definesBusiness(lines: readonly string[]): boolean {
  let table: string[] = [];
  const kinds = classify(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = kinds[i]!;
    // A header this reader can't parse (a TOML 1.1 bare key, say) that names mcp_servers.
    if (line.kind === "other" && /^\s*\[/.test(lines[i]!) && lines[i]!.includes("mcp_servers"))
      return true;
    if (line.kind === "other" || line.kind === "string") continue;
    if (!line.path) {
      if (lines[i]!.includes("mcp_servers") || table[0] === "mcp_servers") return true;
      if (line.kind === "header") table = [];
      continue;
    }
    const full = line.kind === "header" ? line.path : [...table, ...line.path];
    if (line.kind === "header") table = line.path;
    if (full[0] !== "mcp_servers") continue;
    if (full[1] === "business") return true;
    // A key named mcp_servers (an inline table) or [[mcp_servers]] can't take a sub-table.
    if (full.length === 1 && (line.kind === "key" || line.array)) return true;
  }
  return false;
}

/** The founder's config with this block replaced, removed (client null), or "conflict" when another [mcp_servers.business] exists. */
export function withFounderTools(
  config: string,
  slug: string,
  client: string | null,
): string | "conflict" {
  checkFounderTools(slug, client);
  const lines = config.split("\n");
  const kept = withoutFounderTools(lines);
  const base = kept.join("\n").trimEnd();
  if (client === null) {
    if (kept.length === lines.length) return config;
    return base ? `${base}\n` : "";
  }
  if (definesBusiness(kept)) return "conflict";
  const block = [
    FOUNDER_TOOLS_BEGIN,
    "[mcp_servers.business]",
    `command = ${JSON.stringify("/opt/abu/harness-node/bin/node")}`,
    `args = [${[client, "--abu", slug].map((arg) => JSON.stringify(arg)).join(", ")}]`,
    FOUNDER_TOOLS_END,
  ].join("\n");
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

/** The founder's half: run as the founder, never root, it changes only ~/.codex/config.toml. */
function writeFounderTools(slug: string, client: string | null): FounderToolsStatus {
  checkFounderTools(slug, client);
  const home = process.env.HOME ?? "";
  if (process.getuid?.() === 0 || !NodePath.isAbsolute(home) || NodePath.normalize(home) !== home)
    throw new Error("Only the founder writes the founder tools.");
  const directory = `${home}/.codex`;
  const path = `${directory}/config.toml`;
  let config = "";
  let mode = 0o600;
  let input: number | undefined;
  try {
    // O_NONBLOCK: a FIFO in its place opens at once and is refused below, instead of hanging.
    const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = NodeFS.constants;
    input = NodeFS.openSync(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return "conflict";
    if (code !== "ENOENT") throw error;
  }
  if (input !== undefined) {
    try {
      const stat = NodeFS.fstatSync(input);
      if (!stat.isFile()) return "conflict";
      mode = stat.mode & 0o777;
      config = NodeFS.readFileSync(input, "utf8");
    } finally {
      NodeFS.closeSync(input);
    }
  }
  const next = withFounderTools(config, slug, client);
  if (next === "conflict") return "conflict";
  if (next === config) return "unchanged";
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${directory}/.config.toml.${NodeCrypto.randomBytes(6).toString("hex")}`;
  const output = NodeFS.openSync(temporary, "wx", 0o600);
  try {
    NodeFS.fchmodSync(output, mode);
    NodeFS.writeFileSync(output, next);
    NodeFS.fsyncSync(output);
  } catch (error) {
    NodeFS.closeSync(output);
    NodeFS.rmSync(temporary, { force: true });
    throw error;
  }
  NodeFS.closeSync(output);
  try {
    NodeFS.renameSync(temporary, path);
  } catch (error) {
    NodeFS.rmSync(temporary, { force: true });
    throw error;
  }
  return client === null ? "removed" : "written";
}

/** Root's half: offers the command only while root alone can change it; the founder writes. */
export async function installFounderTools(
  slug: string,
  founder: string,
  home: string,
): Promise<FounderToolsStatus> {
  if (!validSlug(slug) || !/^abu-founder-[0-8]$/.test(founder) || home !== `/home/${founder}`)
    throw new Error("Invalid founder tools install.");
  let client: string | null = founderToolsClient(slug);
  try {
    const stat = NodeFS.lstatSync(client);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) client = null;
  } catch {
    client = null;
  }
  let reply: string;
  try {
    reply = NodeChildProcess.execFileSync(
      "runuser",
      [
        "-u",
        founder,
        "--",
        "env",
        `HOME=${home}`,
        process.execPath,
        NodeURL.fileURLToPath(import.meta.url),
        "--founder-tools",
        slug,
        client ?? "-",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 20_000,
        cwd: "/",
        env: {
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          LANG: "C.UTF-8",
        },
      },
    );
  } catch {
    throw new Error("The founder tools could not be registered.");
  }
  const status = reply.trim();
  if (!FOUNDER_TOOLS_STATUSES.has(status))
    throw new Error("The founder tools could not be registered.");
  return status as FounderToolsStatus;
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
  const founder = readFounder(slug);
  const home = `/home/${founder}`;
  const result = await bootstrapBusinessCodex({
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
            founder,
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
  // The tools are optional: neither a conflict nor a failure stops the workspace install.
  let founderTools: FounderToolsStatus | "failed";
  try {
    founderTools = await installFounderTools(slug, founder, home);
  } catch {
    founderTools = "failed";
    process.stderr.write(
      "The business tools couldn't be registered in the founder's Codex config; the install goes on.\n",
    );
  }
  if (founderTools === "conflict") process.stderr.write(FOUNDER_TOOLS_CONFLICT);
  return { ...result, founderTools };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href;
if (isMain && process.argv[2] === "--founder-tools") {
  try {
    const client = process.argv[4] === "-" ? null : (process.argv[4] ?? "");
    process.stdout.write(`${writeFounderTools(process.argv[3] ?? "", client)}\n`);
  } catch {
    process.stderr.write("The founder tools could not be written.\n");
    process.exitCode = 1;
  }
} else if (isMain) {
  installBusinessCodex(process.argv[2] ?? "").then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    () => {
      process.stderr.write("The business provider setup could not be verified.\n");
      process.exitCode = 1;
    },
  );
}
