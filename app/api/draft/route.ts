import { NextRequest, NextResponse } from "next/server";
import { requireImportAccess } from "@/lib/import-auth";
import { prisma } from "@/lib/prisma";
import { loadPlanSnapshot } from "@/lib/plan-service";
import { createGmailDraft, isZapierMcpConfigured } from "@/lib/zapier-mcp";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const denied = requireImportAccess(request);
  if (denied) return denied;
  let body: { reviewed?: unknown };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Confirm that you reviewed the draft before continuing." }, { status: 400 }); }
  if (body.reviewed !== true) return NextResponse.json({ error: "Review and confirm the recipient, subject and body before creating a draft." }, { status: 400 });
  if (!isZapierMcpConfigured()) return NextResponse.json({ error: "Zapier MCP is not configured on the server. No draft was created." }, { status: 503 });
  try {
    const mcpUrl = new URL(process.env.ZAPIER_MCP_URL!);
    if (mcpUrl.protocol !== "https:") return NextResponse.json({ error: "Zapier MCP URL must use HTTPS. No draft was created." }, { status: 503 });
  } catch {
    return NextResponse.json({ error: "Zapier MCP URL is invalid. No draft was created." }, { status: 503 });
  }

  try {
    const snapshot = await loadPlanSnapshot();
    const ids = snapshot.importVersion.ids as Record<string, string>;
    const runs = await prisma.agentRun.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
    const run = runs.find((candidate) => {
      const version = candidate.importVersion as Record<string, string>;
      return Object.keys(ids).every((kind) => version[kind] === ids[kind]);
    });
    if (!run) return NextResponse.json({ error: "Run the planning agents for the current imports before creating a draft." }, { status: 409 });
    const existing = await prisma.draftAction.findUnique({ where: { agentRunId: run.id } });
    if (existing) return NextResponse.json({ error: existing.status === "CREATED" ? "A draft was already created for this agent run." : "A draft request is pending. Check Gmail Drafts and Zapier History before retrying." , draftAction: existing }, { status: 409 });

    const supplier = await prisma.referenceData.findUnique({ where: { key: "supplier" } });
    if (!supplier) return NextResponse.json({ error: "Supplier reference data is not seeded." }, { status: 503 });
    const supplierValue = supplier.value as { default_draft_to: string };
    const recommendations = run.recommendations as { purchasing?: { supplierDraftText?: unknown } };
    const draftText = recommendations.purchasing?.supplierDraftText;
    if (typeof draftText !== "string") return NextResponse.json({ error: "The saved Purchasing recommendation has no draft text." }, { status: 409 });
    const [toLine, subjectLine] = draftText.split("\n");
    const recipient = toLine?.startsWith("To: ") ? toLine.slice(4).trim() : "";
    const subject = subjectLine?.startsWith("Subject: ") ? subjectLine.slice(9).trim() : "";
    if (!recipient || recipient !== supplierValue.default_draft_to || !subject) {
      return NextResponse.json({ error: "Saved draft headers do not match the supplier reference. No draft was created." }, { status: 409 });
    }

    const pending = await prisma.draftAction.create({ data: { agentRunId: run.id, recipient, subject, status: "PENDING" } });
    try {
      const result = await createGmailDraft({ recipient, subject, body: draftText.split("\n").slice(2).join("\n") });
      const completed = await prisma.draftAction.update({ where: { id: pending.id }, data: { status: "CREATED", toolName: result.toolName, completedAt: new Date() } });
      return NextResponse.json({ message: "Zapier MCP completed the Gmail Create Draft call. Check Gmail Drafts to confirm it is present and unsent.", draftAction: completed }, { status: 201, headers: { "Cache-Control": "no-store" } });
    } catch {
      return NextResponse.json({ error: "The Zapier MCP draft request could not be confirmed. Check Gmail Drafts and Zapier History before retrying; this request is held to avoid a duplicate draft.", draftAction: pending }, { status: 502 });
    }
  } catch {
    return NextResponse.json({ error: "Could not prepare the draft from the current saved plan. No email was sent." }, { status: 503 });
  }
}
