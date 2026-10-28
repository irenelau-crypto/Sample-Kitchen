import { NextRequest, NextResponse } from "next/server";
import { requireImportAccess } from "@/lib/import-auth";
import { prisma } from "@/lib/prisma";
import { loadPlanSnapshot } from "@/lib/plan-service";
import { runPlanningAgents } from "@/lib/planning-agents";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  const denied = requireImportAccess(request);
  if (denied) return denied;

  let snapshot;
  try { snapshot = await loadPlanSnapshot(); }
  catch {
    return NextResponse.json({ error: "The numeric plan is unavailable because required imports or database access are missing." }, { status: 503 });
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured on the server. The calculated plan is still available.", plan: snapshot.plan, importVersion: snapshot.importVersion }, { status: 503 });
  }

  try {
    const supplierReference = await prisma.referenceData.findUnique({ where: { key: "supplier" } });
    if (!supplierReference) return NextResponse.json({ error: "Supplier reference data is not seeded. The calculated plan is still available.", plan: snapshot.plan, importVersion: snapshot.importVersion }, { status: 503 });
    const supplier = supplierReference.value as { display_name: string; default_draft_to: string };
    const result = await runPlanningAgents(snapshot, supplier);
    const saved = await prisma.agentRun.create({ data: {
      model: result.model,
      importVersion: snapshot.importVersion.ids as object,
      recommendations: result.recommendations as object,
      handoffTrace: result.handoffTrace as object,
    } });
    return NextResponse.json({
      id: saved.id,
      model: saved.model,
      createdAt: saved.createdAt,
      importVersion: snapshot.importVersion,
      plan: snapshot.plan,
      recommendations: result.recommendations,
      handoffTrace: result.handoffTrace,
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent run failed.";
    return NextResponse.json({ error: `Planning agents failed: ${message} The calculated plan is still available.`, plan: snapshot.plan, importVersion: snapshot.importVersion }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
