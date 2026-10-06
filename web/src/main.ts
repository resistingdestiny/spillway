import { type Bundle, type Ledge, type RunResult, type Snapshot, gap, ledges as groupLedges, scaleOpenInterest } from "@spillway/engine";
import { MAX_MOVE, layout } from "./layout.js";
import { renderOverlay, usd, usdShort } from "./overlay.js";
import { COLORS, Picture, type Scene } from "./picture.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function load<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

const [today, bundle] = await Promise.all([load<Snapshot>("data/snapshot.json"), load<Bundle>("data/bundle.json")]);
const cfg = bundle.config;
const m = today.market;

// Review-only: scale today's open interest to see when the layer starts to matter.
let k = Number(new URLSearchParams(location.search).get("oi") ?? 1) || 1;
let snapshot: Snapshot = today;
let ledges: Ledge[] = [];
let ledgeOf = new Map<number, number>();
let biggest = 0;
function useScale(next: number): void {
  k = next;
  snapshot = scaleOpenInterest(today, k);
  ledges = groupLedges(snapshot, cfg, { side: "long" });
  ledgeOf = new Map();
  ledges.forEach((l, i) => l.accountIds.forEach((id) => ledgeOf.set(id, i)));
  biggest = Math.max(0, ...ledges.map((l) => l.notional));
  document.querySelectorAll<HTMLButtonElement>("#scenario button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.k) === k)));
}
useScale(k);

$("market").textContent = `${m.symbol} on Perpl ${today.network}, block ${today.block.toLocaleString("en-US")}`;

const picture = new Picture();
await picture.mount($("canvas"));

let move = 0;
let run: RunResult | null = null;

function scene(): Scene {
  const broken = ledges.map(() => false);
  const water = ledges.map(() => 0);
  if (run) {
    for (const e of run.events) {
      if (e.kind !== "fill") continue;
      const i = ledgeOf.get(e.accountId);
      if (i === undefined) continue;
      broken[i] = true;
      water[i] = (water[i] ?? 0) + e.badDebt;
    }
  }
  const t = run?.totals;
  const fund = m.insuranceFund;
  const limit = cfg.layer.limitUsd;
  const bands = [
    { label: `Insurance fund (${usdShort(fund)}) pays`, dollars: fund, paid: t?.fundPaid ?? 0, color: COLORS.fundBand },
    ...(limit > 0 ? [{ label: `Spillway (${usdShort(limit)}) pays`, dollars: limit, paid: t?.layerPaid ?? 0, color: COLORS.accent }] : []),
    { label: "Winning traders lose", dollars: Math.max((fund + limit) * 0.35, 1), paid: t?.tradersLose ?? 0, color: COLORS.danger, wetOnly: true },
  ];
  return {
    ledges: ledges.map((l, i) => ({ ratio: l.price / m.markPrice, dollars: l.notional, broken: broken[i] ?? false, water: water[i] ?? 0 })),
    ghostRatio: run ? run.totals.spotEnd / m.markPrice : null,
    // Below the bottom of the cliff, the marker rests on the last tick.
    realRatio: run ? Math.max(1 - MAX_MOVE, run.totals.bookLow / m.markPrice) : null,
    water: t?.badDebt ?? 0,
    bands,
  };
}

function headline(): string {
  const longOi = today.positions.filter((p) => p.side === "long").reduce((a, p) => a + p.entryPrice * p.size, 0);
  if (move <= 0) return `Today Perpl's ${m.symbol} market holds <b>${usdShort(longOi)}</b> of open interest behind a <b>${usdShort(m.insuranceFund)}</b> insurance fund.`;
  const rows = bundle.capacity ?? [];
  const row = rows.reduce<(typeof rows)[number] | undefined>((best, r) => (!best || Math.abs(r.gap - move) < Math.abs(best.gap - move) ? r : best), undefined);
  const g = `${(move * 100).toFixed(1).replace(/\.0$/, "")}%`;
  if (!row || move < (rows[0]?.gap ?? 0) - 0.005) return `A ${g} gap is too small to empty the fund at any size Perpl allows.`;
  const amount = (c: typeof row.fundOnly) => (c.atSearchLimit ? `more than ${usdShort(c.openInterest)}` : usdShort(c.openInterest));
  return `Through a ${g} gap, the fund alone can carry <b>${amount(row.fundOnly)}</b> of open interest. With Spillway, <b>${amount(row.withSpillway)}</b>.`;
}

function sentence(): string {
  if (!run) return "Each ledge is traders' money that gets sold if the price falls that far. The basin is dry.";
  const t = run.totals;
  const d = `A ${(move * 100).toFixed(1).replace(/\.0$/, "")}% gap`;
  if (t.liquidations === 0) return `${d} reaches no ledge, so nothing is sold.`;
  if (t.badDebt <= 0) return `${d} breaks ${t.liquidations} positions, and their own margin covers every loss.`;
  if (t.band === 1) return `${d} leaves ${usd(t.badDebt)} of losses beyond traders' margin, and the insurance fund pays all of it.`;
  if (t.band === 2) return `${d} empties the insurance fund, and Spillway pays the next ${usd(t.layerPaid)}.`;
  return `${d} gets past the fund and Spillway, and winning traders lose ${usd(t.tradersLose)}.`;
}

function draw(): void {
  const { W, H } = picture.fit();
  const s = scene();
  const geo = layout(W, H, s.bands.map((b) => b.dollars), biggest);
  picture.draw(geo, s);
  renderOverlay($("overlay"), geo, s, {
    now: `${m.symbol} now ${usd(m.markPrice)}`,
    ghost: (r) => `Outside price −${((1 - r) * 100).toFixed(1)}%  ${usd(m.markPrice * r)}`,
    real: (r) => (r <= 1 - MAX_MOVE + 1e-9 ? "Perpl's book went below the last tick" : `Perpl's book went to ${usd(m.markPrice * r)}`),
    tick: (mv) => `−${Math.round(mv * 100)}%`,
  });
  $("sentence").textContent = sentence();
  $("headline").innerHTML = headline();
  $("drop-value").textContent = `${(move * 100).toFixed(1)}%`;
}

$<HTMLInputElement>("drop").addEventListener("input", (e) => {
  move = Number((e.target as HTMLInputElement).value) / 100;
  run = move > 0 ? gap(snapshot, move, cfg) : null;
  draw();
});

$("scenario").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  useScale(Number(b.dataset.k));
  run = move > 0 ? gap(snapshot, move, cfg) : null;
  draw();
});

new ResizeObserver(() => requestAnimationFrame(draw)).observe($("stage"));
draw();
