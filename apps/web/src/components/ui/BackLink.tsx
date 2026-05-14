import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-2 text-sm text-brand-text-light hover:text-brand-text-dark transition-colors mb-6 group">
      <ArrowLeft className="size-4 group-hover:-translate-x-1 transition-transform" />
      {label}
    </Link>
  );
}
