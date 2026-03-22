"use client";

import { usePathname } from "next/navigation";
import { AppSidebar } from "@/components/app/app-sidebar";
import { ShellHeader } from "@/components/app/shell-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isChatRoute = pathname === "/chat" || pathname.startsWith("/chat/");

  return (
    <SidebarProvider defaultOpen>
      <AppSidebar />
      <SidebarInset className="flex h-svh min-h-svh flex-1 flex-col overflow-hidden">
        {isChatRoute ? null : <ShellHeader />}
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
