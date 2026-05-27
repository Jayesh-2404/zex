import express, { Request, Response } from "express";
import cors from "cors";
import orderRouter from "./routes/order";
import {RedisManager} from "./redis/redis";
import viewRouter from "./routes/viewRouter";


const app = express();
const PORT = 3000;
app.use(express.json());
app.use(cors()); 

app.get("/api/v1/test", (req: Request, res: Response) => {
  try {
    res.send("Test route working !!");
  } catch (error) {
    console.log("Test routes failed");
    res.status(500).json({ message: "Internal server error in Test Routes" });
    return;
  }
});

app.use("/api/v1/order" , orderRouter);
app.use("/api/v1/klines" , viewRouter);

interface EngineResponse<T> {
  type: string;
  payload: T;
}

function isValidMarket(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9]+_[A-Z0-9]+$/.test(value);
}

app.get("/api/v1/tickers", async (req: Request, res: Response) => {
  try {
      const response = await RedisManager.getInstance().sendAndWait<EngineResponse<unknown[]>>({
        type: "GET_TICKERS",
        data: {}
      });
      res.json(response.payload);
  } catch (error) {
    console.log("Error in getting tickers ", error);
    res.status(500).json({ message: "internal server error in getting tickers" });
  }
});

app.get("/api/v1/depth", async (req: Request, res: Response) => {
  try {
    const { symbol } = req.query;

    if (!isValidMarket(symbol)) {
      return res.status(400).json({ message: "symbol must use SYMBOL_QUOTE format, for example SOL_USDC" });
    }

    const response = await RedisManager.getInstance().sendAndWait<EngineResponse<unknown>>({
      type: "GET_DEPTH",
      data: {
        market: symbol
      }
    });
    res.status(200).json(response.payload);
  } catch (error) {
    console.log("Error in getting depth", error);
    res.status(500).json({ message: "Error in getting depth", error });
  }
});

app.listen(PORT, () => {
  console.log(`server running on PORT ${PORT}`)
});

