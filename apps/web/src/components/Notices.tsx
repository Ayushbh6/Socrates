import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { type AppState, store } from "../lib/store";

/** Short notices at the top, such as a lane finishing; they fade after a while. */
export function Notices({ app }: { app: AppState }) {
  const ids = app.model.notices.map((n) => n.id).join(",");
  useEffect(() => {
    if (!ids) return;
    const timers = app.model.notices.map((n) => setTimeout(() => store.dismiss(n.id), 8_000));
    return () => timers.forEach(clearTimeout);
  }, [ids]);
  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence>
        {app.model.notices.map((n) => (
          <motion.div key={n.id} className="toast" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
            <span>{n.text}</span>
            <button type="button" className="icon-button" onClick={() => store.dismiss(n.id)} aria-label="Dismiss"><X aria-hidden /></button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
