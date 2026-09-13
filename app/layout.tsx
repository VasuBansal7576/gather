import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Gather",
  description: "Outcome-driven event booking operations",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
