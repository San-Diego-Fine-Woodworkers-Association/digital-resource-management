// Entry point: `node server/main.ts` (Node runs the TypeScript directly).
import { loadConfig } from "./config.ts";
import { createService } from "./app.ts";

const config = loadConfig(process.env);
const service = createService(config);

service.listen(config.port, () => {
  process.stderr.write(
    JSON.stringify({
      time: new Date().toISOString(),
      message: "upload service listening",
      port: config.port,
      paused: config.uploadsPaused,
    }) + "\n",
  );
});

function shutdown() {
  service.close(() => process.exit(0));
  // Don't hang on idle keep-alive connections.
  service.closeIdleConnections();
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
