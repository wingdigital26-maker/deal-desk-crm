// Outbound section frame: one rail item, six screens reached by the tab bar.
import { currentUser } from "../lib/session";
import { sectionTabs } from "../lib/nav";
import SectionTabs from "../components/SectionTabs";

export default async function OutboundLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <>
      {user && <SectionTabs label="Outbound" tabs={sectionTabs("/outbound", user.role)} />}
      {children}
    </>
  );
}
