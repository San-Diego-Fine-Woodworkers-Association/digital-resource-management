// A TCP proxy between a test's client and the service, so a test can drop
// the connection partway through an upload the way a phone losing its signal
// does: every open connection is cut at once, mid-request.
import net from "node:net";
import type { AddressInfo } from "node:net";

export interface DroppingProxy {
  url: string;
  /** Bytes the client has sent through the proxy so far. */
  bytesUp: number;
  /** Once the client has sent this many bytes in all, the connection is cut, once. */
  dropAt: number;
  /** Cuts every open connection, in both directions. */
  drop: () => void;
  close: () => Promise<void>;
}

export async function startProxy(target: string): Promise<DroppingProxy> {
  const { hostname, port } = new URL(target);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(port), hostname);
    sockets.add(client);
    sockets.add(upstream);
    client.on("data", (chunk: Buffer) => {
      if (proxy.bytesUp + chunk.length > proxy.dropAt) {
        // Pass on what fits, then cut, mid-request.
        const fits = proxy.dropAt - proxy.bytesUp;
        proxy.bytesUp += fits;
        proxy.dropAt = Infinity;
        client.destroy();
        upstream.end(chunk.subarray(0, fits), () => proxy.drop());
        return;
      }
      proxy.bytesUp += chunk.length;
      if (!upstream.write(chunk)) client.pause();
    });
    upstream.on("drain", () => client.resume());
    upstream.pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    for (const s of [client, upstream]) {
      s.on("error", end);
      s.on("close", end);
    }
  });
  const proxy: DroppingProxy = {
    url: "",
    bytesUp: 0,
    dropAt: Infinity,
    drop: () => {
      for (const s of sockets) s.destroy();
    },
    close: () =>
      new Promise((resolve) => {
        proxy.drop();
        server.close(() => resolve());
      }),
  };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  proxy.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return proxy;
}
