export function ChatPanel() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto p-4 text-sm text-neutral-500">
        Chat panel - coming in M1.
      </div>
      <div className="border-t border-neutral-800 p-3">
        <div className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-600">
          Type a sentence about what you want to build...
        </div>
      </div>
    </div>
  );
}
