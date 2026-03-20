import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function ProfilePage() {
  return (
    <div className="relative flex flex-1 flex-col items-center overflow-auto p-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgb(114_220_255/0.12),transparent_55%)]"
      />
      <Card className="border-border/50 bg-card/90 relative z-10 w-full max-w-md backdrop-blur-md">
        <CardHeader className="flex flex-row items-center gap-4 space-y-0">
          <Avatar className="size-14 border border-primary/20">
            <AvatarFallback className="bg-surface-container-high text-on-surface font-heading text-lg">
              PC
            </AvatarFallback>
          </Avatar>
          <div>
            <CardTitle className="text-on-surface">PremChat user</CardTitle>
            <CardDescription className="font-label text-[10px] tracking-[0.12em] uppercase">
              Neural profile
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="text-on-surface-variant text-sm leading-relaxed">
          <p>
            Account details and preferences will live here. Avatar uses
            initials only—no external image URLs.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
