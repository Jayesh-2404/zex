import { app, closeKlineClient } from "./app.js";
import { RedisManager } from "./redis/redis.js";

const PORT = Number(process.env.PORT ?? 3000);

app.listen(PORT, () => {
  console.log(`server running on PORT ${PORT}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down API`);
  await closeKlineClient();
  await (await RedisManager.getInstance()).disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
