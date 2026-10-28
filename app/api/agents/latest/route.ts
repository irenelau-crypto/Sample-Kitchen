import { NextRequest, NextResponse } from "next/server";
import { requireImportAccess } from "@/lib/import-auth";
import { prisma } from "@/lib/prisma";
import { loadPlanSnapshot } from "@/lib/plan-service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const denied = requireImportAccess(request);
  if (denied) return denied;
  try {
    const snapshot = await loadPlanSnapshot();
    const currentIds = snapshot.importVersion.ids as Record<string, string>;
    const runs = await prisma.agentRun.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
    const latest = runs.find((run) => {
      const version = run.importVersion as Record<string, string>;
      return Object.keys(currentIds).every((kind) => version[kind] === currentIds[kind]);
    });
    if (!latest) return NextResponse.json({ run: null, draftAction: null, message: "No saved agent run matches the current imports." }, { headers: { "Cache-Control": "no-store" } });
    const draftAction = await prisma.draftAction.findUnique({ where: { agentRunId: latest.id } });
    return NextResponse.json({ run: latest, draftAction }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load saved recommendations. Check the database connection." }, { status: 503 });
  }
}
