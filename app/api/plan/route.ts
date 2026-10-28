import { NextRequest, NextResponse } from "next/server";
import { requireImportAccess } from "@/lib/import-auth";
import { loadPlanSnapshot, PlanUnavailableError } from "@/lib/plan-service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const denied = requireImportAccess(request);
  if (denied) return denied;

  try {
    const { plan, importVersion, sources } = await loadPlanSnapshot();
    return NextResponse.json({ plan, importVersion, sources }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlanUnavailableError) {
      return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
    }
    return NextResponse.json({ error: "The saved plan could not be calculated. Check imported data and the database connection." }, { status: 503 });
  }
}
