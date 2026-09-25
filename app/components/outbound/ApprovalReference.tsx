"use client";
// Shows the approval reference (content hash) as a short, readable id with a
// button to copy the full value. The full reference is also always in the
// audit trail; this is never the only place it is available.
import { useState } from "react";
import { Button } from "../ui/Button";

export default function ApprovalReference({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  const short = hash.slice(0, 10);

  async function copy() {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ink-faint)]">
      <span>
        Approval reference <span className="numeric text-[var(--ink-soft)]">{short}</span>
      </span>
      <Button type="button" variant="quiet" size="sm" onClick={copy}>
        {copied ? "Copied" : "Copy full reference"}
      </Button>
    </div>
  );
}
