export function ChatComposer() {
  return (
    <div className="p-4 bg-white border-t border-gray-200">
      <div className="max-w-3xl mx-auto relative">
        <textarea 
          className="w-full bg-brand-bg border border-gray-200 rounded-xl pl-4 pr-12 py-3 outline-none focus:border-brand-teal-dark resize-none h-14"
          placeholder="Message Socrates..."
        />
        <button className="absolute right-2 top-2 bottom-2 w-10 bg-brand-button text-white rounded-lg flex items-center justify-center hover:bg-opacity-90">
          ↑
        </button>
      </div>
    </div>
  );
}
