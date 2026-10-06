// Snapshot every Morpho Blue market and position on Monad, from Morpho's public API, with the Monad
// block at which it was taken. The first step towards stress testing Monad lending.
//
//   tsx scripts/snapshot-morpho.ts [--out fixtures/morpho/monad-<date>.json]
//
// The API reflects its latest indexed state, so the file records the RPC block read just before and
// just after the pull. Positions can be re-read on chain at that block to reconcile.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://blue-api.morpho.org/graphql";
const RPC = "https://rpc.monad.xyz";
const CHAIN_ID = 143;
const here = dirname(fileURLToPath(import.meta.url));

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (res.ok && body.data && !body.errors) return body.data;
    if (attempt >= 4) throw new Error(body.errors?.[0]?.message ?? `HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}

async function block(): Promise<{ number: number; timestamp: number }> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
  });
  const { result } = (await res.json()) as { result: { number: string; timestamp: string } };
  return { number: Number(result.number), timestamp: Number(result.timestamp) };
}

const ASSET = "address symbol decimals priceUsd";

const MARKETS = `query($skip: Int!) {
  markets(first: 100, skip: $skip, where: { chainId_in: [${CHAIN_ID}] }) {
    pageInfo { count countTotal }
    items {
      marketId lltv listed irmAddress
      oracle { address type }
      collateralAsset { ${ASSET} }
      loanAsset { ${ASSET} }
      state { supplyAssets supplyShares borrowAssets borrowShares collateralAssets supplyAssetsUsd borrowAssetsUsd collateralAssetsUsd utilization price timestamp }
      badDebt { underlying usd }
      realizedBadDebt { underlying usd }
      warnings { type level }
      supplyingVaultV2s { address name curators { items { name } } }
    }
  }
}`;

const POSITIONS = `query($skip: Int!) {
  marketPositions(first: 300, skip: $skip, where: { chainId_in: [${CHAIN_ID}] }) {
    pageInfo { count countTotal }
    items {
      user { address }
      market { marketId }
      healthFactor
      priceVariationToLiquidationPrice
      state { collateral collateralUsd borrowAssets borrowAssetsUsd borrowShares supplyAssets supplyAssetsUsd supplyShares }
    }
  }
}`;

type Page<T> = { pageInfo: { count: number; countTotal: number }; items: T[] };

async function all<T>(query: string, key: string): Promise<T[]> {
  const out: T[] = [];
  for (let skip = 0; ; ) {
    const data = await gql<Record<string, Page<T>>>(query, { skip });
    const page = data[key] as Page<T>;
    out.push(...page.items);
    skip += page.items.length;
    if (page.items.length === 0 || skip >= page.pageInfo.countTotal) break;
  }
  return out;
}

const before = await block();
const markets = await all<Record<string, unknown>>(MARKETS, "markets");
const rawPositions = await all<{ state: Record<string, string | number | null> } & Record<string, unknown>>(POSITIONS, "marketPositions");
const after = await block();

// Keep positions that hold anything.
const positions = rawPositions.filter((p) => {
  const s = p.state ?? {};
  return [s.collateral, s.borrowShares, s.supplyShares].some((v) => v !== null && v !== undefined && String(v) !== "0");
});

const body = {
  schema: "spillway.morpho-snapshot/1",
  chainId: CHAIN_ID,
  source: { api: API, rpc: RPC },
  takenAt: new Date().toISOString(),
  blockBefore: before,
  blockAfter: after,
  counts: { markets: markets.length, positions: positions.length },
  markets,
  positions,
};
const text = JSON.stringify(body);
const hash = createHash("sha256").update(text).digest("hex");
const out =
  process.argv.includes("--out") ? (process.argv[process.argv.indexOf("--out") + 1] as string) : join(here, "..", "..", "fixtures", "morpho", `monad-${body.takenAt.slice(0, 10)}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ ...body, sha256OfBody: hash }, null, 0)}\n`);
console.log(`${out}: ${markets.length} markets, ${positions.length} positions, blocks ${before.number} to ${after.number}, sha256 ${hash.slice(0, 16)}`);
