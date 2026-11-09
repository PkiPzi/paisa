import Link from "next/link";
import { getDb, schema } from "@/db";
import { rupees } from "@/lib/money";
import { lastMonthFacts, nudges, portfolio, targetEquityPct, valueOf } from "@/lib/invest";

export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = { equity: "Equity", debt: "Debt", hybrid: "Hybrid", gold: "Gold", other: "Other" };
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);

export default async function Invest() {
  const hs = (await getDb().select().from(schema.holdings)).sort((a, b) => valueOf(b) - valueOf(a));
  const p = portfolio(hs);
  const last = await lastMonthFacts();
  const tips = nudges(hs, last, targetEquityPct());
  const priced = hs.map((h) => h.priceAt).filter(Boolean).sort().at(-1);

  return (
    <main className="page">
      <header className="top"><Link className="brand" href="/">Paisa</Link><Link className="link" href="/">← Dashboard</Link></header>

      {!hs.length ? (
        <section className="card"><h2>Investments</h2><p className="muted">No holdings yet. Export your holdings from Groww and run <code>npx tsx scripts/import-holdings.ts &lt;files&gt;</code>.</p></section>
      ) : <>
        <section className="tiles two">
          <div className="card hero">
            <h2>Investments are worth</h2>
            <p className="big">{rupees(p.value)}</p>
            <p className="muted">
              <b className={p.gain >= 0 ? "up" : "down"}>{p.gain >= 0 ? "▲" : "▼"} {rupees(Math.abs(p.gain))} ({Math.abs(pct(p.gain, p.invested))}%)</b> {p.gain >= 0 ? "above" : "below"} the {rupees(p.invested)} you put in
            </p>
            {priced ? <p className="muted">Prices as of {priced}.</p> : null}
          </div>
          <div className="card">
            <h2>How it is spread · {p.equityPct}% equity, target {targetEquityPct()}%</h2>
            <div className="seg" role="img" aria-label={p.byClass.map((c) => `${LABEL[c.name]} ${pct(c.value, p.value)}%`).join(", ")}>
              {p.byClass.map((c) => <i key={c.name} className={`c-${c.name}`} style={{ flexGrow: c.value }} data-tip={`${LABEL[c.name]} · ${rupees(c.value)} · ${pct(c.value, p.value)}%`} tabIndex={0} />)}
            </div>
            <ul className="rows legend">
              {p.byClass.map((c) => <li key={c.name}><span><i className={`dot c-${c.name}`} />{LABEL[c.name]}</span><span className="num">{rupees(c.value)} · {pct(c.value, p.value)}%</span></li>)}
            </ul>
          </div>
        </section>

        <section className="card">
          <h2>Worth a look</h2>
          {tips.length ? <ul className="tips">{tips.map((t) => <li key={t}>{t}</li>)}</ul> : <p className="muted">Nothing needs doing. Keep the SIPs running.</p>}
          <p className="muted fine">Worked out from your own numbers. A prompt to think, not registered investment advice.</p>
        </section>

        <section className="card">
          <h2>Holdings</h2>
          <ul className="txns hold">
            {hs.map((h) => {
              const v = valueOf(h), g = v - h.invested;
              return (
                <li key={h.isin}>
                  <div className="who"><span>{h.name}</span><small className="muted">{h.category} · {h.units.toLocaleString("en-IN", { maximumFractionDigits: 3 })} units{h.price === null ? " · no price yet" : ""}</small></div>
                  <span className={`num ${g >= 0 ? "up" : "down"}`}>{h.invested ? `${g >= 0 ? "▲" : "▼"} ${Math.abs(pct(g, h.invested))}%` : ""}</span>
                  <span className="num amt">{rupees(v)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      </>}
    </main>
  );
}
