#!/usr/bin/env python3
"""Annual collateral failure probability per class, 2022-01-01 to 2026-10-06.

Failure = sustained depeg beyond 10%, or a loss passed to lenders/holders.
Exposure = token-years: for each material token, years between
max(DefiLlama listedAt, 2022-01-01) and the failure date or today.
Universe = DefiLlama protocols (api.llama.fi/protocols) in the listed
categories with TVL >= $50M today, plus the failed tokens that have since
shrunk below the threshold (added back to limit survivorship bias).
Range = 90% Poisson interval on the failure count (Garwood), divided by
token-years. Borderline events give a second, higher point estimate.
"""
import json, math, datetime

T0 = datetime.datetime(2022, 1, 1, tzinfo=datetime.timezone.utc).timestamp()
NOW = datetime.datetime(2026, 10, 6, tzinfo=datetime.timezone.utc).timestamp()
YEAR = 365.25 * 86400
P = {p["name"]: p for p in json.load(open("protocols.json"))}

def d(s): return datetime.datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc).timestamp()

def years(name, end=None):
    start = max(P[name].get("listedAt") or T0, T0) if name in P else T0
    return max(0.0, ((end or NOW) - start) / YEAR)

def universe(cats, min_tvl=50e6, name_filter=None):
    return [n for n, p in P.items() if p.get("category") in cats and (p.get("tvl") or 0) >= min_tvl
            and (name_filter is None or name_filter(n))]

def poisson_cdf(k, mu):
    return sum(math.exp(-mu) * mu ** i / math.factorial(i) for i in range(k + 1))

def garwood(k, conf=0.90):
    a = (1 - conf) / 2
    def solve(f):
        lo, hi = 0.0, 100.0
        for _ in range(200):
            m = (lo + hi) / 2
            lo, hi = (m, hi) if f(m) else (lo, m)
        return (lo + hi) / 2
    lower = 0.0 if k == 0 else solve(lambda mu: 1 - poisson_cdf(k - 1, mu) < a)
    upper = solve(lambda mu: poisson_cdf(k, mu) > a)
    return lower, upper

# (class, survivor universe, added-back failed tokens {name: end date}, failures, borderline)
CLASSES = {
 "synthetic_dollar": dict(
    universe=universe({"Basis Trading", "CDP", "Dual-Token Stablecoin"}),
    added={"Terra": "2022-05-09", "Resolv USR": "2026-03-22", "Stream Finance": "2025-11-04",
           "Elixir": "2025-11-06", "Stables Labs USDX": "2025-11-06", "Synthetix v1+v2": None, "Level": None},
    failures=["UST", "sUSD", "USDX", "xUSD", "deUSD", "USR"], borderline=["USD0++"]),
 "lst_lrt": dict(
    universe=universe({"Liquid Staking", "Liquid Restaking"}),
    added={"Ankr": None}, failures=["aBNBc", "rsETH"], borderline=["ezETH"]),
 "rwa_credit": dict(
    universe=universe({"RWA"}) + ["Maple"],
    added={"Goldfinch": None, "TrueFi": None, "Clearpool Lending": None, "Centrifuge Protocol": None, "Tangible RWA": None},
    failures=["Maple/Orthogonal", "Goldfinch 2023 default", "USDR"], borderline=["TrueFi defaults (unconfirmed)"]),
 "wrapped_btc": dict(
    universe=universe({"Bridge", "Anchor BTC", "Decentralized BTC", "Restaked BTC"},
                      name_filter=lambda n: "btc" in n.lower() or "bitcoin" in n.lower()) + ["WBTC"],
    added={"RenVM": "2022-12-20", "Multichain": "2023-07-07"},
    failures=["multiBTC", "uniBTC"], borderline=["renBTC (unconfirmed)"]),
}

out = {}
for cls, c in CLASSES.items():
    names = sorted(set(c["universe"]))
    ty = sum(years(n) for n in names) + sum(years(n, d(e) if e else None) for n, e in c["added"].items() if n not in names)
    k, kb = len(c["failures"]), len(c["failures"]) + len(c["borderline"])
    lo, hi = garwood(k)
    out[cls] = dict(tokens=len(names) + len([n for n in c["added"] if n not in names]), token_years=round(ty, 1),
                    failures=k, failures_incl_borderline=kb, p_annual=round(k / ty, 4),
                    p_annual_90ci=[round(lo / ty, 4), round(hi / ty, 4)], p_annual_incl_borderline=round(kb / ty, 4),
                    universe=names, added_back=list(c["added"]))
    print(f"{cls:17s} tokens {out[cls]['tokens']:3d} token-years {ty:6.1f} failures {k} (+{kb-k}) "
          f"p {k/ty:.2%} [{lo/ty:.2%}, {hi/ty:.2%}] incl borderline {kb/ty:.2%}")

# Curator vaults: Morpho vaults (V1 + V2) above $1M today, years since creation.
# Resolv: 15 Morpho vaults hit (Halborn). Stream/Elixir: per-vault count not
# confirmed; the three Morpho markets that still carry unrealised bad debt
# (xUSD, sdeUSD, deUSD) are counted as one vault each, a floor.
V = json.load(open("morpho_vaults_1m.json"))["data"]
ts = [v["creationTimestamp"] for v in V["vaults"]["items"] + V["vaultV2s"]["items"]]
vy = sum((NOW - max(t, T0)) / YEAR for t in ts)
k = 15 + 3
lo, hi = garwood(k)
out["curator_vault"] = dict(tokens=len(ts), token_years=round(vy, 1), failures=k, p_annual=round(k / vy, 4),
                            p_annual_90ci=[round(lo / vy, 4), round(hi / vy, 4)],
                            note="survivor-only denominator (vaults above $1M today); failures include vaults since shrunk, so the rate is biased high")
print(f"curator_vault     vaults {len(ts)} vault-years {vy:.1f} failures {k} p {k/vy:.2%} [{lo/vy:.2%}, {hi/vy:.2%}]")

# Pendle PTs: no PT-specific failure found; every PT loss traced to its
# underlying. Upper bound by the rule of three over an assumed exposure of
# 451 expired Ethereum markets x 0.5 years average life (assumption).
pt_years = 451 * 0.5
out["pendle_pt_specific"] = dict(failures=0, token_years_assumed=pt_years, p_annual_upper95=round(3 / pt_years, 4),
                                 note="PT risk = underlying class probability + this PT-specific term")
print(f"pendle_pt_specific upper95 {3/pt_years:.2%} over assumed {pt_years} PT-years")
json.dump(out, open("frequencies.json", "w"), indent=1)
