// Calls Bedrock and the Monad testnet for real. Run with ASK_LIVE=1 and AWS credentials in the
// environment; skipped otherwise.

import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, ask, bedrockClient } from "../src/ask.js";
import { loadEngine } from "../src/engine.js";
import { testnetReader } from "../src/testnet.js";
import { makeTools } from "../src/tools.js";

const live = process.env.ASK_LIVE === "1";
const QUESTIONS = (process.env.ASK_LIVE_QUESTIONS ?? "What happens to Steakhouse Prime ETH's depositors if wstETH is marked down 20%?").split("|");

describe.skipIf(!live)("live", () => {
  const engine = loadEngine();
  const tools = makeTools(engine, testnetReader());
  const modelId = process.env.ASK_MODEL_ID ?? DEFAULT_MODEL;

  for (const question of QUESTIONS) {
    it(`answers: ${question}`, async () => {
      const out = await ask({ question }, { client: bedrockClient(), modelId, tools, engine });
      console.log(JSON.stringify({ modelId, question, ...out }, null, 2));
      expect(out.answer.length).toBeGreaterThan(0);
      expect(out.tools.length).toBeGreaterThan(0);
      expect(out.answer).not.toMatch(/[\u2013\u2014]/);
    }, 120_000);
  }
});
