"use client";

import { AppSidebar } from "@/components/app/app-sidebar";
import { ShellHeader } from "@/components/app/shell-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider defaultOpen>
      <AppSidebar />
      <SidebarInset className="flex min-h-svh flex-1 flex-col overflow-hidden">
        <ShellHeader />
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
