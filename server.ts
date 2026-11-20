import { createServer } from "node:http";
import next from "next";
import { closeDb } from "@/lib/db/client";
import { createRealtime } from "@/server/realtime";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (see .env.example)");

  const app = next({ dev, hostname, port });
  await app.prepare();
  const handle = app.getRequestHandler();
  const nextUpgrade = app.getUpgradeHandler();
  const realtime = createRealtime({ listenConnectionString: databaseUrl });

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    if (!realtime.handleUpgrade(req, socket, head)) void nextUpgrade(req, socket, head);
  });

  await realtime.ready;
  server.listen(port, hostname, () => {
    console.log(`> NeuraDash ready on http://localhost:${port} (${dev ? "dev" : "production"})`);
  });

  const shutdown = async () => {
    server.close();
    await realtime.close();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
