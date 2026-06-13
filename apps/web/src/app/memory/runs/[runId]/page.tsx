import { MemoryRunDetailPage } from "@/components/memory/MemoryRunDetailPage";

export default async function Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return <MemoryRunDetailPage runId={runId} />;
}
