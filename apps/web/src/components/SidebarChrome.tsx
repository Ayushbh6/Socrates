import { PanelLeft } from "lucide-react";

export function SidebarToggle({ open, sidebarId, onClick }: { open: boolean; sidebarId: string; onClick: () => void }) {
  const label = open ? "Hide the sidebar" : "Show the sidebar";
  return <button type="button" className="icon-button sidebar-toggle" onClick={onClick} aria-label={label} title={label} aria-expanded={open} aria-controls={sidebarId} data-on={open}><PanelLeft aria-hidden /></button>;
}

export function SidebarHeading({ sidebarId, onClose }: { sidebarId: string; onClose: () => void }) {
  return <div className="chat-sidebar-head"><span className="brand">Socrates</span><SidebarToggle open sidebarId={sidebarId} onClick={onClose} /></div>;
}
