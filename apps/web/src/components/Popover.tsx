import { type ReactNode, useEffect, useRef } from "react";

/** A small floating menu that closes on Escape or a click elsewhere. */
export function Popover({ children, onClose, className, align, above }: { children: ReactNode; onClose: () => void; className?: string; align: "left" | "right"; above?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [onClose]);
  return (
    <div ref={ref} className={`popover ${className ?? ""}`} data-align={align} data-above={above ?? false} role="menu">
      {children}
    </div>
  );
}
