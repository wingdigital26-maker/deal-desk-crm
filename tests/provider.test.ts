import { describe, it, expect, afterEach, vi } from "vitest";

const ALL_APOLLO_ENV = {
  OUTBOUND_PROVIDER: "apollo",
  OUTBOUND_SEND_ENABLED: "1",
  APOLLO_API_KEY: "key",
  APOLLO_SEQUENCE_ID: "seq",
  APOLLO_EMAIL_ACCOUNT_ID: "acct",
} as const;

const ENV_KEYS = Object.keys(ALL_APOLLO_ENV) as (keyof typeof ALL_APOLLO_ENV)[];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe("getProvider", () => {
  afterEach(() => {
    clearEnv();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("defaults to DryRunProvider with no env set", async () => {
    clearEnv();
    const { getProvider, DryRunProvider } = await import("../app/lib/outbound/provider");
    expect(getProvider()).toBeInstanceOf(DryRunProvider);
  });

  it.each(ENV_KEYS)("falls back to DryRunProvider when only %s is missing", async (missingKey) => {
    clearEnv();
    for (const k of ENV_KEYS) {
      if (k !== missingKey) process.env[k] = ALL_APOLLO_ENV[k];
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("network I/O attempted with an incomplete Apollo config");
      })
    );
    const { getProvider, DryRunProvider } = await import("../app/lib/outbound/provider");
    expect(getProvider()).toBeInstanceOf(DryRunProvider);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("only returns ApolloProvider when every one of the four switches is set", async () => {
    clearEnv();
    for (const k of ENV_KEYS) process.env[k] = ALL_APOLLO_ENV[k];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("network I/O attempted by getProvider() itself, which must never happen");
      })
    );
    const { getProvider, ApolloProvider } = await import("../app/lib/outbound/provider");
    const provider = getProvider();
    expect(provider).toBeInstanceOf(ApolloProvider);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("falls back to DryRunProvider when OUTBOUND_SEND_ENABLED is not exactly \"1\"", async () => {
    clearEnv();
    for (const k of ENV_KEYS) process.env[k] = ALL_APOLLO_ENV[k];
    process.env.OUTBOUND_SEND_ENABLED = "true";
    const { getProvider, DryRunProvider } = await import("../app/lib/outbound/provider");
    expect(getProvider()).toBeInstanceOf(DryRunProvider);
  });
});

describe("ApolloProvider.send", () => {
  afterEach(() => {
    clearEnv();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("is never exercised for real: fetch is stubbed to throw and construction requires every switch", async () => {
    clearEnv();
    for (const k of ENV_KEYS) process.env[k] = ALL_APOLLO_ENV[k];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("real Apollo network call attempted in tests");
      })
    );
    const { ApolloProvider } = await import("../app/lib/outbound/provider");
    const provider = new ApolloProvider();
    const result = await provider.send({
      messageId: 1,
      mailboxAddress: "sender@sender.test",
      toEmail: "dana@example.com",
      subject: "Hi",
      body: "Body",
    });
    // send() catches the thrown fetch and reports it as a clean failure, it
    // never lets a real network attempt escape or crash the run.
    expect(result.ok).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});

describe("SmtpProvider", () => {
  it("throws not configured, since no transport is implemented", async () => {
    const { SmtpProvider } = await import("../app/lib/outbound/provider");
    const provider = new SmtpProvider();
    await expect(
      provider.send({ messageId: 1, mailboxAddress: "a@b.test", toEmail: "c@d.test", subject: "s", body: "b" })
    ).rejects.toThrow(/not configured/i);
  });
});
