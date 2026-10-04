import { type RefObject, useEffect, useRef } from "react";

const dialogs: HTMLElement[] = [];

/** Keep focus in the topmost dialog, close only it on Escape, then restore focus. */
export function useDialog(ref: RefObject<HTMLElement | null>, onClose: () => void, enabled = true) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!enabled || !dialog) return;
    const previous = document.activeElement;
    dialogs.push(dialog);
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
      .filter((el) => el.tabIndex >= 0 && !el.matches(":disabled") && el.getClientRects().length > 0);
    const focus = () => (focusable()[0] ?? dialog).focus();
    focus();
    const keys = (event: KeyboardEvent) => {
      if (dialogs.at(-1) !== dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
      } else if (event.key === "Tab") {
        const items = focusable();
        const index = items.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey ? index <= 0 : index < 0 || index === items.length - 1) {
          event.preventDefault();
          (event.shiftKey ? items.at(-1) ?? dialog : items[0] ?? dialog).focus();
        }
      }
    };
    const contain = (event: FocusEvent) => {
      if (dialogs.at(-1) === dialog && !dialog.contains(event.target as Node)) focus();
    };
    window.addEventListener("keydown", keys, true);
    document.addEventListener("focusin", contain);
    return () => {
      window.removeEventListener("keydown", keys, true);
      document.removeEventListener("focusin", contain);
      dialogs.splice(dialogs.indexOf(dialog), 1);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [ref, enabled]);
}
