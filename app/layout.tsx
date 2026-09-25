import type { Metadata } from "next";
import { Inter, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { firm } from "../firm.config";
import { currentUser } from "./lib/session";
import Shell from "./components/Shell";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-jakarta", display: "swap" });

export const metadata: Metadata = {
  title: firm.productName,
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en" className={`${inter.variable} ${jakarta.variable}`}>
      <body>{user ? <Shell user={user} demo={process.env.HARNESS_DEMO === "1"}>{children}</Shell> : children}</body>
    </html>
  );
}
