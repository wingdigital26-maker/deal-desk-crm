// Contacts CSV import: column guessing for any list, with Outlook and Google
// Contacts exports recognised by their headers. Pure module, safe in the browser.

export const CONTACT_TARGET_FIELDS: { key: ContactField; label: string }[] = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  { key: "title", label: "Title" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "mobile_phone", label: "Mobile (if no phone)" },
  { key: "linkedin_url", label: "LinkedIn URL" },
  { key: "company_name", label: "Company name" },
  { key: "company_domain", label: "Company domain" },
];

export type ContactField =
  | "first_name"
  | "last_name"
  | "title"
  | "email"
  | "phone"
  | "mobile_phone"
  | "linkedin_url"
  | "company_name"
  | "company_domain";

export type ContactSource = "outlook" | "google" | null;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Aliases in priority order. Outlook's "Title" is the honorific (Mr., Ms.), so
// "Job Title" must win over it; Google's newer export uses "Organization Title".
const ALIASES: Record<ContactField, string[]> = {
  first_name: ["firstname", "givenname", "first"],
  last_name: ["lastname", "familyname", "surname", "last"],
  title: ["jobtitle", "organization1title", "organizationtitle", "position", "title"],
  email: ["emailaddress", "email1value", "email", "workemail", "primaryemail", "email1"],
  phone: ["businessphone", "phone1value", "phone", "phonenumber", "workphone", "primaryphone", "companymainphone", "businessphone2"],
  mobile_phone: ["mobilephone", "mobile", "cellphone", "cell", "phone2value"],
  linkedin_url: ["linkedin", "linkedinurl", "linkedinprofile"],
  company_name: ["company", "companyname", "organization1name", "organizationname", "organization", "org"],
  company_domain: ["domain", "companydomain", "website"],
};

/** "outlook" for an Outlook CSV export, "google" for Google Contacts, else null. */
export function detectContactSource(headers: string[]): ContactSource {
  const h = new Set(headers.map(norm));
  if (h.has("emailaddress") && (h.has("businessphone") || h.has("mobilephone") || h.has("jobtitle")) && h.has("firstname")) return "outlook";
  if (h.has("email1value") || h.has("organization1name") || h.has("organizationname") || (h.has("givenname") && h.has("familyname"))) return "google";
  return null;
}

export const CONTACT_SOURCE_LABELS: Record<Exclude<ContactSource, null>, string> = {
  outlook: "Outlook export",
  google: "Google Contacts export",
};

/**
 * CRM field -> CSV header. Aliases are tried in priority order and each
 * header feeds one field at most. Google's "Phone 1 - Value" goes to phone,
 * so "Phone 2 - Value" only lands in the mobile fallback.
 */
export function guessContactMapping(headers: string[]): Partial<Record<ContactField, string>> {
  const mapping: Partial<Record<ContactField, string>> = {};
  const used = new Set<string>();
  const n = headers.map(norm);
  for (const field of Object.keys(ALIASES) as ContactField[]) {
    for (const alias of ALIASES[field]) {
      const i = n.findIndex((h, idx) => h === alias && !used.has(headers[idx]));
      if (i >= 0) {
        mapping[field] = headers[i];
        used.add(headers[i]);
        break;
      }
    }
  }
  return mapping;
}
