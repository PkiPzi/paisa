"use client";
import { useTransition } from "react";
import { setLabel } from "./actions";

/** Free-text label. Saves when you leave the box or press Enter; suggestions come from the shared #tags list. */
export function TagInput({ id, value }: { id: number; value: string | null }) {
  const [pending, start] = useTransition();
  const save = (v: string) => { if (v.trim() !== (value ?? "")) start(() => setLabel(id, v)); };
  return (
    <input
      className="pill" list="tags" aria-label="Label" placeholder="+ label" defaultValue={value ?? ""} disabled={pending}
      style={{ width: "9em", marginTop: 4 }} maxLength={40}
      onBlur={(e) => save(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
    />
  );
}
