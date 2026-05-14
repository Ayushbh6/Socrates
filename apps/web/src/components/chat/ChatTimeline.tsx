export function ChatTimeline() {
  return (
    <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
      {/* Placeholder user message */}
      <div className="flex flex-col items-end">
        <div className="bg-gray-100 text-brand-text-dark px-4 py-3 rounded-2xl rounded-tr-sm max-w-2xl">
          <p>Hello, what can you help me with today?</p>
        </div>
      </div>
      
      {/* Placeholder assistant message */}
      <div className="flex flex-col items-start">
        <div className="bg-brand-bg text-brand-text-dark px-4 py-3 rounded-2xl rounded-tl-sm max-w-2xl border border-gray-200 shadow-sm">
          <p>I am Socrates. I can help you with coding, planning, and executing tasks in your workspace.</p>
        </div>
      </div>
    </div>
  );
}
