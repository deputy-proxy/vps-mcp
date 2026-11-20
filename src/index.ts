import { createHttpServer } from "./server.js";
import { config } from "./config.js";
import fs from "node:fs/promises";

await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });

const app = createHttpServer();
const httpServer = app.listen(config.port, config.host, () => {
  console.log(`vps-mcp listening on http://${config.host}:${config.port}/mcp`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
