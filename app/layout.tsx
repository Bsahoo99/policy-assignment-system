import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { DualTimeControls } from "./components/DualTimeControls";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Policy Assignment System",
  description: "Deterministic, bi-temporal policy assignment engine",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-white text-gray-900`}
      >
        <nav className="border-b px-8 py-3 flex items-center justify-between text-sm font-medium">
          <div className="flex gap-6">
            <Link href="/" className="hover:underline">Employees</Link>
            <Link href="/rules" className="hover:underline">Rules</Link>
            <Link href="/groups" className="hover:underline">Groups</Link>
            <Link href="/audit" className="hover:underline">Audit</Link>
          </div>
          <Suspense fallback={null}>
            <DualTimeControls />
          </Suspense>
        </nav>
        {children}
      </body>
    </html>
  );
}
