"use client";
import { useTransition } from "react";
import { relabel } from "./actions";

export function CategorySelect({ id, value, options }: { id: number; value: string | null; options: string[] }) {
  const [pending, start] = useTransition();
  return (
    <select
      className={`pill${value ? "" : " todo"}`}
      aria-label="Category"
      value={value ?? ""}
      disabled={pending}
      onChange={(e) => start(() => relabel(id, e.target.value))}
    >
      <option value="">Needs a label</option>
      {options.map((c) => <option key={c}>{c}</option>)}
    </select>
  );
}
