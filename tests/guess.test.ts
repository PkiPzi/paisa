import { afterEach, expect, it, vi } from "vitest";
import { guessCategory } from "@/lib/clients";

const reply = (content: object) => vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] })));
const t = { payee: "Hotel Kubera", amount: 55000, direction: "debit", at: new Date() };
afterEach(() => vi.unstubAllGlobals());

it("keeps a tag only when it is one the person already uses", async () => {
  process.env.GROQ_API_KEY = "test";
  reply({ category: "Travel", confidence: 0.9, tag: "gokarna" });
  expect((await guessCategory(t, ["Gokarna", "Wi-Fi"]))?.tag).toBe("Gokarna"); // canonical spelling
  reply({ category: "Travel", confidence: 0.9, tag: "Made up" });
  expect((await guessCategory(t, ["Gokarna"]))?.tag).toBeUndefined();
  reply({ category: "Travel", confidence: 0.9, tag: "Gokarna" });
  expect((await guessCategory(t))?.tag).toBeUndefined(); // no known tags: nothing to pick from
});
