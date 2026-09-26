# Outlook capture (built, switched off)

Outlook capture reads one Outlook mailbox through Microsoft Graph and adds a
line to a contact's timeline whenever you email that contact or meet with
them. It saves you from logging every touch by hand.

It is built and tested but **switched off**. It does nothing until the firm
signs off, an administrator registers the app in Azure, and someone sets the
settings below. Until then the sync button refuses and no call is ever made
to Microsoft.

## What it captures

- **Email you sent to, or received from, a contact already in Deal Desk.**
  Each one becomes a timeline entry marked "email-out" or "email-in", with the
  subject and the short preview Outlook shows in the message list, cut to 500
  characters at most. The entry is dated when the email was sent or received.
- **Meetings with a contact already in Deal Desk.** Each one becomes a
  "meeting" timeline entry with the meeting subject and start time (UTC).
  Only meetings that have already started are captured. Cancelled meetings
  are skipped.
- Entries attach to the contact and to the contact's company. If one email
  goes to three known contacts, each contact gets one entry.
- It reads metadata only: sender, recipients, subject, dates, the preview.
  It does not store full message bodies or attachments.

## What it will NOT do

- It never sends, replies to, forwards, moves, flags, or deletes anything.
  The permissions it uses are read only.
- It never creates a contact. If nobody on an email or meeting is already a
  contact in Deal Desk, the item is skipped. Newsletters, vendors, internal
  mail and personal mail stay out of the CRM.
- It never keeps more than a 500-character preview of any email.
- It never runs on its own. There is no timer. An owner runs it by hand.
- It never double-logs. Running it again, or twice in a row, adds nothing new
  for items already captured.

## Firm sign-off needed first

Get written approval from the firm's CCO (or whoever supervises vendor and
records decisions) before turning this on. Points to cover:

1. **Supervision and vendor oversight (FINRA Rule 3110, Regulatory Notice
   21-29).** Deal Desk becomes a third-party system reading firm email. The
   firm should record the vendor review, who has access, and how it is
   supervised, the same way it would for any outsourced tool.
2. **Books and records (SEA Rule 17a-4).** The firm's own Outlook archive and
   journaling remain the book of record for all business communications.
   Deal Desk keeps a convenience copy of metadata and a short preview only.
   It is not an archive, it is not WORM storage, and nothing here replaces
   or feeds the firm's retention system. State this in the approval.
3. **Material non-public information (Exchange Act Section 15(g)).**
   Subjects and previews of deal email can contain MNPI. Deal Desk access
   must follow the firm's information barrier policy: only people allowed to
   see that deal information get a Deal Desk login, and the database file is
   protected like any other confidential deal record.
4. **Scope.** Confirm the single mailbox to be read (normally only the
   banker's own), and that the access policy in step 5 below is in place so
   the app cannot read anyone else's mail.

## Azure setup (for the firm's Microsoft 365 administrator)

1. In the Microsoft Entra admin center, go to **App registrations** and choose
   **New registration**. Name it something like "Deal Desk Outlook capture".
   Single tenant. No redirect URI.
2. Open the new app, go to **API permissions**, choose **Add a permission**,
   **Microsoft Graph**, **Application permissions**, and add:
   - `Mail.Read`
   - `Calendars.Read`
   Do not add any Send, ReadWrite, or delegated permissions.
3. Choose **Grant admin consent** for the tenant.
4. Go to **Certificates and secrets**, create a **client secret**, and copy
   its value once. Store it only in the host's secret settings, never in a
   file, email, or chat. Note its expiry date; capture stops when it expires.
5. **Scope the app to ONE mailbox.** Application permissions otherwise cover
   every mailbox in the tenant. In Exchange Online PowerShell:

   ```powershell
   New-DistributionGroup -Name "DealDesk-Capture" -Type Security -Members banker@yourfirm.com
   New-ApplicationAccessPolicy -AppId <application-client-id> `
     -PolicyScopeGroupId DealDesk-Capture@yourfirm.com `
     -AccessRight RestrictAccess `
     -Description "Deal Desk capture reads only the banker's mailbox"
   Test-ApplicationAccessPolicy -Identity banker@yourfirm.com -AppId <application-client-id>
   Test-ApplicationAccessPolicy -Identity someone.else@yourfirm.com -AppId <application-client-id>
   ```

   The first test should say **Granted** and the second **Denied**. Do not
   turn capture on until both results are correct. (Microsoft is moving this
   feature to RBAC for Applications; if the admin uses that instead, the goal
   is the same: this app can read one mailbox and no other.)
6. From the app's **Overview** page, copy the **Directory (tenant) ID** and
   the **Application (client) ID**.

## Settings

Set these on the machine or host that runs Deal Desk (see docs/ENV.md):

| Setting | Value |
| --- | --- |
| `GRAPH_CAPTURE_ENABLED` | `1` to turn capture on. Anything else, or unset, means off. |
| `GRAPH_TENANT_ID` | Directory (tenant) ID from step 6 |
| `GRAPH_CLIENT_ID` | Application (client) ID from step 6 |
| `GRAPH_CLIENT_SECRET` | Client secret value from step 4 (secret) |
| `GRAPH_MAILBOX` | The one mailbox address from step 5, for example `banker@yourfirm.com` |

Restart the app after changing them.

## First sync

1. Sign in as an owner.
2. Check status: open `/api/capture/graph/status` in the browser. It shows
   whether capture is on and names any missing settings (never their
   values).
3. Run a sync: send a POST to `/api/capture/graph/sync` while signed in as
   an owner. The first run looks back 30 days. Later runs pick up where the
   last one stopped.
4. The reply lists how many emails and meetings were read, how many timeline
   entries were written, and how many items were skipped because no known
   contact was on them. Each run is written to the audit log as
   `capture.graph.sync`.
5. Open a contact you have emailed recently and check the timeline.

A single run reads at most 500 emails and 500 meetings. If there are more,
run it again and it continues from where it stopped.

## Turning it off

Set `GRAPH_CAPTURE_ENABLED` to anything other than `1` (or remove it) and
restart. To cut access completely, delete the client secret or the app
registration in Azure. Timeline entries already captured stay in Deal Desk.
