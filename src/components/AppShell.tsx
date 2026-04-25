import { SessionSidebar } from "./SessionSidebar";
import { ChatPanel } from "./ChatPanel";
import { DocumentPanel } from "./DocumentPanel";

export function AppShell() {
  return (
    <div className="grid h-screen w-screen grid-cols-[260px_minmax(0,1fr)_minmax(0,1.4fr)] grid-rows-1 bg-neutral-950">
      <aside className="border-r border-neutral-800 overflow-y-auto">
        <SessionSidebar />
      </aside>
      <section className="border-r border-neutral-800 flex flex-col min-h-0">
        <ChatPanel />
      </section>
      <section className="flex flex-col min-h-0">
        <DocumentPanel />
      </section>
    </div>
  );
}
