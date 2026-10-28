import { prisma } from "@/lib/prisma";
import { calculatePlan, type PlanInput } from "@/lib/calculate-plan";

const requiredKinds = ["STOCK", "STAFF", "LEAVE", "AVAILABILITY", "CRM"] as const;
const referenceKeys = ["scenario", "products_and_recipes"] as const;

export class PlanUnavailableError extends Error {
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(message: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function records<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object" && "records" in payload && Array.isArray(payload.records)) return payload.records as T[];
  throw new Error("Saved import data has an unexpected shape.");
}

export async function loadPlanSnapshot() {
  const [referenceRows, savedImports] = await Promise.all([
    prisma.referenceData.findMany({ where: { key: { in: [...referenceKeys] } } }),
    prisma.importBatch.findMany({ where: { kind: { in: [...requiredKinds] } }, orderBy: { importedAt: "desc" } }),
  ]);
  const referenceByKey = new Map(referenceRows.map((row) => [row.key, row.value]));
  const missingReferences = referenceKeys.filter((key) => !referenceByKey.has(key));
  if (missingReferences.length) throw new PlanUnavailableError("Reference data is not seeded.", 503, { missingReferences });

  const latest = new Map<string, (typeof savedImports)[number]>();
  for (const saved of savedImports) if (!latest.has(saved.kind)) latest.set(saved.kind, saved);
  const missingImports = requiredKinds.filter((kind) => !latest.has(kind));
  if (missingImports.length) throw new PlanUnavailableError("Import all required stock, HR and CRM sources before calculating.", 409, { missingImports });

  const byKind = Object.fromEntries([...latest.entries()]);
  const scenario = referenceByKey.get("scenario") as PlanInput["scenario"];
  const recipes = referenceByKey.get("products_and_recipes") as { products: PlanInput["products"]; recipes: PlanInput["recipes"] };
  const inventory = records<PlanInput["inventory"][number]>(byKind.STOCK.payload);
  const staff = records<PlanInput["staff"][number]>(byKind.STAFF.payload);
  const leave = records<PlanInput["leave"][number]>(byKind.LEAVE.payload);
  const availability = records<PlanInput["availability"][number]>(byKind.AVAILABILITY.payload);
  const orders = records<PlanInput["orders"][number]>(byKind.CRM.payload);
  const plan = calculatePlan({
    scenario,
    products: recipes.products,
    recipes: recipes.recipes,
    inventory,
    staff,
    leave,
    availability,
    orders,
  });
  const ids = Object.fromEntries(requiredKinds.map((kind) => [kind, latest.get(kind)!.id]));
  const importedAt = Object.fromEntries(requiredKinds.map((kind) => [kind, latest.get(kind)!.importedAt]));
  const sources = requiredKinds.map((kind) => {
    const item = latest.get(kind)!;
    return {
      kind: item.kind,
      sourceName: item.sourceName,
      sourceSystem: item.sourceSystem,
      exportId: item.exportId,
      rowCount: item.rowCount,
      sourceTimestamp: item.sourceTimestamp,
      importedAt: item.importedAt,
    };
  });
  return {
    plan,
    sources,
    sourceContext: {
      approvedLeave: leave.filter((entry) => entry.status.toLowerCase() === "approved"),
      pendingLeave: leave.filter((entry) => entry.status.toLowerCase() === "pending"),
      confirmedAvailability: availability.filter((entry) => entry.status === "Confirmed"),
    },
    importVersion: {
      ids,
      importedAt,
      latestImportAt: new Date(Math.max(...Object.values(importedAt).map((date) => date.valueOf()))).toISOString(),
    },
  };
}
