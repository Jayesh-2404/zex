import {Request , Response , Router} from "express";
import {RedisManager} from "../redis/redis";

const orderRouter = Router();


//this api is for creating the order 
orderRouter.post('/' , async(req:Request , res: Response) => {
  try{
    const {market , price, quantity , side , userId} = req.body;
    const resp:any = await RedisManager.getInstance().sendAndWait({
      type:"CREATE_ORDER",
      data:{
        market,
        price,
        quantity,
        side,
        userId
      }
    })
    //dont understand why we are taking the payload here 
    res.json(resp.payload);
  }catch(error){
    console.log("error in creating order");
    res.status(500).json({message:"Internal server error in creating the order"});
  }
})

export default orderRouter;
