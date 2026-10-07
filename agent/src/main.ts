// Starts the Ask Spillway server. Settings come from the environment (README.md).

import { DEFAULT_MODEL, ask, bedrockClient } from "./ask.js";
import { loadEngine } from "./engine.js";
import { askServer } from "./server.js";
import { testnetClient, testnetReader } from "./testnet.js";
import { makeTools } from "./tools.js";

const env = process.env;
const int = (v: string | undefined, def: number) => (v && Number.isFinite(Number(v)) ? Number(v) : def);

const engine = loadEngine();
const tools = makeTools(engine, testnetReader(testnetClient(env.MONAD_TESTNET_RPC)));
const client = bedrockClient(env.AWS_REGION ?? "us-east-1");
const modelId = env.ASK_MODEL_ID ?? DEFAULT_MODEL;
const host = env.ASK_HOST ?? "127.0.0.1";
const port = int(env.ASK_PORT ?? env.PORT, 8790);

const server = askServer({
  answer: (input) => ask(input, { client, modelId, tools, engine }),
  limits: {
    ratePerWindow: int(env.ASK_RATE_LIMIT, 8),
    windowMs: int(env.ASK_RATE_WINDOW_MS, 60_000),
    maxInFlight: int(env.ASK_MAX_IN_FLIGHT, 4),
  },
  trustProxy: env.ASK_TRUST_PROXY === "1",
  allowOrigin: env.ASK_ALLOW_ORIGIN,
  health: () => ({ model: modelId, snapshotBlock: engine.block }),
});

server.listen(port, host, () => {
  console.log(`Ask Spillway on http://${host}:${port}/api/ask, model ${modelId}, snapshot block ${engine.block}`);
});
