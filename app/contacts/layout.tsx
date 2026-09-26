// Contacts section frame: one rail item; the people list and Referral sources
// are reached by the tab bar (sub-screens carry `parent: "/contacts"` in nav.ts).
import { currentUser } from "../lib/session";
import { sectionTabs } from "../lib/nav";
import SectionTabs from "../components/SectionTabs";

export default async function ContactsLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <>
      {user && <SectionTabs label="Contacts" tabs={sectionTabs("/contacts", user.role)} />}
      {children}
    </>
  );
}
