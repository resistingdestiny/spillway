#!/usr/bin/env python3
"""Exit-liquidity quotes on Monad (chain 143).

Sells each collateral token into its loan asset at $1k, $100k, $1M and $10M
through every aggregator that answers without an API key, and records the
output against a reference price. For the eight Morpho markets the reference
is the market's own oracle price (Morpho API `state.price`), so the gap is the
discount a liquidator would face relative to what the market believes the
collateral is worth. For the extra tokens it is the Morpho API USD price ratio.

Usage: python3 quotes.py <kyber|lifi|monorail|kuru>  (appends to quotes.jsonl)
"""
import json, sys, time
from decimal import Decimal
import requests

DEAD = "0x000000000000000000000000000000000000dEaD"
SIZES_USD = [1_000, 100_000, 1_000_000, 10_000_000]

USDC = ("USDC", "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", 6)
AUSD = ("AUSD", "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", 6)
WETH = ("WETH", "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242", 18)
CBBTC = ("cbBTC", "0xd18B7EC58Cdf4876f6AFebd3Ed1730e4Ce10414b", 8)

markets = json.load(open("markets_raw.json"))["data"]["markets"]["items"][:8]
assets = {a["address"].lower(): a for a in json.load(open("assets143.json"))["data"]["assets"]["items"]}

PAIRS = []
for m in markets:
    c, l = m["collateralAsset"], m["loanAsset"]
    # Oracle price: loan raw units per collateral raw unit, scaled by 1e36.
    PAIRS.append(dict(sym=c["symbol"], token=c["address"], dec=c["decimals"], usd=c["priceUsd"],
                      out_sym=l["symbol"], out=l["address"], out_dec=l["decimals"],
                      ref_raw_per_raw=str(Decimal(m["state"]["price"]) / Decimal(10) ** 36),
                      ref_source="morpho_oracle_price", market=m["marketId"]))

def extra(sym, addr, dec, loan):
    a, l = assets[addr.lower()], assets[loan[1].lower()]
    ratio = Decimal(str(a["priceUsd"])) / Decimal(str(l["priceUsd"]))
    PAIRS.append(dict(sym=sym, token=addr, dec=dec, usd=a["priceUsd"], out_sym=loan[0], out=loan[1],
                      out_dec=loan[2], ref_raw_per_raw=str(ratio * Decimal(10) ** (loan[2] - dec)),
                      ref_source="morpho_api_priceUsd_ratio", market=None))

extra("syrupUSDC", "0xaB6e5a0C3799d020c790D34F7B2C02639e238AF7", 6, USDC)
extra("USDe", "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", 18, USDC)
extra("vUSD", "0x8d3F9f9Eb2f5E8B48EFBB4074440D1E2A34Bc365", 6, USDC)
extra("wsrUSD", "0x4809010926aec940b550D34a46A52739f996D75D", 18, USDC)
extra("savUSD", "0x9648dB94F1e6B19e7D755585542981F97dc806c6", 18, AUSD)

S = requests.Session()

def kyber(p, amt):
    r = S.get("https://aggregator-api.kyberswap.com/monad/api/v1/routes",
              params=dict(tokenIn=p["token"], tokenOut=p["out"], amountIn=str(amt)),
              headers={"x-client-id": "spillway"}, timeout=30).json()
    if r.get("code") != 0:
        return None, r.get("message")
    return int(r["data"]["routeSummary"]["amountOut"]), None

def lifi(p, amt):
    r = S.get("https://li.quest/v1/quote", params=dict(
        fromChain=143, toChain=143, fromToken=p["token"], toToken=p["out"], fromAmount=str(amt),
        fromAddress=DEAD, maxPriceImpact=0.99, slippage=0.05), timeout=60).json()
    if "estimate" not in r:
        errs = r.get("errors", {})
        why = [f.get("reason") for f in errs.get("filteredOut", [])] + \
              [s.get("message") for f in errs.get("failed", []) for v in f.get("subpaths", {}).values() for s in v]
        return None, (r.get("message"), why[:3])
    return int(r["estimate"]["toAmount"]), r["toolDetails"]["key"] if "toolDetails" in r else None

def monorail(p, amt):
    human = str(Decimal(amt) / Decimal(10) ** p["dec"])
    r = S.get("https://pathfinder.monorail.xyz/v4/quote",
              params={"source": "spillway", "from": p["token"], "to": p["out"], "amount": human}, timeout=30).json()
    if "output" not in r:
        return None, r
    return int(r["output"]), r.get("compound_impact")

KURU_T = None
def kuru(p, amt):
    global KURU_T
    if KURU_T is None:
        KURU_T = S.post("https://ws.kuru.io/api/generate-token", json={"user_address": DEAD}, timeout=30).json()["token"]
    time.sleep(1.2)  # token is limited to 1 request per second
    r = S.post("https://ws.kuru.io/api/quote", headers={"Authorization": f"Bearer {KURU_T}"}, timeout=60, json=dict(
        userAddress=DEAD, tokenIn=p["token"], tokenOut=p["out"], amount=str(amt), slippageTolerance=50, autoSlippage=False)).json()
    if r.get("status") != "success":
        return None, r
    return int(r["output"]), None

AGG = dict(kyber=kyber, lifi=lifi, monorail=monorail, kuru=kuru)

if __name__ == "__main__":
    name = sys.argv[1]
    only = sys.argv[2:]  # optional symbol filter
    with open("quotes.jsonl", "a") as f:
        for p in PAIRS:
            if only and p["sym"] not in only:
                continue
            for usd in SIZES_USD:
                amt = int(Decimal(usd) / Decimal(str(p["usd"])) * Decimal(10) ** p["dec"])
                ref = Decimal(amt) * Decimal(p["ref_raw_per_raw"])
                try:
                    out, note = AGG[name](p, amt)
                except Exception as e:  # network or schema errors are recorded, not fatal
                    out, note = None, repr(e)[:200]
                gap = None if out is None else float(Decimal(out) / ref - 1)
                rec = dict(agg=name, sym=p["sym"], out_sym=p["out_sym"], size_usd=usd, amount_in=str(amt),
                           amount_out=None if out is None else str(out), ref_out=str(int(ref)),
                           vs_ref=gap, note=note, ref_source=p["ref_source"], ts=int(time.time()))
                f.write(json.dumps(rec, default=str) + "\n"); f.flush()
                print(name, p["sym"], usd, "out" if out else "NONE", None if gap is None else f"{gap:+.4%}", str(note)[:120])
                time.sleep(0.4)
