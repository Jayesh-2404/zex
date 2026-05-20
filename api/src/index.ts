import express, { Request, Response } from "express";
import cors from "cors";
import orderRouter from "./routes/order";
import {RedisManager} from "./redis/redis";
import viewRouter from "./routes/viewRouter";


const app = express();
const PORT = 3000;
app.use(express.json());
app.use(cors()); 
/* By default, browsers block a frontend (e.g., localhost:3001) from talking to a backend (localhost:3000). This line disables that block, allowing any website to call your API*/


app.get("/api/v1/test", (req: Request, res: Response) => {
  try {
    res.send("Test route working !!");
  } catch (error) {
    console.log("Test routes failed");
    res.status(500).json({ message: "Internal server error in Test Routes" });
    return;
  }
});

/*Routing: This tells the server: "If a request comes to /api/v1/order, stop handling it here and pass it over to the orderRouter file." It organizes your URLs neatly. */
app.use("/api/v1/order" , orderRouter);
app.use("/api/v1/klines" , viewRouter);
app.get("/api/v1/tickers", (req: Request, res: Response) => {
  try {
      const tickers = [
      {
        symbol: "SOL_USDC",
        firstPrice: "22.50",
        lastPrice: "23.10",
        high: "23.50",
        low: "22.10",
        priceChange: "0.60",
        priceChangePercent: "2.6",
        volume: "1200",
        quoteVolume: "28000",
        trades: "540"
      }];
      res.json(tickers);
  } catch (error) {
    console.log("Error in getting tickers ", error);
    res.status(500).json({ message: "internal server error in getting tickers" });
  }
});

app.get("/api/v1/depth", async (req: Request, res: Response) => {
  try {
    const { symbol } = req.query;
    const response = await RedisManager.getInstance().sendAndWait({
      type: "GET_DEPTH",
      data: {
        market: symbol as string
      }
    });
    res.status(200).json(response);
  } catch (error) {
    console.log("Error in getting depth");
    res.status(500).json({ message: "Error in getting depth", error });
  }
});

app.listen(PORT, () => {
  console.log(`server running on PORT ${PORT}`)
});

/*
what i understand by this lines of code is that we have written the api requests that is ultimatey going to work as the client in this project 

we have initialized the express server here 
first api get request is to test whether the server is running or not (express server)

app.use("/api/v1/order" , openRouter) is this mean by  we can access the order from this api and 
i dont fully understand the code it will be nice if you tell me the meaning of this 

then we have another get request which is asking for the tickers 

what i dont understand by the last request is why it is using async await instead of normal api calls is it because in this api request their can be some response which may take time and hence the operation should not stop they have used the async await thing 
*/
