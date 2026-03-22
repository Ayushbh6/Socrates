import { NextResponse } from "next/server";

import { fetchModels } from "@/lib/chat/backend";

export const dynamic = "force-dynamic";

export async function GET() {
  const models = await fetchModels();
  return NextResponse.json({ models });
}
