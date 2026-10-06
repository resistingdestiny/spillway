<!-- Research behind the lending stress tests and cover pricing, 6 October 2026. Scripts and raw outputs are in research/. -->

# Collateral failure rates, Monad Morpho oracles and exit liquidity

*Snapshot 6 Oct 2026, Monad block 111062289. Values for the engine are in `research/research-config.json`, built by the scripts in `research/`. "Unconfirmed" means not checked against a primary source.*

## Summary

1. **Failure rates differ by class.** Synthetic dollars fail about 10% a year (20% for delta-neutral or managed dollars alone). LSTs and LRTs fail about 1.6% a year, RWA/credit and wrapped BTC near 5%. Failed synthetic dollars usually lose over 75% and do not recover.
2. **None of the eight largest Monad Morpho oracles reads a market price for the collateral.** Six use an issuer or vault figure, two a Pendle TWAP of the PT against its own underlying, and seven hardcode the loan-asset peg. A depeg would not trigger liquidations. Losses would appear at once, when an issuer marks down.
3. **Monad has almost no DEX exit for this collateral.** Only syrupUSDC and the two PTs (through Pendle's API) sell $1M with under 1% loss. wstETH loses 18.6% at $100k. USDe, wsrUSD, savUSD, aHYPER and earnAUSD lose over 90% at $100k. strUSD, mROX, mHyperBTC and vUSD have no route. Liquidators would have to bridge or redeem, outside one atomic transaction.

## 1. Collateral failure frequencies, 2022 to Oct 2026

**Method.**
- **Failure:** a sustained depeg beyond 10%, or a loss passed to lenders or holders.
- **Universe:** DefiLlama protocols in the relevant categories with TVL of at least $50M today ([api.llama.fi/protocols](https://api.llama.fi/protocols)). Failed tokens that have since shrunk below that threshold are added back, to limit survivorship bias.
- **Token-years:** for each token, the time from max(DefiLlama `listedAt`, 1 Jan 2022) to its failure date or to today.
- **Range:** a 90% Poisson (Garwood) interval on the failure count.
- **Severity:** lowest DefiLlama daily price against the pre-incident level, then the level 30 and 180 days later ([coins.llama.fi/chart](https://coins.llama.fi/chart/coingecko:terrausd?start=1651363200&span=200&period=1d); one URL per incident in the config).

| Class | Tokens | Token-years | Failures | Annual p | 90% range | With borderline |
|---|---|---|---|---|---|---|
| Synthetic / yield dollars (Basis Trading, CDP, dual-token) | 28 | 58.2 | 6 | **10.3%** | 4.5% to 20.4% | 12.0% |
| Same, narrow (Basis Trading only, no sUSD) | 18 | 25.2 | 5 | **19.9%** | 7.8% to 41.8% | |
| LST and LRT | 46 | 129.4 | 2 | **1.6%** | 0.3% to 4.9% | 2.3% |
| RWA and credit | 24 | 57.8 | 3 | **5.2%** | 1.4% to 13.4% | 6.9% |
| Wrapped BTC | 21 | 39.4 | 2 | **5.1%** | 0.9% to 16.0% | 7.6% |
| Curator vault tokens (Morpho V1+V2 vaults above $1M) | 211 | 189.1 | 18 | **9.5%** | 6.2% to 14.1% | |
| Pendle PT, PT-specific term | n/a | 225 (assumed) | 0 | **under 1.3%** (rule of three) | | |

**How to read the table.**
- **PTs:** take the rate of the underlying class, then add the PT-specific term. Every PT loss found came from its underlying failing; none came from Pendle itself. The PT exposure figure is an assumption: 451 expired Ethereum Pendle markets ([Pendle API](https://api-v2.pendle.finance/core/v1/1/markets/inactive)) times an assumed 0.5-year average life.
- **Curator vaults:** the denominator only counts vaults above $1M today ([Morpho API](https://blue-api.morpho.org/graphql)), so the rate leans high. Euler vaults are not counted.
- **Synthetic dollars:** the broad universe includes DAI/USDS, LUSD and crvUSD. The narrow figure fits USDe-like collateral better.
- **Not checked:** MIM and others were not screened.

### Incidents used

| Date | Token | Class | What happened | Size | Low vs pre | 30 d / 180 d later | Source |
|---|---|---|---|---|---|---|---|
| 2022-05-09 | UST | Synthetic | Algorithmic collapse | not fetched | -99.4% | 0.045 / 0.023 | [DefiLlama chart](https://coins.llama.fi/chart/coingecko:terrausd?start=1651363200&span=200&period=1d) |
| 2025-04-10 | sUSD | Synthetic | Depeg | not fetched | -24.6% | 0.965 / 0.997 | [chart](https://coins.llama.fi/chart/coingecko:nusd?start=1735689600&span=300&period=1d) |
| 2025-11-04 | xUSD (Stream) | Synthetic | Fund manager loss, withdrawals frozen | $93M loss; $143.5M unrealised Morpho bad debt (xUSD/USDC, Arbitrum) | -77% (headline) | not recovered; creditor claims opened Jun 2026 | [news RSS](https://news.google.com/rss/search?q=Stream+Finance+xUSD+93+million), [Morpho API](https://blue-api.morpho.org/graphql) |
| 2025-11-06 | deUSD / sdeUSD (Elixir) | Synthetic | Shut down after Stream exposure | $45.6M + $1.4M unrealised Morpho bad debt | sdeUSD now $0.00000001 | none | [Morpho API](https://blue-api.morpho.org/graphql), [price](https://coins.llama.fi/prices/current/ethereum:0x5C5b196aBE0d54485975D1Ec29617D42D9198326) |
| 2025-11-06 | USDX (Stables Labs) | Synthetic | Depeg, liquidity drain allegations | not fetched | -99.0% | 0.011 / 0.024 | [chart](https://coins.llama.fi/chart/coingecko:usdx-money-usdx?start=1760918400&span=200&period=1d), [news RSS](https://news.google.com/rss/search?q=Stables+Labs+USDX+depeg) |
| 2026-03-22 | USR (Resolv) | Synthetic | Key compromise, 80M unbacked USR | $24.5M hack; $270M wstUSR, $34M USR (Base), $12.4M USR, $90M RLP unrealised on Morpho | -91.5% daily, $0.0025 intraday | 0.087 now | [DefiLlama hacks](https://api.llama.fi/hacks), [Halborn](https://www.halborn.com/blog/post/explained-the-resolv-hack-march-2026), [chart](https://coins.llama.fi/chart/coingecko:resolv-usr?start=1773532800&span=200&period=1d) |
| 2022-12-02 | aBNBc (Ankr) | LST | Unbacked mint | $5M | not fetched | | [DefiLlama hacks](https://api.llama.fi/hacks) |
| 2026-04-18 | rsETH (Kelp) | LRT | Bridge message spoofing; Aave shortfall covered by coalition | $293M | -20.1% vs ETH | 1.070 / 1.073 (full recovery) | [hacks](https://api.llama.fi/hacks), [Aave report](https://governance.aave.com/t/rseth-incident-report-april-20-2026/24580), [chart](https://coins.llama.fi/chart/coingecko:kelp-dao-restaked-eth,coingecko:ethereum?start=1775347200&span=150&period=1d) |
| 2022-12-05 | Maple pools | Credit | Orthogonal Trading default | $36M | not confirmed | recovery not confirmed | [news RSS](https://news.google.com/rss/search?q=Maple+Finance+Orthogonal+Trading+default) |
| 2023-08-12 | Goldfinch pool | Credit | Motorbike lender default | $5M | not confirmed | | [news RSS](https://news.google.com/rss/search?q=Goldfinch+loan+default+writedown) |
| 2023-10-11 | USDR (Tangible) | RWA | Run on real-estate reserves | not fetched | -48.2% | 0.658 | [chart](https://coins.llama.fi/chart/coingecko:real-usd?start=1696118400&span=200&period=1d) |
| 2023-07-07 | multiBTC (Multichain) | Wrapped BTC | Bridge collapse | $126M (whole bridge) | not fetched | | [hacks](https://api.llama.fi/hacks) |
| 2024-09-26 | uniBTC (Bedrock) | Wrapped BTC | Mint exploit | $2M | -33.2% vs WBTC (daily) | 0.945 | [hacks](https://api.llama.fi/hacks), [chart](https://coins.llama.fi/chart/coingecko:universal-btc,coingecko:wrapped-bitcoin?start=1726790400&span=30&period=1d) |
| 2025-11 / 2026-03 | Curator vaults | Vault | Resolv: 15 Morpho vaults hit. Stream/Elixir: count unconfirmed, taken as 3 | above | | | [Halborn](https://www.halborn.com/blog/post/explained-the-resolv-hack-march-2026) |
| 2026-03-22 | PT-RLP-9APR2026 | PT | Underlying (Resolv) failed | $17.7M unrealised Morpho bad debt | | | [Morpho API](https://blue-api.morpho.org/graphql) |

**Borderline events, counted only in the "with borderline" column:**
- **USD0++, Jan 2025:** fell 8.7% on daily data, under the 10% threshold ([chart](https://coins.llama.fi/chart/coingecko:usd0-liquid-bond?start=1734652800&span=150&period=1d)).
- **ezETH, 24 Apr 2024:** fell 14.4% against ETH on hourly data. It was back to 0.98 within two days ([chart](https://coins.llama.fi/chart/coingecko:renzo-restaked-eth,coingecko:ethereum?start=1713744000&span=120&period=1h)).
- **TrueFi defaults:** not confirmed with a source.
- **renBTC:** DefiLlama shows it near peg until Jun 2023, but 81% below WBTC today ([price](https://coins.llama.fi/prices/current/coingecko:renbtc,coingecko:wrapped-bitcoin)). Unconfirmed.

**Excluded:** stETH, Jun 2022, fell 4.7% on daily data ([chart](https://coins.llama.fi/chart/coingecko:staked-ether,coingecko:ethereum?start=1654041600&span=60&period=1d)).

**Severity pattern.**
- **Synthetic dollars:** median low of -91.5% across UST, sUSD, USDX, USR and xUSD. Only sUSD recovered.
- **LRTs:** rsETH recovered fully because others paid: a bailout, not a structural recovery.
- **RWA, BTC wrappers:** USDR and uniBTC lost 33% to 48% and recovered only partly.
- **For the engine:** model loss given failure as about 90% for synthetic dollars, 20% to 50% for RWA and BTC wrappers, and recovery-dependent for LRTs.

## 2. Oracles behind the eight largest Monad Morpho markets

Market ids and oracle addresses come from the [Morpho API](https://blue-api.morpho.org/graphql) (chainId 143). Each oracle and feed was read directly from https://rpc.monad.xyz at block 111062289. Non-standard contracts were identified by selector lookup ([4byte.sourcify.dev](https://api.4byte.sourcify.dev/signature-database/v1/lookup)).

| Market (LLTV, borrow) | Oracle | Feed(s) | What moves it | Fixed assumptions | Does a depeg trigger liquidation? |
|---|---|---|---|---|---|
| wstETH/WETH (94.5%, $35.3M) | `0xBB16…6694` ChainlinkOracleV2 | BASE_FEED_1 `0x0268…26e6`, a Chronicle oracle with `wat()` = "WSTETH/STETH" | **Exchange rate** | stETH = ETH | **No.** A wstETH or stETH market discount is invisible. |
| aHYPER/USDC (77%, $34.4M) | `0x4af4…FBec` | No feeds. BASE_VAULT = aHYPER (Hyperithm Delta Neutral Vault), `convertToAssets` | **Vault share price** (1.0803) | USDC = 1 | **No.** `totalAssets()` reads 64,443.8 USDC against 83.8M shares, so the share price is a vault-reported figure, not onchain balances (inference). |
| PT-USDat-14JAN2027/USDC (91.5%, $21.4M) | `0x5979…dAB2`, an EIP-1167 proxy to a primary/backup meta-oracle | Primary `0x67cD…ED6C` → Pendle Chainlink-compatible oracle `0x5346…0977`, market `0x88C5…9538`, TWAP 900 s, PT-to-asset | **Market price (TWAP) of PT against USDat** | USDat = USDC | **A PT selloff, yes, after 15 min. A USDat depeg, no.** The backup is an owner-settable wrapper that now points at the primary. Deviation threshold 1%, challenge timelock 4 h, healing 12 h. |
| earnAUSD/USDC (91.5%, $7.3M) | `0x3C45…0CEE` | BASE_FEED_1 `0xf43D…8Cb0`, "earnAUSD Share Price Oracle", reading vault `0x36eD…06aA` `getSharePrice()` = 1.045724 | **Operator-reported NAV** | AUSD = USDC | **No.** The vault has `updateTotalAssets()`. 98.7% of its assets sit outside it (`externalAssets`). `maxChangePercent` = 3, units unconfirmed. |
| strUSD/AUSD (86%, $6.1M) | `0x941A…20F0` | BASE_FEED_1 RedStone "strUSD_FUNDAMENTAL"; QUOTE_FEED_1 "AUSD / USD" | **Exchange rate over a market quote** | none | **No.** A strUSD depeg is invisible. An AUSD fall raises collateral value in AUSD terms. |
| mROX/AUSD (86%, $5.5M) | `0xA78e…Ca2D` | BASE_FEED_1 "mROX/USD", a Midas custom aggregator (admin `setRoundData`) | **Issuer NAV push**, last updated about 4 days before the read | AUSD = $1 | **No.** `maxAnswerDeviation` raw value 31000000, units unconfirmed. |
| mHyperBTC/cbBTC (77%, $3.8M) | `0xCb8D…F01F` | BASE_FEED_1 "mHyperBTC/BTC", Midas custom aggregator | **Issuer NAV push**, updated about 6 h before the read | cbBTC = BTC | **No.** |
| PT-AUSD-8OCT2026/USDC (91.5%, $3.5M) | `0x436C…85a2` | BASE_FEED_1 Pendle oracle `0x8565…B420`, market `0x6f99…fE7`, TWAP 900 s, PT-to-asset | **Market price (TWAP) of PT against AUSD** | AUSD = USDC | **A PT selloff, yes. An AUSD depeg, no.** Matures 8 Oct 2026. |

**What this means.**
- **About $117M of borrowing rests on oracles that cannot see a depeg.** Seven of eight markets hardcode a peg between the collateral's unit and the loan asset. The other one, strUSD, uses a quote feed whose direction cannot cause liquidations.
- **Losses arrive as a jump, not a slide.** Six oracles are issuer or vault figures. If the backing fails, the price holds until the issuer marks it down, then moves in one step. On Midas feeds a per-update deviation cap may stretch the markdown over several updates (units unconfirmed).
- **Bad debt lands in a single block.** Near the 77% to 94.5% LLTVs, a markdown that crosses the liquidation point creates bad debt in one block. The liquidator then faces the exit depths in section 3.
- **For stress tests:** model the issuer's markdown as the trigger, not a market price. Morpho's `badDebtAssets` still records the loss once realised.

## 3. Exit liquidity on Monad

**Method.**
- **Sizes:** each token was sold into its loan asset at $1k, $100k, $1M and $10M, sized at the Morpho API USD price.
- **Reference:** for the eight markets, the market's own oracle price (Morpho `state.price`). For the five extra tokens, the Morpho API USD price ratio. The figure shown is output / (input × reference) - 1, so it includes any premium of oracle over market as well as price impact.
- **Best venue:** the best result across all venues is shown. Every quote is in `quotes.jsonl` and `pendle_quotes.jsonl`. Quotes were taken on 6 Oct 2026 between 14:43 and 14:47 UTC (Pendle quotes just after).

**Quote APIs.**

| Venue | Public quote API on Monad? | Notes |
|---|---|---|
| KyberSwap | Yes | [aggregator-api.kyberswap.com/monad](https://aggregator-api.kyberswap.com/monad/api/v1/routes) |
| Kuru Flow | Yes, free JWT (1 request/s) | [docs](https://docs.kuru.io/api-reference/calculate-best-path-quote.md); found wstETH depth the others missed |
| Monorail | Yes | [pathfinder.monorail.xyz/v4/quote](https://pathfinder.monorail.xyz/v4/quote) |
| LI.FI | Yes | [li.quest/v1/quote](https://li.quest/v1/quote). Routes same-chain swaps through KyberSwap and drops routes above 10% impact. |
| Pendle hosted SDK | Yes | [api-v2.pendle.finance](https://api-v2.pendle.finance/core/v2/sdk/143/convert). The only venue that routes PTs through the Pendle AMM. |
| 0x | No: "No API key found in request" | |
| OKX DEX | No: OK-ACCESS-KEY header required | |
| 1inch | No: "Unauthorized" | |
| Uniswap Trading API | No: empty reply without a key | Uniswap pools are still reached through the aggregators above |
| ParaSwap | No: chain 143 not supported | |
| Odos, OpenOcean | Blocked (Cloudflare 1033 / challenge) | Unconfirmed |

**Best quote against reference**

| Token → loan asset | $1k | $100k | $1M | $10M | Best venue |
|---|---|---|---|---|---|
| wstETH → WETH | -0.7% | -18.6% | -68.9% | -95.7% | Kuru (KyberSwap at $1k) |
| aHYPER → USDC | -69.8% | -94.9% | -99.96% | -100% | none usable |
| PT-USDat-14JAN2027 → USDC | -0.06% | -0.11% | -0.83% | no route ("MarketProportionTooHigh") | Pendle API |
| earnAUSD → USDC | -1.4% | -91.0% | -98.8% | -99.9% | KyberSwap |
| strUSD → AUSD | no route | no route | no route | no route | none ("token not found" on KyberSwap) |
| mROX → AUSD | no route | no route | no route | no route | none |
| mHyperBTC → cbBTC | no route | no route | no route | no route | none |
| PT-AUSD-8OCT2026 → USDC | -0.01% | -0.01% | -0.08% | -66.7% | Pendle API |
| syrupUSDC → USDC | -0.10% | -0.11% | -0.23% | -51.7% | KyberSwap / Monorail |
| USDe → USDC | -77.7% | -94.4% | -99.0% | -99.9% | KyberSwap |
| vUSD → USDC | no route | no route | no route | no route | none |
| wsrUSD → USDC | -94.4% | -99.8% | -99.98% | -100% | none usable |
| savUSD → AUSD | -78.3% | -95.1% | -99.5% | -99.97% | none usable |

**Findings.**
- **Use more than one venue.** General aggregators skip the Pendle AMM and showed -82% to -99% on PTs, against -0.08% at $1M on Pendle's API. For wstETH at $100k, Kuru gave -18.6% and KyberSwap -97.5%.
- **wstETH/WETH cannot be liquidated through Monad DEXs at size.** It holds $39.2M of collateral, with one $18.5M borrower at health factor 1.031, and LI.FI found no bridge route to Ethereum. Liquidators would need their own WETH and would carry the wstETH.
- **USDe has no DEX exit on Monad, but bridges cleanly.** LI.FI moves $1M of USDe to Ethereum through Glacis at -0.27% in tokens, in an estimated 3 s. The $67.9M of USDe on Aave Monad would leave this way, not inside an atomic liquidation.
- **Redemption is the only exit for some tokens.** mROX, mHyperBTC, strUSD, vUSD, earnAUSD and aHYPER have no material DEX liquidity. A liquidator must redeem with the issuer, through queues or lags (earnAUSD `lagDuration` is 259200 s).
- **Caveat.** "No route" means no API returned a quote, not proof of zero liquidity.

## Open questions

1. Units of Midas `maxAnswerDeviation` and earnAUSD `maxChangePercent` (how fast a markdown reaches the oracle).
2. How aHYPER's `sharePrice()` is set (its signer or strategy).
3. Per-vault losses in the Stream/Elixir event.
4. Severity and recovery for aBNBc, multiBTC, Maple and Goldfinch.
5. Euler, Aave and Curvance oracles for the five extra tokens are unread.
