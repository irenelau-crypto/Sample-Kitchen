import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calculatePlan } from "../lib/calculate-plan.ts";
import { validateImport } from "../lib/import-validation.ts";

const read = (path) => JSON.parse(readFileSync(path, "utf8"));
const scenario = read("reference-data/scenario.json");
const productsAndRecipes = read("reference-data/products_and_recipes.json");
const inventory = read("current_inventory.json");
const staffMaster = read("HR_Staff_Master_2026-11.json");
const leave = read("HR_Leave_2026-11.json");
const availability = read("HR_Part_Time_Availability_2026-11.json");
const crmSource = readFileSync("CRM_Weekly_Sales_Orders_2026-10-28.csv", "utf8");
const productIds = new Set(productsAndRecipes.products.map((product) => product.id));
const crm = validateImport("CRM", crmSource, productIds);

const input = {
  scenario,
  orders: crm.records,
  products: productsAndRecipes.products,
  recipes: productsAndRecipes.recipes,
  inventory,
  staff: staffMaster.records,
  leave: leave.records,
  availability: availability.records,
};
const plan = calculatePlan(input);

assert.equal(plan.orderSummary.eligible_count, 15);
assert.equal(plan.orderSummary.excluded_count, 1);
assert.match(plan.orderSummary.excludedOrders[0].reasons.join(" "), /after the cutoff/);
assert.deepEqual(plan.dailyProduction.map((day) => day.totalSandwiches), [530, 1600, 1000, 700, 1450]);
assert.equal(plan.totalLabourHours, 105.6);
assert.deepEqual(plan.ingredientDemand, { BREAD: 10560, CHEESE: 55500, EGG: 82500, CHICKEN: 106800 });
assert.deepEqual(plan.stockRequest.map((item) => [item.ingredient_id, item.usable_stock, item.shortage, item.packs_to_request]), [
  ["BREAD", 10160, 400, 20],
  ["CHEESE", 54500, 1000, 2],
  ["EGG", 84000, 0, 0],
  ["CHICKEN", 105000, 1800, 2],
]);
assert.deepEqual(plan.roster.map((day) => [day.date, day.uncovered_hours, day.additional_part_time_shifts_to_request]), [
  ["2026-11-02", 0, 0],
  ["2026-11-03", 2, 1],
  ["2026-11-04", 0, 0],
  ["2026-11-05", 0, 0],
  ["2026-11-06", 0, 0],
]);
assert.ok(plan.roster.every((day) => day.supervisor_assigned));
assert.ok(plan.roster.every((day) => new Set(day.workers.map((worker) => worker.staff_id)).size === day.workers.length));
assert.equal(plan.roster.find((day) => day.date === "2026-11-03").workers.some((worker) => worker.staff_id === "S04"), false);
assert.equal(plan.roster.find((day) => day.date === "2026-11-06").workers.some((worker) => worker.staff_id === "S02"), false);
const noonOrders = crm.records.map((order) => order.id === "ORD-016" ? { ...order, received_at: "2026-10-28T12:00:00+08:00" } : order);
assert.equal(calculatePlan({ ...input, orders: noonOrders }).orderSummary.eligible_count, 16, "an order received exactly at noon is eligible");

console.log("PASS orders: 15 eligible, one post-cutoff exception");
console.log("PASS cutoff: an order received exactly at noon remains eligible");
console.log("PASS production and purchasing: five daily totals, 105.6 labour hours, whole-pack stock request");
console.log("PASS roster: supervisor daily, approved leave excluded, Tuesday 2-hour gap needs one shift request");
