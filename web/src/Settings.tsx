import { useState } from "react";
import { api, bytes } from "./lib/api";
import { Button, ErrorBox } from "./components/ui";
import { Icon } from "./components/icons";
export function Settings({
  connection,
  changed,
  theme,
  setTheme,
  user,
}: {
  connection: any;
  changed: () => void;
  theme: string;
  setTheme: (s: string) => void;
  user: any;
}) {
  const [mode, setMode] = useState("key"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [success, setSuccess] = useState("");
  return (
    <div className="settings-page">
      <section className="settings-card">
        <div className="settings-heading">
          <span className="settings-icon">
            <Icon name="image" size={24} />
          </span>
          <div>
            <h2>Your photo library</h2>
            <p>Connect to Immich to make yourself at home.</p>
          </div>
          <span
            className={"pill " + (connection?.connected ? "connected" : "")}
          >
            {connection?.connected ? "Connected" : "Not connected"}
          </span>
        </div>
        {connection?.connected && (
          <div className="connected-account">
            <b>{connection.user?.name || connection.user?.email}</b>
            <span>{connection.user?.email}</span>
            <small>
              Connected{" "}
              {connection.via === "core"
                ? "through Pocket Core"
                : "directly to Immich"}
            </small>
            {connection.user?.quotaSizeInBytes > 0 && (
              <>
                <progress
                  max={connection.user.quotaSizeInBytes}
                  value={connection.user.quotaUsageInBytes || 0}
                />
                <small>
                  {bytes(connection.user.quotaUsageInBytes || 0)} of{" "}
                  {bytes(connection.user.quotaSizeInBytes)}
                </small>
              </>
            )}
            {connection.public_url && (
              <a href={connection.public_url} target="_blank" rel="noreferrer">
                Open Immich ↗
              </a>
            )}
            {connection.via === "direct" && (
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api("/connection", "DELETE");
                    changed();
                    setSuccess(
                      "Direct connection removed. Pocket Core will be used when available.",
                    );
                  } catch (e: any) {
                    setError(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Remove direct connection
              </Button>
            )}
          </div>
        )}
        {!connection?.connected && (
          <p className="muted">{connection?.message}</p>
        )}
        {connection?.server_configured && (
          <details open={!connection.connected}>
            <summary>
              {connection.connected
                ? "Use a different Immich account"
                : "Connect directly"}
            </summary>
            <div className="segmented connection-modes">
              <button
                className={mode === "key" ? "active" : ""}
                onClick={() => setMode("key")}
              >
                API key
              </button>
              <button
                className={mode === "password" ? "active" : ""}
                onClick={() => setMode("password")}
              >
                Email & password
              </button>
            </div>
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError("");
                setSuccess("");
                const f = new FormData(e.currentTarget);
                const form = e.currentTarget;
                try {
                  await api("/connection", "PUT", Object.fromEntries(f));
                  form.reset();
                  changed();
                  setSuccess("Your library is connected.");
                } catch (e: any) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {mode === "key" ? (
                <>
                  <label>
                    Immich API key
                    <input
                      name="api_key"
                      type="password"
                      required
                      autoComplete="off"
                      placeholder="Paste your personal API key"
                    />
                  </label>
                  <p className="small muted">
                    Create a key in Immich → Account settings → API keys. Its
                    permissions control which features you can use. Include
                    user.read and the photo, album, search, people, memory and
                    sharing permissions you need.
                  </p>
                </>
              ) : (
                <>
                  <label>
                    Immich email
                    <input
                      name="email"
                      type="email"
                      required
                      autoComplete="username"
                    />
                  </label>
                  <label>
                    Immich password
                    <input
                      name="password"
                      type="password"
                      required
                      autoComplete="current-password"
                    />
                  </label>
                  <p className="small muted">
                    Your password is used once to obtain a session. Only the
                    encrypted session token is saved.
                  </p>
                </>
              )}
              <Button primary type="submit" disabled={busy}>
                {busy ? "Connecting…" : "Connect Immich"}
              </Button>
            </form>
          </details>
        )}
        {!connection?.server_configured && !connection?.connected && (
          <p>
            Use the Immich connection in Pocket Core, or configure{" "}
            <code>IMMICH_URL</code> on the Photos server to enable direct
            sign-in.
          </p>
        )}
        {error && <ErrorBox message={error} />}{" "}
        {success && (
          <p className="success-message" role="status">
            {success}
          </p>
        )}
      </section>
      <section className="settings-card">
        <h2>Appearance</h2>
        <p className="muted">Choose how Photos looks on this device.</p>
        <div className="theme-options">
          {[
            ["light", "sun", "Light"],
            ["dark", "moon", "Dark"],
            ["system", "monitor", "System"],
          ].map(([id, icon, label]) => (
            <button
              className={theme === id ? "active" : ""}
              key={id}
              onClick={() => setTheme(id)}
            >
              <Icon name={icon} size={22} />
              {label}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-card">
        <h2>Connected sources</h2>
        <p className="muted">
          Pocket Files and Pocket Documents use your permissions in Pocket Core.
          Manage their access in Core → Apps acting for me.
        </p>
        <div className="settings-source">
          <Icon name="folder" size={20} />
          <b>Pocket Files</b>
          <span>Browse and import · Read only</span>
        </div>
        <div className="settings-source">
          <Icon name="file" size={20} />
          <b>Pocket Documents</b>
          <span>Image originals · Read only</span>
        </div>
      </section>
      <section className="settings-card">
        <h2>About Pocket Photos</h2>
        <p>Version 0.1.0 · Built for your Pocket homelab</p>
        <p className="muted">
          Signed in as {user.email}. Originals, albums, faces, search and
          sharing live in Immich. Photos stores account connections encrypted on
          this server.
        </p>
        <p className="muted">
          Browser uploads run while this app is open. For automatic background
          camera backup, use the Immich mobile app with the same account.
        </p>
        <a
          href="https://github.com/abjelosevic88/pocket-homelab-photos"
          target="_blank"
          rel="noreferrer"
        >
          Source code ↗
        </a>
      </section>
    </div>
  );
}
