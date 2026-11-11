import Link from "next/link";
import { and, asc, desc, gte, lt } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CREDIT, DEBIT_OTHER, SPEND, istDay, rupees, summarize } from "@/lib/money";
import { balances } from "@/lib/ledger";
import { logout } from "./login/actions";
import { CategorySelect } from "./category-select";

export const dynamic = "force-dynamic";

const monthStart = (m: string) => new Date(`${m}-01T00:00:00+05:30`);
const shift = (m: string, by: number) => {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const monthName = (m: string, opts: Intl.DateTimeFormatOptions = { month: "long", year: "numeric" }) =>
  new Date(`${m}-15T00:00:00Z`).toLocaleDateString("en-IN", opts);
const short = (paise: number) => {
  const r = paise / 100;
  return r >= 100000 ? `₹${(r / 100000).toFixed(1)}L` : r >= 1000 ? `₹${(r / 1000).toFixed(r >= 10000 ? 0 : 1)}k` : `₹${Math.round(r)}`;
};

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ m?: string; f?: string }> }) {
  const sp = await searchParams;
  const today = istDay(new Date());
  const thisMonth = today.slice(0, 7);
  const m = /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.m ?? "") ? sp.m! : thisMonth;
  const isCurrent = m === thisMonth;
  const db = getDb();

  const [all, bills, owed] = await Promise.all([
    db.select().from(schema.txns)
      .where(and(gte(schema.txns.at, monthStart(shift(m, -1))), lt(schema.txns.at, monthStart(shift(m, 1)))))
      .orderBy(desc(schema.txns.at)),
    db.select().from(schema.bills).where(gte(schema.bills.dueDate, today)).orderBy(asc(schema.bills.dueDate)),
    balances(),
  ]);

  const rows = all.filter((t) => t.at >= monthStart(m));
  const s = summarize(rows);
  // Compare like with like: last month up to the same day of the month.
  const dayOfMonth = isCurrent ? Number(today.slice(8)) : 31;
  const prev = summarize(all.filter((t) => t.at < monthStart(m) && Number(istDay(t.at).slice(8)) <= dayOfMonth));
  const change = prev.spent > 0 ? Math.round(((s.spent - prev.spent) / prev.spent) * 100) : null;

  const daysInMonth = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).getUTCDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const key = `${m}-${String(i + 1).padStart(2, "0")}`;
    return { n: i + 1, key, value: Math.max(0, s.byDay.get(key) ?? 0), future: key > today };
  });
  const maxDay = Math.max(1, ...days.map((d) => d.value));
  const elapsed = isCurrent ? dayOfMonth : daysInMonth;
  const maxCat = Math.max(1, ...s.byCategory.map(([, v]) => v));

  const owedToYou = owed.filter((b) => b.amount > 0);
  const youOwe = owed.filter((b) => b.amount < 0);
  const list = sp.f === "todo" ? rows.filter((t) => !t.category) : rows;
  const byDay = Map.groupBy(list, (t) => istDay(t.at));
  const qs = (f?: string) => `/?m=${m}${f ? `&f=${f}` : ""}`;

  return (
    <main className="page">
      <header className="top">
        <span className="brand">Paisa</span>
        <nav className="month" aria-label="Month">
          <Link href={`/?m=${shift(m, -1)}`} aria-label="Previous month">‹</Link>
          <strong>{monthName(m)}</strong>
          {isCurrent ? <span aria-hidden className="off">›</span> : <Link href={`/?m=${shift(m, 1)}`} aria-label="Next month">›</Link>}
        </nav>
        <div className="links"><Link className="link" href="/invest">Investments</Link><Link className="link" href="/people">People</Link><Link className="link" href="/backfill">Past splits</Link><form action={logout}><button className="link">Sign out</button></form></div>
      </header>

      <section className="tiles">
        <div className="card hero">
          <h2>Spent{isCurrent ? " this month" : ""}</h2>
          <p className="big">{rupees(s.spent)}</p>
          <p className="muted">
            {change === null ? `${short(Math.round(s.spent / elapsed))} a day on average`
              : <><b>{change > 0 ? "▲" : change < 0 ? "▼" : ""} {Math.abs(change)}% {change > 0 ? "more" : change < 0 ? "less" : "same"}</b> than {isCurrent ? "this point in" : ""} {monthName(shift(m, -1), { month: "long" })} · {short(Math.round(s.spent / elapsed))} a day</>}
          </p>
          {s.shared > 0 ? <p className="muted">{rupees(s.shared)} more was paid for friends and is tracked under Owed to you.</p> : null}
        </div>

        <div className="card">
          <h2>Owed to you</h2>
          <p className="big">{rupees(owedToYou.reduce((a, b) => a + b.amount, 0))}</p>
          <ul className="rows">
            {owedToYou.slice(0, 4).map((b) => <li key={b.id}><span>{b.name}</span><span className="num">{rupees(b.amount)}</span></li>)}
            {owedToYou.length > 4 ? <li className="muted"><span>and {owedToYou.length - 4} more</span></li> : null}
            {youOwe.length ? <li className="muted"><span>You owe {youOwe.map((b) => b.name).slice(0, 3).join(", ")}</span><span className="num">{rupees(-youOwe.reduce((a, b) => a + b.amount, 0))}</span></li> : null}
            {!owedToYou.length && !youOwe.length ? <li className="muted"><span>All settled up.</span></li> : null}
          </ul>
          <Link className="more" href="/people">See everyone →</Link>
        </div>

        <div className="card">
          <h2>Card bills</h2>
          {bills.length ? <ul className="rows">
            {bills.slice(0, 4).map((b) => {
              const left = Math.round((Date.parse(b.dueDate) - Date.parse(today)) / 86_400_000);
              return <li key={b.emailId}>
                <span>{b.card}<small className={left <= 3 ? "warn" : "muted"}>{left === 0 ? "⚠ Due today" : left <= 3 ? `⚠ Due in ${left} day${left > 1 ? "s" : ""}` : `Due ${new Date(b.dueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`}</small></span>
                <span className="num">{rupees(b.amount)}</span>
              </li>;
            })}
          </ul> : <p className="muted">Nothing due. Statements show up here when the bank emails them.</p>}
        </div>
      </section>

      {s.unlabelled > 0 && sp.f !== "todo" ? (
        <Link className="nudge" href={qs("todo")}>
          <b>{s.unlabelled} payment{s.unlabelled > 1 ? "s" : ""}</b> still need{s.unlabelled > 1 ? "" : "s"} a label. Review now →
        </Link>
      ) : null}

      <section className="charts">
        <div className="card">
          <h2>Day by day</h2>
          <div className="cols" role="img" aria-label={`Daily spending in ${monthName(m)}, highest day ${rupees(maxDay)}`}>
            <span className="peak">{short(maxDay)}</span>
            {days.map((d) => (
              <div key={d.n} className={`col${d.future ? " future" : ""}`} data-tip={`${d.n} ${monthName(m, { month: "short" })} · ${rupees(d.value)}`} tabIndex={d.value ? 0 : -1}>
                <i style={{ height: `${(d.value / maxDay) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="axis" aria-hidden>
            {days.map((d) => <span key={d.n}>{d.n === 1 || d.n % 5 === 0 ? d.n : ""}</span>)}
          </div>
        </div>

        <div className="card">
          <h2>Where it went</h2>
          {s.byCategory.length ? <ul className="bars">
            {s.byCategory.map(([c, v]) => (
              <li key={c} data-tip={`${Math.round((v / s.spent) * 100)}% of spending`} tabIndex={0}>
                <span>{c}</span>
                <span className="track"><i style={{ width: `${(v / maxCat) * 100}%` }} /></span>
                <span className="num">{rupees(v)}</span>
              </li>
            ))}
          </ul> : <p className="muted">No spending recorded for this month yet.</p>}
        </div>
      </section>

      <section className="card">
        <div className="listhead">
          <h2>{sp.f === "todo" ? "Needs a label" : "Transactions"}</h2>
          {sp.f === "todo" ? <Link href={qs()}>Show all</Link> : null}
        </div>
        {!list.length ? <p className="muted">{sp.f === "todo" ? "Everything is labelled." : "Nothing here yet. Payments appear a few minutes after the bank emails you."}</p> : null}
        {[...byDay].map(([day, items]) => (
          <div key={day}>
            <h3>{new Date(`${day}T12:00:00+05:30`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}</h3>
            <ul className="txns">
              {items.map((t) => (
                <li key={t.id}>
                  <div className="who">
                    <span>{t.payee}</span>
                    <small className="muted">
                      {t.account} · {t.at.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" })}
                      {t.myShare !== null ? ` · split with ${t.splitWith}, your share ${rupees(t.myShare)}` : ""}
                    </small>
                  </div>
                  <CategorySelect id={t.id} value={t.category} options={t.direction === "debit" ? [...SPEND, ...DEBIT_OTHER] : [...CREDIT]} />
                  <span className={`num amt${t.direction === "credit" ? " in" : ""}`}>{t.direction === "credit" ? "+" : ""}{rupees(t.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </main>
  );
}
