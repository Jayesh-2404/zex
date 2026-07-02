import {createClient , RedisClientType} from "redis";
import {v4 as uuidv4} from 'uuid';

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const DEFAULT_TIMEOUT_MS = 5000;

export class RedisManager{
  //pusblishing to engine via queue
  private publisher : RedisClientType;
  private client : RedisClientType;//recieving via pub subs
  private static instance : RedisManager;
  private constructor(){
    this.client = createClient({
      url: REDIS_URL
    });
    this.client.connect();
    this.publisher = createClient({
      url: REDIS_URL
    });
    this.publisher.connect()
  }
  // TODO: add disconnect logic for graceful shutdown
  public static getInstance(){
    if(!this.instance){
      this.instance = new RedisManager();
      return this.instance;
    }
    return this.instance;
  }
  //publishing to queue and then waiting for it 
  public sendAndWait<T = unknown>(message: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T>{
    return new Promise(async (resolve, reject)=>{
      const id = this.getRandomId();
      const timeout = setTimeout(async () => {
        await this.client.unsubscribe(id).catch(() => undefined);
        reject(new Error(`Engine request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        await this.client.subscribe(id, (message: string) => {
          clearTimeout(timeout);
          this.client.unsubscribe(id).catch(() => undefined);
          resolve(JSON.parse(message) as T);
        });
        await this.publisher.lPush("message", JSON.stringify({ clientId: id, message }));
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    })
  }
  public getRandomId(){
    return uuidv4()
  }
}
