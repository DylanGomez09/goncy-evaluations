import { NextRequest, NextResponse } from "next/server";
import { tick } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
// Hobby plan capea a 60s; Pro permite más
export const maxDuration = 60;

/**
 * Procesa UN proyecto pendiente del run. El cliente la llama en loop
 * (2 en paralelo si hay 2 IAs) hasta que `status` sea "done".
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await tick(id);
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
