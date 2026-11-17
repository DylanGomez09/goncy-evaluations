import { NextRequest, NextResponse } from "next/server";
import { getRun, deleteRun } from "@/lib/storage";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) return NextResponse.json({ error: "Run no encontrado." }, { status: 404 });
  return NextResponse.json({ run });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteRun(id);
  return NextResponse.json({ ok: true });
}
