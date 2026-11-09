// Read lazily so `next build` never needs secrets. Missing values surface as a clear error at use.
export function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}
export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}
