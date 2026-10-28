import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculatePlan } from "../lib/calculate-plan.ts";
import { validateImport } from "../lib/import-validation.ts";
import { runPlanningAgents } from "../lib/planning-agents.ts";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const scenario = read("reference-data/scenario.json");
const catalog = read("reference-data/products_and_recipes.json");
const staff = read("HR_Staff_Master_2026-11.json").records;
const leave = read("HR_Leave_2026-11.json").records;
const availability = read("HR_Part_Time_Availability_2026-11.json").records;
const productIds = new Set(catalog.products.map((product) => product.id));
const orders = validateImport("CRM", readFileSync("CRM_Weekly_Sales_Orders_2026-10-28.csv", "utf8"), productIds).records;
const plan = calculatePlan({ scenario, orders, products: catalog.products, recipes: catalog.recipes, inventory: read("current_inventory.json"), staff, leave, availability });
const snapshot = {
  plan,
  importVersion: { ids: { STOCK: "stock-v1", STAFF: "staff-v1", LEAVE: "leave-v1", AVAILABILITY: "availability-v1", CRM: "crm-v1" } },
  sourceContext: { approvedLeave: leave.filter((entry) => entry.status === "Approved"), pendingLeave: [], confirmedAvailability: availability },
};
const baselinePlan = JSON.stringify(snapshot.plan);
const salesResponse = {
  summary: "The plan includes orders received by the cutoff and keeps the late order for review.",
  lateExceptionExplanation: "One order arrived after the stated cutoff and is excluded from the baseline.",
  datedActions: [{ date: "2026-11-02", action: "Review Monday's production list before the shift." }],
};
const gapDates = plan.roster.filter((day) => day.uncovered_hours > 0).map((day) => day.date);
const shortageIds = plan.stockRequest.filter((item) => item.shortage > 0).map((item) => item.ingredient_id);
const calls = [];
const caller = async (role, _instructions, input) => {
  calls.push(role);
  if (role === "sales_production") return salesResponse;
  assert.deepEqual(input.salesResult, salesResponse);
  if (role === "manpower") return { gapExplanation: "Approved leave and available shifts leave a coverage gap.", coverRequestDates: gapDates, managerAction: "Ask the manager to review a part-time cover request." };
  return {
    shortageExplanation: "Several ingredients need a supplier request based on usable stock.",
    itemReasons: shortageIds.map((ingredientId) => ({ ingredientId, reason: "Calculated demand exceeds usable stock." })),
    supplierDraftNote: "Please review the listed ingredients and confirm delivery availability.",
  };
};

const result = await runPlanningAgents(snapshot, { display_name: "Training supplier", default_draft_to: "redmartorder@gmail.com" }, caller);
assert.deepEqual(calls, ["sales_production", "manpower", "purchasing"]);
assert.equal(result.handoffTrace.length, 3);
assert.deepEqual(result.recommendations.manpower.coverRequestDates, gapDates);
assert.deepEqual(result.recommendations.purchasing.itemReasons.map((item) => item.ingredientId).sort(), shortageIds.sort());
assert.match(result.recommendations.purchasing.supplierDraftText, /To: redmartorder@gmail.com/);
assert.match(result.recommendations.purchasing.supplierDraftText, /20 x 20-slice loaf \(400 slice\)/);
assert.match(result.recommendations.purchasing.supplierDraftText, /No order has been placed/);
assert.equal(JSON.stringify(snapshot.plan), baselinePlan, "agent recommendations must not mutate the verified calculations");

let mismatchRejected = false;
try {
  await runPlanningAgents(snapshot, { display_name: "Training supplier", default_draft_to: "redmartorder@gmail.com" }, async (role, instructions, input, schema) => {
    if (role === "manpower") return { gapExplanation: "Gap", coverRequestDates: [], managerAction: "Ask for review." };
    return caller(role, instructions, input, schema);
  });
} catch (error) {
  mismatchRejected = error instanceof Error && /do not match the calculated uncovered shifts/.test(error.message);
}
assert.equal(mismatchRejected, true, "manpower date recommendations must be checked against calculated gaps");

console.log("PASS specialist sequence: Sales first; Manpower and Purchasing receive the Sales result");
console.log("PASS output validation: cover dates and shortage ingredient IDs match deterministic results");
console.log("PASS draft: recipient and whole-pack quantities come from the verified plan");
console.log("PASS isolation: agent recommendations do not mutate calculated values");
