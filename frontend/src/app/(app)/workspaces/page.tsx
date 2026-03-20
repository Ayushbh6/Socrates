import { LayoutGrid } from "lucide-react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function WorkspacesPage() {
  return (
    <div className="relative flex flex-1 flex-col gap-6 overflow-auto p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-[15%] -left-[8%] h-[50%] w-[55%] rounded-full bg-secondary-container/25 blur-[100px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-[10%] -bottom-[10%] h-[45%] w-[45%] rounded-full bg-primary/10 blur-[90px]"
      />
      <div className="relative z-10">
        <h1 className="font-heading text-on-surface text-2xl font-semibold tracking-wide">
          Workspaces
        </h1>
        <p className="text-on-surface-variant mt-1 max-w-lg text-sm leading-relaxed">
          Organize threads and context. This area is ready for your workspace
          list and creation flow.
        </p>
      </div>
      <div className="relative z-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {["Research", "Writing", "Code"].map((name) => (
          <Card
            key={name}
            className="border-border/50 bg-card/80 backdrop-blur-md transition-shadow duration-500 hover:shadow-[0_0_28px_rgb(114_220_255/0.08)]"
          >
            <CardHeader className="flex flex-row items-center gap-3 space-y-0">
              <div className="flex size-10 items-center justify-center rounded-lg border border-primary/15 bg-primary/5">
                <LayoutGrid className="text-primary size-5" />
              </div>
              <div>
                <CardTitle className="text-base">{name}</CardTitle>
                <CardDescription className="font-label text-[10px] tracking-widest uppercase">
                  Draft workspace
                </CardDescription>
              </div>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
