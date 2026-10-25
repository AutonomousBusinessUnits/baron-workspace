import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  lstatSync: vi.fn(),
  execFileSync: vi.fn((..._args: unknown[]): string => "written\n"),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  lstatSync: host.lstatSync,
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: host.execFileSync,
}));

import {
  bootstrapBusinessCodex,
  FOUNDER_TOOLS_BEGIN,
  FOUNDER_TOOLS_END,
  installFounderTools,
  withFounderTools,
} from "../../../deploy/provider-bootstrap.ts";

const manifest =
  "agent:\n  harness:\n    credentials:\n      openai: ssm:/abu/bakery/secrets/openai_key\n";
function setup() {
  return {
    slug: "bakery",
    manifest,
    hasLogin: false,
    readKey: vi.fn(async () => "business-provider-credential"),
    login: vi.fn(async (_key: string) => {}),
  };
}
describe("business workspace provider setup", () => {
  it("uses only the declared business key and returns no credential", async () => {
    const input = setup();
    const result = await bootstrapBusinessCodex(input);
    expect(input.readKey).toHaveBeenCalledWith("/abu/bakery/secrets/openai_key");
    expect(input.login).toHaveBeenCalledWith("business-provider-credential");
    expect(result).toEqual({ status: "configured" });
  });
  it("preserves an existing founder login without reading another key", async () => {
    const input = { ...setup(), hasLogin: true };
    expect(await bootstrapBusinessCodex(input)).toEqual({ status: "existing-login" });
    expect(input.readKey).not.toHaveBeenCalled();
    expect(input.login).not.toHaveBeenCalled();
  });
  it("refuses a platform key or another business before credential access", async () => {
    for (const reference of [
      "ssm:/abu/platform/secrets/openai_key",
      "ssm:/abu/other/secrets/openai_key",
    ]) {
      const input = {
        ...setup(),
        manifest: manifest.replace("ssm:/abu/bakery/secrets/openai_key", reference),
      };
      await expect(bootstrapBusinessCodex(input)).rejects.toThrow("business's declared");
      expect(input.readKey).not.toHaveBeenCalled();
    }
  });
  it("does not attempt login after a refused credential read", async () => {
    const input = setup();
    input.readKey.mockRejectedValueOnce(new Error("unavailable"));
    await expect(bootstrapBusinessCodex(input)).rejects.toThrow("unavailable");
    expect(input.readKey).toHaveBeenCalledTimes(1);
    expect(input.login).not.toHaveBeenCalled();
  });
});

const client = "/opt/abu/founder-tools/bakery/founder-mcp.mjs";
const block = [
  FOUNDER_TOOLS_BEGIN,
  "[mcp_servers.business]",
  'command = "/opt/abu/harness-node/bin/node"',
  'args = ["/opt/abu/founder-tools/bakery/founder-mcp.mjs", "--abu", "bakery"]',
  FOUNDER_TOOLS_END,
].join("\n");

describe("the founder's Codex config", () => {
  it("appends the block to an empty or existing config, keeping every other line", () => {
    expect(withFounderTools("", "bakery", client)).toBe(`${block}\n`);
    const existing = [
      'model = "gpt-5.5"',
      "# the founder's note",
      "",
      "[mcp_servers.docs]",
      'command = "docs-mcp"',
      "",
      '[projects."/home/abu-founder-1/workspace"]',
      'trust_level = "trusted"',
    ].join("\n");
    const written = withFounderTools(`${existing}\n`, "bakery", client);
    expect(written).toBe(`${existing}\n\n${block}\n`);
    // No trailing newline in the founder's file.
    expect(withFounderTools(existing, "bakery", client)).toBe(`${existing}\n\n${block}\n`);
    // Writing again changes nothing.
    expect(withFounderTools(written as string, "bakery", client)).toBe(written);
  });

  it("replaces its own block, wherever Codex left it, and keeps tables Codex added after it", () => {
    const before = 'model = "gpt-5.5"\n';
    const stale = block.replace("--abu", "--old");
    // Codex appended a table after the block.
    const appended = `${before}\n${stale}\n\n[projects."/w"]\ntrust_level = "trusted"\n`;
    expect(withFounderTools(appended, "bakery", client)).toBe(
      `${before}\n[projects."/w"]\ntrust_level = "trusted"\n\n${block}\n`,
    );
    // Codex kept the end comment last, after the table it added, and added a key to the table.
    const moved = [
      'model = "gpt-5.5"',
      "",
      FOUNDER_TOOLS_BEGIN,
      "[mcp_servers.business]",
      'command = "/opt/abu/harness-node/bin/node"',
      'args = ["/somewhere/else.mjs"]',
      "enabled = false",
      "",
      "# the founder's projects",
      '[projects."/w"]',
      'trust_level = "trusted"',
      FOUNDER_TOOLS_END,
      "",
    ].join("\n");
    expect(withFounderTools(moved, "bakery", client)).toBe(
      [
        'model = "gpt-5.5"',
        "",
        "# the founder's projects",
        '[projects."/w"]',
        'trust_level = "trusted"',
        "",
        block,
        "",
      ].join("\n"),
    );
  });

  it("removes the block when the client is missing", () => {
    const before = 'model = "gpt-5.5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n';
    const written = withFounderTools(before, "bakery", client) as string;
    expect(withFounderTools(written, "bakery", null)).toBe(before);
    expect(withFounderTools(`${block}\n`, "bakery", null)).toBe("");
    expect(withFounderTools(before, "bakery", null)).toBe(before);
    const middle = `${before}\n${block}\n\n[projects."/w"]\ntrust_level = "trusted"\n`;
    expect(withFounderTools(middle, "bakery", null)).toBe(
      `${before}\n[projects."/w"]\ntrust_level = "trusted"\n`,
    );
  });

  it("refuses an unmarked [mcp_servers.business]", () => {
    for (const own of [
      '[mcp_servers.business]\ncommand = "mine"\n',
      '[ mcp_servers . "business" ]\ncommand = "mine"\n',
      "[mcp_servers.'business'.env]\nKEY = \"v\"\n",
      '[mcp_servers]\nbusiness = { command = "mine" }\n',
      '[mcp_servers]\nbusiness.command = "mine"\n',
      'mcp_servers.business.command = "mine"\n',
      'mcp_servers = { docs = { command = "docs-mcp" } }\n',
      '[[mcp_servers]]\nname = "x"\n',
      // A header this reader cannot parse counts as taken.
      '[mcp_servers.bu\u00dfiness]\ncommand = "x"\n',
    ]) {
      expect(withFounderTools(own, "bakery", client), own).toBe("conflict");
      // Our own stale block beside it changes nothing either.
      expect(withFounderTools(`${own}\n${block}\n`, "bakery", client), own).toBe("conflict");
    }
    // Another server, a profile's own servers and a string are not this table.
    for (const other of [
      '[mcp_servers.docs]\ncommand = "docs-mcp"\n',
      '[profiles.work.mcp_servers.business]\ncommand = "x"\n',
      'notes = """\n[mcp_servers.business]\n"""\n',
    ]) {
      expect(withFounderTools(other, "bakery", client), other).toBe(`${other}\n${block}\n`);
    }
  });

  it("names only this business's client", () => {
    expect(() =>
      withFounderTools("", "bakery", "/opt/abu/founder-tools/other/founder-mcp.mjs"),
    ).toThrow();
    expect(() => withFounderTools("", "Not a slug", null)).toThrow();
  });
});

describe("installing the founder tools", () => {
  const file = (uid: number, mode: number, isFile = true) => ({ uid, mode, isFile: () => isFile });
  beforeEach(() => {
    host.lstatSync.mockReset();
    host.execFileSync.mockClear();
  });

  it("offers the client only when it is a regular root-owned file nobody else can write", async () => {
    const offered = async (stat: unknown) => {
      host.lstatSync.mockReset();
      if (stat instanceof Error) {
        host.lstatSync.mockImplementation(() => {
          throw stat;
        });
      } else host.lstatSync.mockReturnValue(stat);
      host.execFileSync.mockClear();
      await installFounderTools("bakery", "abu-founder-1", "/home/abu-founder-1");
      expect(host.lstatSync).toHaveBeenCalledWith(client);
      const args = host.execFileSync.mock.calls[0]?.[1] as string[];
      return args.at(-1);
    };
    expect(await offered(file(0, 0o100444))).toBe(client);
    expect(await offered(file(0, 0o100644))).toBe(client);
    expect(await offered(file(2102, 0o100444))).toBe("-");
    expect(await offered(file(0, 0o100464))).toBe("-");
    expect(await offered(file(0, 0o100446))).toBe("-");
    expect(await offered(file(0, 0o120777, false))).toBe("-");
    expect(await offered(Object.assign(new Error("missing"), { code: "ENOENT" }))).toBe("-");
  });

  it("writes as the founder, through runuser, and reports the founder's result", async () => {
    host.lstatSync.mockReturnValue(file(0, 0o100444));
    host.execFileSync.mockReturnValueOnce("conflict\n");
    expect(await installFounderTools("bakery", "abu-founder-1", "/home/abu-founder-1")).toBe(
      "conflict",
    );
    const [command, args, options] = host.execFileSync.mock.calls[0] as [
      string,
      string[],
      { cwd: string; env: Record<string, string> },
    ];
    expect(command).toBe("runuser");
    expect(args.slice(0, 5)).toEqual([
      "-u",
      "abu-founder-1",
      "--",
      "env",
      "HOME=/home/abu-founder-1",
    ]);
    expect(args.slice(-3)).toEqual(["--founder-tools", "bakery", client]);
    expect(args.slice(5, -3)).toEqual([
      process.execPath,
      expect.stringMatching(/\/provider-bootstrap\.ts$/),
    ]);
    expect(options.cwd).toBe("/");
    expect(Object.keys(options.env).sort()).toEqual(["LANG", "PATH"]);
    host.execFileSync.mockReturnValueOnce("something else\n");
    await expect(
      installFounderTools("bakery", "abu-founder-1", "/home/abu-founder-1"),
    ).rejects.toThrow();
  });
});
