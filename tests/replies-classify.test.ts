import { describe, it, expect } from "vitest";
import { classifyMessage } from "../app/lib/replies/sync";

describe("classifyMessage", () => {
  it.each([
    ["mailer-daemon@mail.example.com", "Delivery Status Notification (Failure)", "", "bounce"],
    ["postmaster@example.com", "Undeliverable: your message", "", "bounce"],
    ["dana@example.com", "Out of Office", "I am out of office until Monday.", "auto-reply"],
    ["dana@example.com", "Automatic reply: hello", "", "auto-reply"],
    ["dana@example.com", "Re: intro", "Please unsubscribe me from this list.", "unsubscribe"],
    ["dana@example.com", "Re: intro", "Please remove me from your list.", "unsubscribe"],
    ["dana@example.com", "Re: intro", "Thanks for reaching out, tell me more.", "reply"],
    ["someone@example.com", "", "", "reply"],
  ])("classifies (%s, %s, %s) as %s", (fromEmail, subject, snippet, expected) => {
    expect(classifyMessage({ fromEmail, subject, snippet })).toBe(expected);
  });

  it("treats Auto-Submitted header as auto-reply unless it is 'no'", () => {
    expect(
      classifyMessage({ fromEmail: "dana@example.com", subject: "Re: hi", snippet: "", headers: { "auto-submitted": "auto-replied" } })
    ).toBe("auto-reply");
    expect(
      classifyMessage({ fromEmail: "dana@example.com", subject: "Re: hi", snippet: "", headers: { "auto-submitted": "no" } })
    ).toBe("reply");
  });

  it("prioritizes bounce over unsubscribe-like phrasing from mailer-daemon", () => {
    expect(
      classifyMessage({
        fromEmail: "mailer-daemon@example.com",
        subject: "Delivery Status Notification",
        snippet: "please unsubscribe this address",
      })
    ).toBe("bounce");
  });

  it("is case-insensitive", () => {
    expect(classifyMessage({ fromEmail: "MAILER-DAEMON@example.com", subject: "DELIVERY STATUS NOTIFICATION" })).toBe("bounce");
  });
});
