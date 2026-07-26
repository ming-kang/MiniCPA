import http from "node:http";

export type FixtureHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;

/**
 * Local HTTP fixture for tests: starts a server on 127.0.0.1:0, routes by
 * pathname, and always closes in finally. 404s any unrouted path.
 */
export async function withHttpFixture<T>(
  routes: Record<string, FixtureHandler>,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const handler = routes[pathname];
    if (!handler) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    handler(req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("fixture server has no port");
  }

  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
}
