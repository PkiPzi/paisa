import { beforeAll, describe, expect, it } from "vitest";

process.env.PGLITE_DIR = "memory://";
const { getDb, schema } = await import("@/db");
const L = await import("@/lib/ledger");

beforeAll(async () => {
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  await migrate(getDb() as never, { migrationsFolder: "./drizzle" });
});

const pay = async (amount: number, direction = "debit", payeeKey = "truffles") =>
  (await getDb().insert(schema.txns).values({ at: new Date("2026-11-10T12:00:00Z"), amount, direction, account: "ICICI a/c 1234", payee: "Truffles", payeeKey }).returning())[0];
const net = async (name: string) => (await L.balances()).find((b) => b.name === name)?.amount ?? 0;

describe("parseCommand", () => {
  it("reads the bot's text commands", () => {
    expect(L.parseCommand("/who")).toEqual({ kind: "who" });
    expect(L.parseCommand("/group flat: aman, riya k")).toEqual({ kind: "group", name: "Flat", members: ["Aman", "Riya K"] });
    expect(L.parseCommand("Aman owes 500 dinner")).toEqual({ kind: "due", person: "Aman", amount: 50000, note: "dinner" });
    expect(L.parseCommand("owe riya 120.50")).toEqual({ kind: "due", person: "Riya", amount: -12050, note: "Added by hand" });
    expect(L.parseCommand("spent 200 on chai")).toEqual({ kind: "cash", amount: 20000, note: "chai" });
    expect(L.parseCommand("cash 45.50")).toEqual({ kind: "cash", amount: 4550, note: "" });
    expect(L.parseCommand("/merge ratna into ratnashree")).toEqual({ kind: "merge", from: "Ratna", to: "Ratnashree" });
    expect(L.parseCommand("hello")).toBeNull();
  });
});

describe("ledger", () => {
  it("splits once, undoes cleanly, and settles in both directions", async () => {
    await L.saveCircle("Flat", ["Aman", "Riya"]);
    const { circles } = await L.splitTargets();
    const t = await pay(100000);

    const plan = (await L.equalPlan(`g:${circles[0].id}`, t.amount))!;
    expect(plan.myShare + plan.dues.reduce((a, d) => a + d.amount, 0)).toBe(100000);
    const done = await L.postSplit(t, plan, `g:${circles[0].id}`);
    expect(done?.myShare).toBe(33334);
    expect(await L.postSplit(t, plan)).toBeNull(); // a second tap adds nothing
    expect(await net("Aman")).toBe(33333);

    await L.undoSplit(done!);
    expect(await net("Aman")).toBe(0);
    await L.postSplit(t, plan);

    // Aman pays back 300 by UPI; a later transfer from the same UPI id is remembered as his.
    const aman = await L.findOrCreatePerson("aman");
    const back = await pay(30000, "credit", "aman@okaxis");
    await L.settle(back, aman);
    expect(await L.settle(back, aman)).toBeNull();
    expect(await net("Aman")).toBe(3333);
    const [memory] = await getDb().select().from(schema.payees);
    expect([memory.key, memory.category, memory.splitTarget]).toEqual(["truffles", null, `g:${circles[0].id}`]);

    await L.addDue("Riya", -50000, "she paid for the cab"); // you owe her more than she owes you
    expect(await net("Riya")).toBe(33333 - 50000);
  });

  it("merges one friend saved under two names", async () => {
    await L.addDue("Ratna", 10000, "lunch");
    await L.addDue("Ratnashree", 5000, "cab");
    await L.saveCircle("Trip", ["Ratna", "Ratnashree"]);
    expect((await L.mergePeople("ratna", "Ratnashree"))?.name).toBe("Ratnashree");
    expect(await net("Ratnashree")).toBe(15000);
    expect(await net("Ratna")).toBe(0);
    expect((await L.splitTargets()).circles.find((c) => c.name === "Trip")?.size).toBe(1);
    expect(await L.mergePeople("Nobody", "Ratnashree")).toBeNull();
  });
});
