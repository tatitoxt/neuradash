import { createServer } from "node:http";
import next from "next";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);

async function main() {
  const app = next({ dev, hostname, port });
  await app.prepare();
  const handle = app.getRequestHandler();

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  server.listen(port, hostname, () => {
    console.log(`> NeuraDash ready on http://localhost:${port} (${dev ? "dev" : "production"})`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
