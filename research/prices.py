#!/usr/bin/env python3
"""Daily (or hourly) DefiLlama price history around each collateral incident.
Severity = lowest price relative to the reference asset; recovery = price
relative to reference 30 and 180 days after the low (or latest available)."""
import json, time, datetime, requests
def ts(d): return int(datetime.datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc).timestamp())
EVENTS = [  # name, coin, reference coin (None = $1), start, span, period, pre-incident ratio basis
 ("UST", "coingecko:terrausd", None, "2022-05-01", 200, "1d"),
 ("USDR", "coingecko:real-usd", None, "2023-10-01", 200, "1d"),
 ("sUSD", "coingecko:nusd", None, "2025-01-01", 300, "1d"),
 ("USD0++", "coingecko:usd0-liquid-bond", None, "2024-12-20", 150, "1d"),
 ("USDX", "coingecko:usdx-money-usdx", None, "2025-10-20", 200, "1d"),
 ("USR", "coingecko:resolv-usr", None, "2026-03-15", 200, "1d"),
 ("renBTC", "coingecko:renbtc", "coingecko:wrapped-bitcoin", "2022-11-01", 240, "1d"),
 ("stETH", "coingecko:staked-ether", "coingecko:ethereum", "2022-06-01", 60, "1d"),
 ("ezETH", "coingecko:renzo-restaked-eth", "coingecko:ethereum", "2024-04-22", 120, "1h"),
 ("rsETH", "coingecko:kelp-dao-restaked-eth", "coingecko:ethereum", "2026-04-05", 150, "1d"),
 ("uniBTC", "coingecko:universal-btc", "coingecko:wrapped-bitcoin", "2024-09-20", 30, "1d"),
]
out = {}
for name, coin, ref, start, span, period in EVENTS:
    coins = coin + ("," + ref if ref else "")
    url = f"https://coins.llama.fi/chart/{coins}?start={ts(start)}&span={span}&period={period}"
    for _ in range(4):
        j = requests.get(url, timeout=60).json()
        if "coins" in j and coin in j["coins"]: break
        time.sleep(5)
    else:
        print(name, "no data", str(j)[:150]); continue
    d = j["coins"]
    a = {p["timestamp"]: p["price"] for p in d[coin]["prices"]}
    b = {p["timestamp"]: p["price"] for p in d[ref]["prices"]} if ref else None
    series = []
    for t in sorted(a):
        if b is None: series.append((t, a[t]))
        else:
            near = min(b, key=lambda x: abs(x - t))
            if abs(near - t) < 7200: series.append((t, a[t] / b[near]))
    base = series[0][1]
    lo_t, lo = min(series, key=lambda x: x[1])
    breach = next((t for t, v in series if v / base < 0.9), None)  # first point more than 10% below start
    def at(days):
        tgt = lo_t + days * 86400
        c = [s for s in series if s[0] >= tgt]
        return (c[0][1], "exact") if c else (series[-1][1], "latest")
    r30, r180 = at(30), at(180)
    out[name] = dict(url=url, start_ratio=base, low=lo, low_date=str(datetime.datetime.fromtimestamp(lo_t, datetime.timezone.utc).date()),
                     drawdown=lo / base - 1, first_breach_10pct=None if breach is None else str(datetime.datetime.fromtimestamp(breach, datetime.timezone.utc).date()), after30=r30, after180=r180, last=series[-1][1],
                     last_date=str(datetime.datetime.fromtimestamp(series[-1][0], datetime.timezone.utc).date()))
    print(f"{name:7s} base {base:.4f} low {lo:.4f} on {out[name]['low_date']} dd {lo/base-1:+.1%} +30d {r30[0]:.4f} +180d {r180[0]:.4f}({r180[1]}) last {series[-1][1]:.4f} {out[name]['last_date']} breach {out[name]['first_breach_10pct']}")
    time.sleep(1)
json.dump(out, open("incident_prices.json", "w"), indent=1)
