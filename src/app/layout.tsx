import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PRD-Builder",
  description: "Turn one sentence into a clickable wireframe",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100 antialiased">{children}</body>
    </html>
  );
}
