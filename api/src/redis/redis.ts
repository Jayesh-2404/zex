import {createClient , RedisClientType} from "redis";
import {v4 as uuidv4} from 'uuid';

export class RedisManager{
  //pusblishing to engine via queue
  private publisher : RedisClientType;
  private client : RedisClientType;//recieving via pub subs
  private static instance : RedisManager;
  private constructor(){
    this.client = createClient({
      url:"redis://redis:6379"
    });
    this.client.connect();
    this.publisher = createClient({
      url:"redis://redis:6379"
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
    return new Promise((resolve)=>{
      const id = this.getRandomId();
      this.client.subscribe(id ,(message) => {
        this.client.unsubscribe(id);
        resolve(JSON.parse(message));
      })
      this.publisher.1Push("message" , JSON.stringify({clientId: id , message}));
    })
  }
  public getRandomId(){
    return uuidv4
  }
}