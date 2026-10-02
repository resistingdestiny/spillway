// Fetch the price history the engine needs, once, and save it under engine/data.
//
//   - BTC-USD daily candles since 2016, for the Monte Carlo's daily moves.
//   - BTC-USD one-minute candles around the 10 October 2025 crash, for the replay.
//
// Source: Coinbase Exchange public candles API (no key). Run: pnpm --filter @spillway/engine fetch-history

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.exchange.coinbase.com/products/BTC-USD/candles";
const here = dirname(fileURLToPath(import.meta.url));
const out = (name: string) => join(here, "..", "data", name);

type Row = [number, number, number, number, number]; // unix, open, high, low, close

async function candles(granularity: number, start: Date, end: Date): Promise<Row[]> {
  const rows = new Map<number, Row>();
  const span = granularity * 300 * 1000;
  for (let from = start.getTime(); from < end.getTime(); from += span) {
    const to = Math.min(from + span, end.getTime());
    const url = `${API}?granularity=${granularity}&start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { "User-Agent": "spillway-engine" } });
      if (res.ok) {
        // Coinbase rows: [time, low, high, open, close, volume], newest first.
        const data = (await res.json()) as number[][];
        for (const [t, low, high, open, close] of data as [number, number, number, number, number][]) {
          if (t * 1000 >= from && t * 1000 < to) rows.set(t, [t, open, high, low, close]);
        }
        break;
      }
      if (attempt >= 4) throw new Error(`${res.status} ${await res.text()}`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return [...rows.values()].sort((a, b) => a[0] - b[0]);
}

const fetchedAt = new Date().toISOString();

const daily = await candles(86_400, new Date("2016-01-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
writeFileSync(
  out("btc-usd-daily.json"),
  JSON.stringify({ source: "Coinbase Exchange, BTC-USD daily candles", fetchedAt, columns: ["unix", "open", "high", "low", "close"], rows: daily }) + "\n",
);
console.log(`daily: ${daily.length} days, ${new Date(daily[0]![0] * 1000).toISOString().slice(0, 10)} to ${new Date(daily.at(-1)![0] * 1000).toISOString().slice(0, 10)}`);

const crash = await candles(60, new Date("2025-10-10T20:00:00Z"), new Date("2025-10-10T22:30:00Z"));
writeFileSync(
  out("replay-2025-10-10.json"),
  JSON.stringify(
    {
      label: "10 October 2025",
      source: "Coinbase Exchange, BTC-USD one-minute candles, 20:00 to 22:30 UTC",
      fetchedAt,
      t: crash.map((r) => r[0]),
      candles: crash.map(([, open, high, low, close]) => ({ open, high, low, close })),
    },
    null,
    0,
  ) + "\n",
);
const low = Math.min(...crash.map((r) => r[3]));
console.log(`replay: ${crash.length} minutes, open ${crash[0]![1]}, low ${low}, drawdown ${((1 - low / crash[0]![1]) * 100).toFixed(2)}%`);
