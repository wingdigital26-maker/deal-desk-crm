"use client";
// The one original idea of this product, given the weight it deserves: a
// ruled block set directly under a Letter that reads like a countersignature
// on the document, not a caption below it. Approved content shows who
// approved it, when, and the reference. Content still awaiting approval
// shows the same shape so the principal sees exactly what their approval
// will sign. The state itself (approved / awaiting approval) is a
// StatusLabel inside the first cell, never a floating uppercase eyebrow
// above the block.
import { parseSqliteDate } from "../../lib/dates";
import { useState } from "react";
import { Button } from "./Button";
import StatusLabel from "./StatusLabel";

type Props =
  | { state: "approved"; approvedBy: string; date: string | null; reference: string }
  | { state: "pending"; submittedBy: string; date: string | null; reference: string };

export default function Countersignature(props: Props) {
  const [copied, setCopied] = useState(false);
  const short = props.reference.slice(0, 10);
  const isApproved = props.state === "approved";
  const name = isApproved ? props.approvedBy : props.submittedBy;

  async function copy() {
    try {
      await navigator.clipboard.writeText(props.reference);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="border-y border-[var(--rule)] py-3">
      <div className={`grid gap-4 ${props.date ? "grid-cols-3" : "grid-cols-2"}`}>
        <div>
          <StatusLabel kind={isApproved ? "ok" : "info"}>{isApproved ? "Approved" : "Awaiting approval"}</StatusLabel>
          <div className="mt-1 text-sm font-semibold text-[var(--ink)]">by {name}</div>
        </div>
        {props.date && (
          <div>
            <div className="label">Date</div>
            <div className="numeric mt-0.5 text-sm font-semibold text-[var(--ink)]">{props.date}</div>
          </div>
        )}
        <div>
          <div className="label">{isApproved ? "Approval reference" : "Reference"}</div>
          <div className="numeric mt-0.5 text-sm font-semibold text-[var(--ink)]">{short}</div>
          <div className="mt-1.5 text-left">
            <Button type="button" variant="quiet" size="sm" onClick={copy}>
              {copied ? "Copied" : "Copy full reference"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export { parseSqliteDate };
