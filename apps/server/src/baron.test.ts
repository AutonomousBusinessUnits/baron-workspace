import { describe, expect, it } from "vitest";
import { baronFramePolicy } from "./baron.ts";

describe("Baron framing", () => {
  it("allows the configured parent without granting another origin", () => {
    expect(baronFramePolicy("https://trybaron.ai")).toBe(
      "frame-ancestors 'self' https://trybaron.ai",
    );
    expect(baronFramePolicy("http://localhost:3003")).toBe(
      "frame-ancestors 'self' http://localhost:3003",
    );
    expect(baronFramePolicy(undefined)).toBeUndefined();
  });
  it.each([
    "https://trybaron.ai/",
    "http://trybaron.ai",
    "https://trybaron.ai/path",
    "https://user@trybaron.ai",
    "https://trybaron.ai; frame-ancestors *",
    "null",
  ])("rejects %s", (origin) => {
    expect(() => baronFramePolicy(origin)).toThrow();
  });
});
