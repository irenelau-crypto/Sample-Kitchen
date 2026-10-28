import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireImportAccess } from "@/lib/import-auth";
import { hashUpload, IMPORT_KINDS, ImportValidationError, validateImport } from "@/lib/import-validation";

export const runtime = "nodejs";
const MAX_FILE_BYTES = 3_500_000;

export async function GET(request: NextRequest) {
  const denied = requireImportAccess(request);
  if (denied) return denied;

  try {
    const imports = await prisma.importBatch.findMany({
      orderBy: { importedAt: "desc" },
      select: { id: true, kind: true, exportId: true, sourceName: true, sourceSystem: true, sourceTimestamp: true, rowCount: true, importedAt: true },
    });
    return NextResponse.json({ imports });
  } catch {
    return NextResponse.json({ error: "Could not read saved imports. Check the server database connection." }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const denied = requireImportAccess(request);
  if (denied) return denied;

  let form: FormData;
  try { form = await request.formData(); }
  catch { return NextResponse.json({ error: "Send a multipart form with a file and import kind." }, { status: 400 }); }

  const kindValue = form.get("kind");
  const file = form.get("file");
  if (typeof kindValue !== "string" || !IMPORT_KINDS.includes(kindValue as (typeof IMPORT_KINDS)[number])) {
    return NextResponse.json({ error: "Choose STOCK, STAFF, LEAVE, AVAILABILITY or CRM." }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ error: "Choose a non-empty file." }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) return NextResponse.json({ error: "File is too large. Maximum upload size is 3.5 MB." }, { status: 413 });

  const kind = kindValue as (typeof IMPORT_KINDS)[number];
  const source = await file.text();
  const contentHash = hashUpload(source);
  try {
    const recipeReference = await prisma.referenceData.findUnique({ where: { key: "products_and_recipes" } });
    if (!recipeReference) return NextResponse.json({ error: "Reference data is not seeded. Complete application setup before importing." }, { status: 503 });
    const referenceValue = recipeReference.value as { products?: Array<{ id?: string }> };
    const knownProducts = new Set((referenceValue.products ?? []).flatMap((product) => product.id ? [product.id] : []));

    let staffIds = new Set<string>();
    if (kind === "LEAVE" || kind === "AVAILABILITY") {
      const staffImport = await prisma.importBatch.findFirst({ where: { kind: "STAFF" }, orderBy: { importedAt: "desc" } });
      if (!staffImport) return NextResponse.json({ error: "Import the staff master before leave or availability data." }, { status: 409 });
      const staffPayload = staffImport.payload as { records?: Array<{ id?: unknown }> };
      staffIds = new Set((staffPayload.records ?? []).flatMap((record) => typeof record.id === "string" ? [record.id] : []));
    }

    const validated = validateImport(kind, source, knownProducts, staffIds);
    const idempotencyKey = validated.exportId ? `export:${validated.exportId}` : `content:${contentHash}`;
    const existing = await prisma.importBatch.findUnique({ where: { kind_idempotencyKey: { kind, idempotencyKey } } });
    if (existing) {
      if (existing.contentHash !== contentHash) {
        return NextResponse.json({ error: `This ${kind} export ID was already imported with different contents. The saved import was left unchanged.` }, { status: 409 });
      }
      return NextResponse.json({ alreadyImported: true, message: "This exact export is already saved; no records were duplicated.", import: {
        id: existing.id, kind: existing.kind, exportId: existing.exportId, sourceName: existing.sourceName,
        sourceSystem: existing.sourceSystem, sourceTimestamp: existing.sourceTimestamp, rowCount: existing.rowCount, importedAt: existing.importedAt,
      } });
    }

    const saved = await prisma.importBatch.create({ data: {
      kind,
      exportId: validated.exportId,
      idempotencyKey,
      sourceName: file.name || `${kind.toLowerCase()}-upload`,
      sourceSystem: validated.sourceSystem,
      sourceTimestamp: validated.sourceTimestamp,
      rowCount: validated.rowCount,
      contentHash,
      payload: validated.payload as object,
    } });
    return NextResponse.json({ alreadyImported: false, message: "Import validated and saved.", import: {
      id: saved.id, kind: saved.kind, exportId: saved.exportId, sourceName: saved.sourceName,
      sourceSystem: saved.sourceSystem, sourceTimestamp: saved.sourceTimestamp, rowCount: saved.rowCount, importedAt: saved.importedAt,
    } }, { status: 201 });
  } catch (error) {
    if (error instanceof ImportValidationError) {
      return NextResponse.json({ error: "The file was rejected and no saved import was changed.", validationErrors: error.errors }, { status: 422 });
    }
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return NextResponse.json({ error: "This export was imported in another request. Refresh saved imports to see it." }, { status: 409 });
    }
    return NextResponse.json({ error: "Import could not be saved. Check the server database connection." }, { status: 503 });
  }
}
