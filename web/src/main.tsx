import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./lib/api";
import { App } from "./App";
import { Button, ErrorBox } from "./components/ui";
import "./styles/base.css";
import "./styles/photos.css";
class Boundary extends React.Component<
  { children: React.ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="auth-page">
        <h1>Something went wrong</h1>
        <p>Your photos are safe on the server.</p>
        <Button primary onClick={() => location.reload()}>
          Reload Photos
        </Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function Root() {
  const [status, setStatus] = useState<any>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const reload = () =>
    api("/auth/status")
      .then(setStatus)
      .catch((e) => setError(e.message));
  useEffect(() => {
    reload();
  }, []);
  if (error && !status)
    return (
      <div className="auth-page">
        <ErrorBox message={error} retry={reload} />
      </div>
    );
  if (!status)
    return (
      <div className="auth-page">
        <img width="48" src="/favicon.svg" alt="" />
        <p>Opening Photos…</p>
      </div>
    );
  if (status.authenticated)
    return (
      <App
        user={status.user}
        logout={async () => {
          await api("/auth/logout", "POST");
          location.reload();
        }}
      />
    );
  return (
    <div className="auth-page">
      <form
        className="auth-card"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const f = new FormData(e.currentTarget);
          try {
            await api(
              status.needs_setup ? "/auth/setup" : "/auth/login",
              "POST",
              Object.fromEntries(f),
            );
            await reload();
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <img src="/favicon.svg" width="48" alt="" />
        <h1>Pocket Photos</h1>
        <p className="muted">
          Your photos, together.
          <br />A little closer to the moments that matter.
        </p>
        {status.oidc && (
          <a className="btn primary sso" href="/api/v1/auth/oidc/start">
            Continue with {status.oidc_name}
          </a>
        )}
        {status.needs_setup && (
          <p>Create the first account on this Photos server.</p>
        )}
        {status.needs_setup && (
          <label>
            Your name
            <input name="name" autoComplete="name" required />
          </label>
        )}
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            minLength={8}
            autoComplete={
              status.needs_setup ? "new-password" : "current-password"
            }
            required
          />
        </label>
        {error && <ErrorBox message={error} />}
        <Button type="submit" primary disabled={busy}>
          {busy
            ? "Please wait…"
            : status.needs_setup
              ? "Create account"
              : "Sign in"}
        </Button>
        <small className="muted">
          Private by nature. At home in your homelab.
        </small>
      </form>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <Boundary>
    <Root />
  </Boundary>,
);
