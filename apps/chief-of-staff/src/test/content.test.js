import test from "node:test";
import assert from "node:assert/strict";
import { resolveUri, chunkText, assertSafeWebTarget, exportDriveText } from "../content.js";

test("resolve_uri resolves web and drive uri schemes", () => {
  assert.equal(resolveUri({ url: "https://example.com/a" }).uri, "web+https://example.com/a");
  assert.equal(resolveUri({ fileId: "abc123", kind: "gdoc" }).uri, "gdoc://abc123");
  assert.equal(resolveUri({ fileId: "abc123", kind: "gsheet" }).uri, "gsheet://abc123");
  assert.equal(resolveUri({ fileId: "abc123", kind: "gslides" }).uri, "gslides://abc123");
});

test("chunk paging returns deterministic slices", () => {
  const text = "0123456789".repeat(7);
  const first = chunkText(text, { maxChars: 20, chunk: 0 });
  const second = chunkText(text, { maxChars: 20, chunk: first.nextChunk });
  assert.equal(first.text, text.slice(0, 20));
  assert.equal(second.text, text.slice(20, 40));
  assert.equal(first.nextChunk, 1);
  assert.equal(second.nextChunk, 2);
});

test("forbidden hosts/IPs are denied", async () => {
  await assert.rejects(() => assertSafeWebTarget("http://127.0.0.1/private"), /Blocked SSRF/);
  await assert.rejects(() => assertSafeWebTarget("http://localhost/foo"), /Blocked SSRF/);
  await assert.rejects(() => assertSafeWebTarget("http://10.0.0.1/internal"), /Blocked SSRF/);
  await assert.rejects(() => assertSafeWebTarget("http://192.168.1.1/"), /Blocked SSRF/);
  await assert.rejects(
    () => assertSafeWebTarget("https://example.com", { denylist: ["example.com"] }),
    /denylist/
  );
  // Note: DNS-level SSRF protection (checking resolved IPs) is not tested here.
  // Cloudflare Workers' network layer blocks egress to RFC-1918 addresses at
  // the infrastructure level, so per-domain DNS lookups are not performed.
});

test("drive export works for docs/sheets/slides mime routing", async () => {
  const urls = [];
  const fakeGfetch = async (url) => {
    urls.push(url);
    return { text: async () => "ok" };
  };

  await exportDriveText("gdoc", "file1", { gfetchImpl: fakeGfetch });
  await exportDriveText("gsheet", "file2", { gfetchImpl: fakeGfetch });
  await exportDriveText("gslides", "file3", { gfetchImpl: fakeGfetch });

  assert.match(urls[0], /mimeType=text%2Fplain/);
  assert.match(urls[1], /mimeType=text%2Fcsv/);
  assert.match(urls[2], /mimeType=text%2Fplain/);
});
