// PUBLIC opt-out page (see proxy.ts). No login, no Shell chrome (layout.tsx
// only wraps signed-in users), and must work with JS entirely off: the only
// interactive element is a plain <form method="POST"> to the unsubscribe API.
import { db } from "../../lib/db";
import { firm } from "../../../firm.config";
import { buttonClass } from "../../components/ui/Button";

export const runtime = "nodejs";

export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const message = db()
    .prepare(`SELECT contact_id FROM outbound_messages WHERE unsubscribe_token = ?`)
    .get(token) as { contact_id: number } | undefined;

  let alreadyDone = false;
  if (message) {
    const contact = db()
      .prepare(`SELECT unsubscribed_at FROM contacts WHERE id = ?`)
      .get(message.contact_id) as { unsubscribed_at: string | null } | undefined;
    alreadyDone = !!contact?.unsubscribed_at;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--paper)] px-6 py-10">
      <div className="card w-full max-w-sm p-8">
        <div className="display mb-4 text-xl text-[var(--ink)]">{firm.name}</div>

        {!message ? (
          <p className="text-sm text-[var(--ink-soft)]">This link is no longer valid.</p>
        ) : alreadyDone ? (
          <p className="text-sm text-[var(--ink-soft)]">
            You are already off {firm.sender.name}&apos;s email list. No further messages will be sent to you.
          </p>
        ) : (
          <>
            <p className="mb-6 text-sm text-[var(--ink-soft)]">
              Confirm below and {firm.sender.name} at {firm.name} will not email you again.
            </p>
            <form method="POST" action={`/api/unsubscribe/${token}`}>
              <button type="submit" className={buttonClass("primary", "md", "w-full")}>
                Do not email me again
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
