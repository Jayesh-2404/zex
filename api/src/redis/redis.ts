import {createClient , RedisClientType} from "redis";
import {v4 as uuidv4} from 'uuid';

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

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
  public static getInstance(){
    if(!this.instance){
      this.instance = new RedisManager();
      return this.instance;
    }
    return this.instance;
  }
  //publishing to queue and then waiting for it 
  public sendAndWait(message:any){
    return new Promise(async (resolve, reject)=>{
      const id = this.getRandomId();
      try {
        await this.client.subscribe(id, (message) => {
          this.client.unsubscribe(id);
          resolve(JSON.parse(message));
        });
        await this.publisher.lPush("message", JSON.stringify({ clientId: id, message }));
      } catch (error) {
        reject(error);
      }
    })
  }
  public getRandomId(){
    return uuidv4()
  }
}
