#!/usr/bin/env python3
"""Builds research-config.json from the raw pulls in this directory."""
import json, collections
F = json.load(open("frequencies.json"))
PR = json.load(open("incident_prices.json"))
M = json.load(open("markets_raw.json"))["data"]["markets"]["items"][:8]
Q = [json.loads(l) for l in open("quotes.jsonl")]
PQ = [json.loads(l) for l in open("pendle_quotes.jsonl")]
MORPHO = "https://blue-api.morpho.org/graphql"
LLAMA_P = "https://api.llama.fi/protocols"
HACKS = "https://api.llama.fi/hacks"
def news(q): return "https://news.google.com/rss/search?q=" + q.replace(" ", "+")
def pr(k): return {"low_vs_pre": round(PR[k]["drawdown"], 4), "low_date": PR[k]["low_date"], "first_breach_10pct": PR[k]["first_breach_10pct"],
                   "ratio_after_30d": round(PR[k]["after30"][0], 4), "ratio_after_180d_or_latest": round(PR[k]["after180"][0], 4), "source": PR[k]["url"]}

incidents = {
 "synthetic_dollar": [
  {"token": "UST", "date": "2022-05-09", "kind": "depeg", "size_usd": None, **pr("UST")},
  {"token": "sUSD", "date": "2025-04-10", "kind": "depeg", "size_usd": None, **pr("sUSD")},
  {"token": "USDX (Stables Labs)", "date": "2025-11-06", "kind": "depeg", "size_usd": None, **pr("USDX"),
   "also": news("Stables Labs USDX depeg")},
  {"token": "xUSD (Stream)", "date": "2025-11-04", "kind": "loss to lenders", "size_usd": 93e6, "low_vs_pre": -0.77,
   "morpho_unrealised_bad_debt_usd": 143517747, "source": news("Stream Finance xUSD 93 million"), "morpho_source": MORPHO,
   "note": "size is the fund loss disclosed by Stream; 77% fall is headline-level"},
  {"token": "deUSD / sdeUSD (Elixir)", "date": "2025-11-06", "kind": "loss to lenders", "size_usd": None,
   "morpho_unrealised_bad_debt_usd": 45559674 + 1367577, "sdeUSD_price_now": 1.07e-8,
   "source": MORPHO, "price_source": "https://coins.llama.fi/prices/current/ethereum:0x5C5b196aBE0d54485975D1Ec29617D42D9198326"},
  {"token": "USR (Resolv)", "date": "2026-03-22", "kind": "exploit, loss to lenders", "size_usd": 24.5e6, **pr("USR"),
   "intraday_low": 0.0025, "hack_source": HACKS, "detail_source": "https://www.halborn.com/blog/post/explained-the-resolv-hack-march-2026"}],
 "synthetic_dollar_borderline": [{"token": "USD0++", "date": "2025-01-20", "kind": "depeg under 10% (daily)", **pr("USD0++")}],
 "lst_lrt": [
  {"token": "aBNBc (Ankr)", "date": "2022-12-02", "kind": "unbacked mint", "size_usd": 5e6, "low_vs_pre": None, "source": HACKS,
   "note": "price drawdown not fetched"},
  {"token": "rsETH (Kelp)", "date": "2026-04-18", "kind": "bridge exploit, loss to lenders covered by coalition", "size_usd": 293e6, **pr("rsETH"),
   "hack_source": HACKS, "aave_report": "https://governance.aave.com/t/rseth-incident-report-april-20-2026/24580"}],
 "lst_lrt_borderline": [{"token": "ezETH", "date": "2024-04-24", "kind": "hours-long depeg, liquidations", **pr("ezETH")},
                        {"token": "stETH", "date": "2022-06-18", "kind": "discount under 10%", **pr("stETH")}],
 "rwa_credit": [
  {"token": "Maple pools (Orthogonal Trading)", "date": "2022-12-05", "kind": "loan default, loss to lenders", "size_usd": 36e6,
   "source": news("Maple Finance Orthogonal Trading default"), "note": "headline-level; recovery not confirmed"},
  {"token": "Goldfinch pool", "date": "2023-08-12", "kind": "loan default", "size_usd": 5e6, "source": news("Goldfinch loan default writedown"),
   "note": "headline-level"},
  {"token": "USDR (Tangible)", "date": "2023-10-11", "kind": "depeg", "size_usd": None, **pr("USDR"), "also": news("Tangible USDR depeg")}],
 "wrapped_btc": [
  {"token": "multiBTC (Multichain)", "date": "2023-07-07", "kind": "bridge collapse", "size_usd": 126e6, "low_vs_pre": None, "source": HACKS,
   "note": "size is the whole Multichain loss; multiBTC drawdown not fetched"},
  {"token": "uniBTC (Bedrock)", "date": "2024-09-26", "kind": "exploit, depeg", "size_usd": 2e6, **pr("uniBTC"), "hack_source": HACKS}],
 "wrapped_btc_borderline": [{"token": "renBTC", "date": "2022-12", "kind": "unconfirmed: DefiLlama shows -6.6% to Jun 2023 but 81% below WBTC today",
                             "source": "https://coins.llama.fi/prices/current/coingecko:renbtc,coingecko:wrapped-bitcoin"}],
 "curator_vault": [
  {"event": "Stream/Elixir", "date": "2025-11-04", "vaults_hit": None, "counted_as": 3, "source": MORPHO, "also": news("MEV Capital xUSD loss vault")},
  {"event": "Resolv USR", "date": "2026-03-22", "vaults_hit": 15, "source": "https://www.halborn.com/blog/post/explained-the-resolv-hack-march-2026"}],
 "pendle_pt": [{"token": "PT-RLP-9APR2026", "date": "2026-03-22", "kind": "underlying failure", "morpho_unrealised_bad_debt_usd": 17672079, "source": MORPHO}],
}

ORACLES = [
 dict(market="wstETH/WETH", kind="exchange_rate", depeg_triggers_liquidation=False,
      feeds={"BASE_FEED_1": {"address": "0x026864Bee872E81A205fEb21266991c2890926e6", "description": "Chronicle WSTETH/STETH (wat())"}},
      assumed_fixed=["stETH = ETH"], note="Market discount of wstETH or stETH to ETH is invisible. Only a fall in the reported stETH-per-wstETH rate moves it."),
 dict(market="aHYPER/USDC", kind="vault_share_price", depeg_triggers_liquidation=False,
      feeds={"BASE_VAULT": {"address": "0x7Cd231120a60F500887444a9bAF5e1BD753A5e59", "description": "Hyperithm Delta Neutral Vault convertToAssets"}},
      assumed_fixed=["USDC = 1"], note="totalAssets() reads 64,443.8 USDC against 83.8M shares at share price 1.0803, so the price is a vault-reported figure, not onchain balances (inference)."),
 dict(market="PT-USDat-14JAN2027/USDC", kind="market_price_twap_pt_vs_underlying", depeg_triggers_liquidation="PT selloff yes (15 min TWAP); USDat depeg no",
      feeds={"meta_oracle": "0x597921a5b5aD74A0Bf573fD7B58F80c383DCdAB2", "primary": "0x67cD0fc83D3Eb39808BD3e686d18324Dd269ED6C",
             "backup": "0x313C14e7262B59A9366B59692A4e0b140427a723",
             "BASE_FEED_1": {"address": "0x5346c2C152e471Daad390224491Acd8f6B860977", "description": "Pendle Chainlink-compatible Oracle",
                             "market": "0x88C5D8A908834E44B421CB67aEc9A931782f9538", "twapDuration": 900, "baseOracleType": 1}},
      assumed_fixed=["USDat = USDC"], params={"deviationThreshold": 0.01, "challengeTimelock_s": 14400, "healingTimelock_s": 43200},
      note="Backup is an owner-settable wrapper that today points at the primary; owner 0x9BEc4DbAdE98251CC20d3C15C27bfdaA45434d4A can repoint it."),
 dict(market="earnAUSD/USDC", kind="vault_share_price_operator_reported", depeg_triggers_liquidation=False,
      feeds={"BASE_FEED_1": {"address": "0xf43D69D8e46B8fD2EB8940283657750BB3d88Cb0", "description": "earnAUSD Share Price Oracle",
                             "VAULT": "0x36eDbF0C834591BFdfCaC0Ef9605528c75c406aA"}},
      assumed_fixed=["AUSD = USDC"], params={"externalAssets_share": round(24990739327413 / 25331740719115, 4), "maxChangePercent_raw": 3, "lagDuration_s": 259200},
      note="Vault exposes updateTotalAssets(); 98.7% of assets sit outside the vault. Units of maxChangePercent not confirmed."),
 dict(market="strUSD/AUSD", kind="exchange_rate_over_market_quote", depeg_triggers_liquidation=False,
      feeds={"BASE_FEED_1": {"address": "0xb81131B6368b3F0a83af09dB4E39Ac23DA96C2Db", "description": "RedStone Price Feed for strUSD_FUNDAMENTAL"},
             "QUOTE_FEED_1": {"address": "0xE20751C7B5867bCBef815ffc1b284c3f412a9e13", "description": "AUSD / USD"}},
      assumed_fixed=[], note="strUSD market price invisible. An AUSD fall raises collateral value in AUSD terms, so it never triggers liquidations either."),
 dict(market="mROX/AUSD", kind="issuer_nav_push", depeg_triggers_liquidation=False,
      feeds={"BASE_FEED_1": {"address": "0x47b301D6Fe113F97376B82D41E5CD1Ea79a8F6C4", "description": "mROX/USD (Midas custom aggregator)"}},
      assumed_fixed=["AUSD = 1 USD"], params={"maxAnswerDeviation_raw": 31000000, "last_update_unix": 1790950453},
      note="Feed admin calls setRoundData. Last update about 4 days before the read. Deviation units not confirmed."),
 dict(market="mHyperBTC/cbBTC", kind="issuer_nav_push", depeg_triggers_liquidation=False,
      feeds={"BASE_FEED_1": {"address": "0x165d2E3C0A368988F497F649B6fe2134bE20FD8c", "description": "mHyperBTC/BTC (Midas custom aggregator)"}},
      assumed_fixed=["cbBTC = BTC"], params={"maxAnswerDeviation_raw": 20000000, "last_update_unix": 1791276974}),
 dict(market="PT-AUSD-8OCT2026/USDC", kind="market_price_twap_pt_vs_underlying", depeg_triggers_liquidation="PT selloff yes (15 min TWAP); AUSD depeg no",
      feeds={"BASE_FEED_1": {"address": "0x85656e850e7A74Fd9945f948233fB2E4EBAaB420", "description": "Pendle Chainlink-compatible Oracle",
                             "market": "0x6f99CF00ee7290aE78a072Bb6910eF72D1129fE7", "twapDuration": 900, "baseOracleType": 1}},
      assumed_fixed=["AUSD = USDC"], note="Matures 8 Oct 2026."),
]
for o, m in zip(ORACLES, M):
    assert o["market"] == f'{m["collateralAsset"]["symbol"]}/{m["loanAsset"]["symbol"]}'
    o.update(marketId=m["marketId"], oracle=m["oracleAddress"], lltv=int(m["lltv"]) / 1e18,
             borrow_usd=round(m["state"]["borrowAssetsUsd"]), collateral_usd=round(m["state"]["collateralAssetsUsd"]),
             oracle_price_raw=m["state"]["price"])

best = collections.defaultdict(dict)
for r in Q:
    k = (r["sym"], r["size_usd"])
    if r["vs_ref"] is not None and (k not in best or r["vs_ref"] > best[k]["vs_ref"]):
        best[k] = dict(vs_ref=round(r["vs_ref"], 4), venue=r["agg"], out_sym=r["out_sym"], ref_source=r["ref_source"])
for r in PQ:
    k = (r["s"], int(r["usd"]))
    if r["vs_oracle"] is not None and (k not in best or not best[k] or r["vs_oracle"] > best[k]["vs_ref"]):
        best[k] = dict(vs_ref=round(r["vs_oracle"], 4), venue="pendle_api(" + str(r["agg"]).lower() + ")", out_sym="USDC", ref_source="morpho_oracle_price")
syms = list(dict.fromkeys(r["sym"] for r in Q))
exit_q = {s: {str(z): (best.get((s, z)) or None) for z in [1000, 100000, 1000000, 10000000]} for s in syms}

cfg = {
 "generated": "2026-10-06", "monad_block_for_oracle_reads": 111062289, "chain_id": 143,
 "definitions": {"failure": "sustained depeg beyond 10% or a loss passed to lenders", "window": "2022-01-01 to 2026-10-06",
                 "token_years": "years each material token (DefiLlama TVL >= $50M today, plus failed tokens added back) was live in the window",
                 "range": "90% Poisson (Garwood) interval on the failure count", "quote_vs_ref": "output / (input x reference price) - 1"},
 "failure_frequency": {k: {kk: vv for kk, vv in v.items() if kk not in ("universe",)} for k, v in F.items()},
 "failure_frequency_alt": {"synthetic_dollar_narrow": {"universe": "DefiLlama Basis Trading >= $50M plus failed", "token_years": 25.2, "failures": 5,
                           "p_annual": 0.1987, "p_annual_90ci": [0.0783, 0.4178]}},
 "pendle_pt_rule": "p(PT) = p(underlying class) + pendle_pt_specific.p_annual_upper95 (upper bound)",
 "incidents": incidents,
 "oracles": ORACLES,
 "exit_liquidity": {
  "aggregators": {
   "kyberswap": {"public": True, "endpoint": "https://aggregator-api.kyberswap.com/monad/api/v1/routes"},
   "kuru_flow": {"public": True, "auth": "free JWT from POST https://ws.kuru.io/api/generate-token, 1 request/s", "endpoint": "https://ws.kuru.io/api/quote"},
   "monorail": {"public": True, "endpoint": "https://pathfinder.monorail.xyz/v4/quote"},
   "lifi": {"public": True, "endpoint": "https://li.quest/v1/quote", "note": "drops routes above 10% impact; same-chain routes go through KyberSwap"},
   "pendle_hosted_sdk": {"public": True, "endpoint": "https://api-v2.pendle.finance/core/v2/sdk/143/convert", "note": "only source that routes PTs through the Pendle AMM"},
   "0x": {"public": False, "reason": "No API key found in request"},
   "okx_dex": {"public": False, "reason": "OK-ACCESS-KEY header required"},
   "1inch": {"public": False, "reason": "Unauthorized"},
   "uniswap_trading_api": {"public": False, "reason": "empty response without API key"},
   "paraswap": {"public": False, "reason": "chain 143 not in supported networks"},
   "odos": {"public": None, "reason": "Cloudflare error 1033 from this network"},
   "openocean": {"public": None, "reason": "Cloudflare challenge page"}},
  "best_quote_vs_reference": exit_q,
  "cross_chain": {"USDe_1M_monad_to_ethereum_usde": {"tool": "glacis via LI.FI", "amount_in": 1000000, "amount_out": 997300.5, "vs_input_tokens": round(997300.5 / 1e6 - 1, 4), "est_seconds": 3, "source": "https://li.quest/v1/quote"},
                  "wstETH_300_monad_to_ethereum_weth": {"result": "no route on LI.FI"}},
 },
}
json.dump(cfg, open("research-config.json", "w"), indent=1)
for s in syms: print(s, {k: (v["vs_ref"], v["venue"]) if v else None for k, v in exit_q[s].items()})
