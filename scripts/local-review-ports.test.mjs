import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { assertLocalPortAvailable } from "./local-review-ports.mjs";

for (const host of ["127.0.0.1", "::1"]) test(`local review detects an existing ${host} listener`, async (context) => {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ host, port: 0, ipv6Only: true }, resolve); });
  } catch (error) {
    if (host === "::1" && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) return context.skip("IPv6 loopback unavailable");
    throw error;
  }
  const port = server.address().port;
  try { await assert.rejects(assertLocalPortAvailable(port), /No existing process was stopped/); }
  finally { await new Promise((resolve) => server.close(resolve)); }
  await assertLocalPortAvailable(port);
});
