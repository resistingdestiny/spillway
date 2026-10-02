import { type Bundle, type Ledge, type RunResult, type Snapshot, ledges as groupLedges, scaleOpenInterest, stress } from "@spillway/engine";
import { layout } from "./layout.js";
import { renderOverlay, usd } from "./overlay.js";
import { Picture, type Scene } from "./picture.js";

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
  const ledgeBadDebt = ledges.map(() => 0);
  if (run) {
    for (const e of run.events) {
      if (e.kind !== "fill") continue;
      const i = ledgeOf.get(e.accountId);
      if (i === undefined) continue;
      broken[i] = true;
      ledgeBadDebt[i] = (ledgeBadDebt[i] ?? 0) + e.badDebt;
    }
  }
  return {
    mark: m.markPrice,
    ledges,
    broken,
    ledgeBadDebt,
    ghostRatio: run ? run.totals.spotEnd / m.markPrice : null,
    realRatio: run ? run.totals.bookLow / m.markPrice : null,
    water: run ? run.totals.badDebt : 0,
    layerOn: cfg.layer.limitUsd > 0,
  };
}

function sentence(): string {
  if (!run) return "Each ledge is traders' money that gets sold if the price falls that far. The basin is dry.";
  const t = run.totals;
  const d = `A ${(move * 100).toFixed(1).replace(/\.0$/, "")}% drop`;
  if (t.liquidations === 0) return `${d} reaches no ledge, so nothing is sold.`;
  if (t.badDebt <= 0) return `${d} breaks ${t.liquidations} positions, and their own margin covers every loss.`;
  if (t.band === 1) return `${d} leaves ${usd(t.badDebt)} of losses beyond traders' margin, and the insurance fund pays all of it.`;
  if (t.band === 2) return `${d} empties the insurance fund, and Spillway pays the next ${usd(t.layerPaid)}.`;
  return `${d} gets past the fund and Spillway, and winning traders lose ${usd(t.tradersLose)}.`;
}

function draw(): void {
  const { W, H } = picture.fit();
  const geo = layout(W, H, m.insuranceFund, cfg.layer.limitUsd, biggest);
  const s = scene();
  picture.draw(geo, s);
  renderOverlay($("overlay"), geo, s, run?.totals ?? { fundPaid: 0, layerPaid: 0, tradersLose: 0 }, m.symbol);
  $("sentence").textContent = sentence();
  $("drop-value").textContent = `${(move * 100).toFixed(1)}%`;
}

$<HTMLInputElement>("drop").addEventListener("input", (e) => {
  move = Number((e.target as HTMLInputElement).value) / 100;
  run = move > 0 ? stress(snapshot, move, cfg) : null;
  draw();
});

$("scenario").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  useScale(Number(b.dataset.k));
  run = move > 0 ? stress(snapshot, move, cfg) : null;
  draw();
});

new ResizeObserver(() => requestAnimationFrame(draw)).observe($("stage"));
draw();
