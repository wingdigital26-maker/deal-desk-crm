"use client";
// Sign-in in the Wing Digital OS house style (Jack's call, 2026-09-20): the dark
// obsidian screen, one centred card, the builder mark, centred fields, the blue
// gradient "Enter" button. It deliberately does NOT follow the Quiet Ledger rules
// used inside the app (it has a shadow, a gradient and a glow): every colour and
// effect lives in the `.os-signin` block of app/globals.css so this file stays free
// of raw values. Behaviour keeps what the OS version lacks: real labels for screen
// readers and a separate plain sentence for each kind of failure.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { firm } from "../../firm.config";

type LoginState = { kind: "credentials" | "rate_limited" | "unavailable"; message: string };

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<LoginState | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 503) {
          setError({ kind: "unavailable", message: "Sign-in is not set up for this workspace yet. Contact whoever maintains it." });
        } else if (res.status === 429) {
          setError({ kind: "rate_limited", message: "Too many attempts from this email or connection. Wait a few minutes and try again." });
        } else {
          setError({ kind: "credentials", message: data.error ? `${data.error}. Check for typos and try again.` : "That email and password did not match. Check for typos and try again." });
        }
        setBusy(false);
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError({ kind: "unavailable", message: "Could not reach the server. Check your connection and try again." });
      setBusy(false);
    }
  }

  const invalid = error?.kind === "credentials";

  return (
    <div className="os-signin">
      <form className="os-signin-card" onSubmit={onSubmit} noValidate>
        <div className="os-signin-head">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/wing-mark.png" alt="" width={44} height={44} className="os-signin-mark" />
          <h1 className="os-signin-title">{firm.productName}</h1>
          <p className="os-signin-sub">Sign in to continue</p>
        </div>

        <div className="os-signin-field">
          <label className="os-signin-label" htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoFocus
            autoComplete="username"
            placeholder="you@yourfirm.example"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(null); }}
            aria-invalid={invalid}
            className="os-signin-input"
          />
        </div>

        <div className="os-signin-field">
          <label className="os-signin-label" htmlFor="password">Password</label>
          <div className="os-signin-wrap">
            <input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder="Your password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              aria-invalid={invalid}
              className="os-signin-input"
            />
            <button
              type="button"
              className="os-signin-reveal"
              onClick={() => setShowPassword((s) => !s)}
              aria-pressed={showPassword}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        {error && (
          <p role="alert" className="os-signin-error">
            {error.message}
          </p>
        )}

        <button type="submit" disabled={busy} className="os-signin-button">
          {busy ? "Checking..." : "Sign in"}
        </button>

        <p className="os-signin-foot">Built by {firm.builtBy}</p>
      </form>
    </div>
  );
}
