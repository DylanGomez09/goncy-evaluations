import { NextResponse } from "next/server";
import { getProviderInfo } from "@/lib/providers";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ providers: getProviderInfo() });
}
