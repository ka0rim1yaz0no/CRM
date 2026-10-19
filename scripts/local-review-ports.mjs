import net from "node:net";

export const localReviewHosts = ["127.0.0.1", "::1"];

export async function assertLocalPortAvailable(port, hosts = localReviewHosts) {
  for (const host of hosts) await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (error) => {
      if (host === "::1" && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) return resolve();
      reject(new Error(`Local port ${port} is unavailable on ${host}. No existing process was stopped.`, { cause: error }));
    });
    probe.listen({ port, host, ipv6Only: true }, () => probe.close(resolve));
  });
}
