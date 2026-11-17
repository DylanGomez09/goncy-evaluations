import { NextRequest, NextResponse } from "next/server";
import { requeueFailed } from "@/lib/storage";

export const dynamic = "force-dynamic";

/** Re-encola proyectos en error (o 'running' huérfanos) como pendientes. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const requeued = await requeueFailed(id);
  return NextResponse.json({ requeued });
}
