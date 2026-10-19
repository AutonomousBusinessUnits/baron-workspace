/** A workspace stays on its business's machine; Baron frames only its web surface. */
export function baronFramePolicy(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    throw new Error("T3CODE_BARON_ORIGIN must be an HTTPS origin, or loopback HTTP.");
  return `frame-ancestors 'self' ${url.origin}`;
}
