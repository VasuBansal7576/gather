import type { Metadata } from "next";
import "./globals.css";
import { ModeBadge } from "./setup/mode-badge.tsx";

export const metadata: Metadata = {
  title: "Gather",
  description: "Outcome-driven event booking operations",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <ModeBadge />
        {children}
      </body>
    </html>
  );
}
