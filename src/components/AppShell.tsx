"use client";

import { useEffect } from "react";
import { ChatPanel } from "./ChatPanel";
import { DocumentPanel } from "./DocumentPanel";
import { SessionSidebar } from "./SessionSidebar";
import { refreshSessionList } from "@/hooks/useSSE";

export function AppShell() {
  useEffect(() => {
    void refreshSessionList();
  }, []);

  return (
    <div className="grid h-screen w-screen grid-cols-[260px_minmax(0,1fr)_minmax(0,1.4fr)] grid-rows-1 bg-neutral-950">
      <aside className="border-r border-neutral-800 overflow-y-auto">
        <SessionSidebar />
      </aside>
      <section className="flex min-h-0 flex-col border-r border-neutral-800">
        <ChatPanel />
      </section>
      <section className="flex min-h-0 flex-col">
        <DocumentPanel />
      </section>
    </div>
  );
}
