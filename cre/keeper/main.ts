// Entry point compiled to WASM by `cre workflow build` and `cre workflow simulate`.

import { Runner } from "@chainlink/cre-sdk"
import { configSchema, type Config } from "./keeper"
import { initWorkflow } from "./workflow"

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema })
  await runner.run(initWorkflow)
}
