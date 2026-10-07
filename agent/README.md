# @spillway/agent

Ask Spillway answers plain questions about Monad's Morpho lending markets and Spillway's cover with real numbers. A model on Amazon Bedrock reads the question and calls Spillway's own engine (`@spillway/lending`) and Monad testnet as tools, so every figure in an answer comes from a tool result, not from the model.

Questions it answers:

- What happens to Steakhouse Prime ETH's depositors if wstETH is marked down 20%?
- Which collateral would hurt Monad lenders most if it failed?
- How much does cover cost for August USDC V2?
- Has the cover ever paid?

## API

`POST /api/ask` with JSON:

```json
{ "question": "Has the cover ever paid?", "market": "wstETH/WETH", "history": [{ "role": "user", "text": "..." }, { "role": "assistant", "text": "..." }] }
```

`market` (optional) is the market the reader is looking at, as an id or a pair. `history` (optional) holds earlier turns. The reply:

```json
{ "answer": "Yes, the cover has paid out on Monad testnet...", "tools": [{ "name": "testnet_cover", "input": {}, "summary": "Read the testnet cover at block 68,977,211" }] }
```

An error comes back as `{ "error": "One plain sentence." }` with a 4xx or 5xx status. `GET /api/health` returns the model id and the snapshot block.

## Tools

Each tool is a thin wrapper over existing code. The snapshot tools read `fixtures/morpho/monad-2026-10-06.json` with its adapters file and `DEFAULT_CONFIG`, loaded once at start (Monad block 111,058,632).

| Tool | What it returns | Built on |
| --- | --- | --- |
| `list_markets` | Markets with borrowers, largest debt first: pair, id, LLTV, borrowed and supplied, oracle kind, what a markdown means, exit depth. Totals and recorded bad debt. | `marketCurves` |
| `stress_market` | One market at a sudden markdown, thin exit by default: loss to suppliers, written off and not written off, borrower outcomes, split by vault. Also runs liquidators always act, nobody liquidates and oracle holds. | `runScenario`, `lossByVault` |
| `pml_ranking` | Collateral tokens ranked by probable maximum loss, with losses at 5%, 10%, 25% and 50% markdowns. | `pmlTable` |
| `vault_cover` | A vault's supply, cover limit, yearly rate, premium as a share of supply, expected loss, and its loss by collateral at a markdown. | `vaultExposure`, `priceVault`, `coverLimit` |
| `shortfall_proof` | The shortfall provable from Morpho's positions at a markdown, and the borrowers to name in `claimShortfall`. | `markedDown`, `shortfallWitness` |
| `testnet_cover` | Live from Monad testnet: the cover vault's capital and total paid, policy 1's limit and amount paid so far, what it could claim now, and the last claim. Cached for 15 s. | `web/src/cover` (`readLive`, claim events) through viem |

`test/tools.test.ts` checks each snapshot tool against the lending engine's own bundle.

## Model

Bedrock's Converse API with tool use, AWS SDK v3. The default model is `moonshotai.kimi-k2.5`, which runs on demand in us-east-1 with no inference profile. The documented fallback is `us.anthropic.claude-sonnet-5-5`, a cross-region inference profile; set `ASK_MODEL_ID` to use it.

The system prompt asks for at most three plain sentences, figures only from tool results, the snapshot or testnet block named, and "I can not tell from the data." when no tool covers the question. The server strips markdown and dashes from the answer.

## Run it locally

```bash
pnpm install
pnpm --filter @spillway/agent start
curl -s -X POST 127.0.0.1:8790/api/ask -H 'content-type: application/json' -d '{"question":"Has the cover ever paid?"}'
```

AWS credentials come from the environment or the usual AWS SDK chain, and need `bedrock:InvokeModel` on the model. The web app's widget (`web/src/agent/widget.ts`) posts to `/api/ask` by default, so put the server behind the same origin, for example with a proxy rule for `/api`.

Tests: `pnpm --filter @spillway/agent test`. The live test calls Bedrock and the testnet for real and runs only with `ASK_LIVE=1`; `ASK_LIVE_QUESTIONS` takes questions separated by `|`.

## Environment

| Variable | Default | Use |
| --- | --- | --- |
| `AWS_REGION` | `us-east-1` | Bedrock region |
| `ASK_MODEL_ID` | `moonshotai.kimi-k2.5` | Bedrock model or inference profile id |
| `ASK_HOST` | `127.0.0.1` | Address to bind |
| `ASK_PORT` | `8790` | Port (`PORT` also works) |
| `ASK_RATE_LIMIT` | `8` | Questions per IP per window |
| `ASK_RATE_WINDOW_MS` | `60000` | Rate limit window |
| `ASK_MAX_IN_FLIGHT` | `4` | Questions answered at once, across every IP |
| `ASK_TRUST_PROXY` | unset | `1` to take the client IP from the last `X-Forwarded-For` entry, behind your own proxy only |
| `ASK_ALLOW_ORIGIN` | unset | An origin allowed to call the API from a browser on another host |
| `MONAD_TESTNET_RPC` | `https://testnet-rpc.monad.xyz` | Monad testnet RPC |

## Safety limits

- Binds to 127.0.0.1 unless told otherwise.
- A question is at most 500 characters, a body at most 16 KB, and only the last 6 turns of history are kept, at 1,500 characters each.
- 8 questions per IP per minute (HTTP 429 with `Retry-After`), and at most 4 in flight (HTTP 503).
- At most 6 model calls per question and 45 s in all. The tools only read: the snapshot, and testnet through `eth_call` and receipts.
- Errors reach the client as one plain sentence. The server logs only an error's name and message, never a stack, and no credentials are read or written by the code.
