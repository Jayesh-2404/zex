import {createClient , RedisClientType} from "redis";
import {v4 as uuidv4} from 'uuid';

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const DEFAULT_TIMEOUT_MS = 5000;

// node-redis 6 negotiates RESP 3 by default, which Redis servers older than 6.0
// (such as the Redis 5 used for local development) reject, leaving the client
// retrying forever. Compose runs Redis 7, so RESP 2 is the portable choice.
export const REDIS_CLIENT_OPTIONS = { RESP: 2 } as const;

export class RedisManager{
  //pusblishing to engine via queue
  private publisher : RedisClientType<{}, {}, {}, 2>;
  private client : RedisClientType<{}, {}, {}, 2>;//recieving via pub subs
  private static instance : RedisManager;
  private static connecting : Promise<RedisManager> | undefined;

  private constructor(){
    this.client = createClient({ url: REDIS_URL, ...REDIS_CLIENT_OPTIONS });
    this.publisher = createClient({ url: REDIS_URL, ...REDIS_CLIENT_OPTIONS });
  }

  private async connect(): Promise<this> {
    // Both connections are awaited here rather than in the constructor, so a
    // Redis outage surfaces as a rejected request instead of an unhandled
    // rejection at import time.
    await Promise.all([this.client.connect(), this.publisher.connect()]);
    return this;
  }

  public async disconnect(): Promise<void> {
    await this.client.quit().catch(() => undefined);
    await this.publisher.quit().catch(() => undefined);
  }

  public static async getInstance(): Promise<RedisManager>{
    if(!this.instance){
      // Concurrent callers share one in-flight connect instead of racing to
      // create overlapping clients.
      this.connecting ??= new RedisManager().connect();
      this.instance = await this.connecting;
    }
    return this.instance;
  }

  //publishing to queue and then waiting for it
  public sendAndWait<T = unknown>(message: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T>{
    return new Promise<T>((resolve, reject)=>{
      // Any failure inside the subscribe/publish sequence must reject the
      // caller's promise. An async executor would instead throw where nothing
      // is listening, turning a Redis fault into a hung request.
      void (async () => {
        const id = this.getRandomId();
        const timeout = setTimeout(() => {
          void this.client.unsubscribe(id).catch(() => undefined);
          reject(new Error(`Engine request timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        try {
          await this.client.subscribe(id, (raw: string) => {
            clearTimeout(timeout);
            void this.client.unsubscribe(id).catch(() => undefined);
            resolve(JSON.parse(raw) as T);
          });
          await this.publisher.lPush("message", JSON.stringify({ clientId: id, message }));
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      })();
    })
  }

  public getRandomId(){
    return uuidv4()
  }
}
