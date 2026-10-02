// Fetch the price history the engine needs, once, and save it under engine/data.
//
//   - BTC-USD daily candles since 2016, for the Monte Carlo's daily moves.
//   - BTC-USD hourly candles since 2016, reduced to each day's worst one-hour fall and rise, so the
//     Monte Carlo samples fast moves rather than whole-day drifts.
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

const daily = process.argv.includes("--hourly-only") ? [] : await candles(86_400, new Date("2016-01-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
if (daily.length) writeFileSync(
  out("btc-usd-daily.json"),
  JSON.stringify({ source: "Coinbase Exchange, BTC-USD daily candles", fetchedAt, columns: ["unix", "open", "high", "low", "close"], rows: daily }) + "\n",
);
if (daily.length) console.log(`daily: ${daily.length} days, ${new Date(daily[0]![0] * 1000).toISOString().slice(0, 10)} to ${new Date(daily.at(-1)![0] * 1000).toISOString().slice(0, 10)}`);

// Hourly candles are too many to commit, so keep each day's worst hour only.
const onlyHourly = process.argv.includes("--hourly-only");
const hourly = await candles(3_600, new Date("2016-01-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"));
const byDay = new Map<string, { down: number; up: number; hours: number }>();
for (const [t, open, high, low] of hourly) {
  const day = new Date(t * 1000).toISOString().slice(0, 10);
  const d = byDay.get(day) ?? { down: 0, up: 0, hours: 0 };
  d.down = Math.max(d.down, open > 0 ? 1 - low / open : 0);
  d.up = Math.max(d.up, open > 0 ? high / open - 1 : 0);
  d.hours += 1;
  byDay.set(day, d);
}
const worstHour = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
writeFileSync(
  out("btc-usd-worst-hour.json"),
  JSON.stringify({
    source: "Coinbase Exchange, BTC-USD hourly candles, reduced to each UTC day's largest open-to-low fall and open-to-high rise within one hour",
    fetchedAt,
    columns: ["day", "down", "up", "hours"],
    rows: worstHour.map(([day, d]) => [day, Number(d.down.toFixed(6)), Number(d.up.toFixed(6)), d.hours]),
  }) + "\n",
);
console.log(`worst hour: ${worstHour.length} days from ${hourly.length} hourly candles`);
if (onlyHourly) process.exit(0);

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
