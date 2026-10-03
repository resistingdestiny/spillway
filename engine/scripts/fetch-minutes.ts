// Each stressed day's worst one-minute BTC move, from Coinbase one-minute candles.
//
// Perpl refuses to liquidate while its on-chain spot price is older than 60 seconds (BTC
// refPriceMaxAgeSec). If the oracle or the chain stalls during a fall, liquidations pause and the
// price gaps. The worst one-minute move of a day is the gap such a pause would leave.
// Only days whose worst hour moved 3% or more are fetched; on calmer days no minute can have moved
// more than that hour did.
//
//   tsx scripts/fetch-minutes.ts

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const data = (name: string) => join(here, "..", "data", name);
const API = "https://api.exchange.coinbase.com/products/BTC-USD/candles";
const THRESHOLD = 0.03;

const hours = JSON.parse(readFileSync(data("btc-usd-worst-hour.json"), "utf8")) as { rows: [string, number, number, number][] };
const days = hours.rows.filter(([, down, up]) => down >= THRESHOLD || up >= THRESHOLD).map(([day]) => day);
console.log(`${days.length} stressed days`);

async function get(url: string): Promise<number[][]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": "spillway-engine" } });
    if (res.ok) return (await res.json()) as number[][];
    if (attempt >= 5) throw new Error(`${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
}

const rows: [string, number, number, number][] = [];
for (const [i, day] of days.entries()) {
  const start = Date.parse(`${day}T00:00:00Z`);
  let down = 0;
  let up = 0;
  let minutes = 0;
  for (let from = start; from < start + 86_400_000; from += 300 * 60_000) {
    const to = Math.min(from + 300 * 60_000, start + 86_400_000);
    const candles = await get(`${API}?granularity=60&start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}`);
    // Coinbase rows: [time, low, high, open, close, volume].
    for (const [t, low, high, open] of candles as [number, number, number, number][]) {
      if (t * 1000 < from || t * 1000 >= to || open <= 0) continue;
      down = Math.max(down, 1 - low / open);
      up = Math.max(up, high / open - 1);
      minutes++;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  rows.push([day, Number(down.toFixed(6)), Number(up.toFixed(6)), minutes]);
  if (i % 25 === 0) console.log(`${i + 1}/${days.length} ${day} down ${(down * 100).toFixed(2)}%`);
}

writeFileSync(
  data("btc-usd-worst-minute.json"),
  JSON.stringify({
    source: `Coinbase Exchange, BTC-USD one-minute candles, each UTC day's largest open-to-low fall and open-to-high rise within one minute, for days whose worst hour moved ${THRESHOLD * 100}% or more`,
    fetchedAt: new Date().toISOString(),
    threshold: THRESHOLD,
    columns: ["day", "down", "up", "minutes"],
    rows,
  }) + "\n",
);
console.log(`done: ${rows.length} days`);
