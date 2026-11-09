import { login } from "./actions";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ e?: string }> }) {
  const { e } = await searchParams;
  return (
    <main className="login">
      <form action={login} className="card">
        <h1 className="brand">Paisa</h1>
        <p className="muted">Your money, tracked without the effort.</p>
        {e ? <p className="alert" role="alert">Wrong password.</p> : null}
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required autoFocus />
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
