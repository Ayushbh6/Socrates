import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/**
 * A small floating menu that closes on Escape or a click elsewhere. Given an
 * `anchor`, it is drawn in the page body (at `style`'s place) so a scrolling
 * or transformed parent cannot clip it; a click on the anchor is not "elsewhere".
 */
export function Popover({ children, onClose, className, align, above, style, anchor }: { children: ReactNode; onClose: () => void; className?: string; align: "left" | "right"; above?: boolean; style?: CSSProperties; anchor?: HTMLElement | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      const inside = anchor ? ref.current?.contains(target) || anchor.contains(target) : ref.current?.parentElement?.contains(target);
      if (ref.current && !inside) onClose();
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [onClose, anchor]);
  const menu = (
    <div ref={ref} className={`popover ${className ?? ""}`} data-align={align} data-above={above ?? false} role="menu" style={style}>
      {children}
    </div>
  );
  return anchor ? createPortal(menu, document.body) : menu;
}
