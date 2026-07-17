import { SeamlessProjectRoute } from "@/components/v2/SeamlessProjectRoute";

export default async function SeamlessProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <SeamlessProjectRoute key={projectId} projectId={projectId} />;
}
