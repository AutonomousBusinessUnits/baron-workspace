import { describe, expect, it, vi } from "vitest";
import { bootstrapBusinessCodex } from "../../../deploy/provider-bootstrap.ts";

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
