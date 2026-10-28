import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hashUpload, ImportValidationError, validateImport } from "../lib/import-validation.ts";

const root = resolve(import.meta.dirname, "..");
const read = async (name) => readFile(resolve(root, name), "utf8");
const stock = await read("current_inventory.json");
const staff = await read("HR_Staff_Master_2026-11.json");
const leave = await read("HR_Leave_2026-11.json");
const availability = await read("HR_Part_Time_Availability_2026-11.json");
const crm = await read("CRM_Weekly_Sales_Orders_2026-10-28.csv");
const recipeData = JSON.parse(await read("reference-data/products_and_recipes.json"));
const productIds = new Set(recipeData.products.map((product) => product.id));

const staffRows = validateImport("STAFF", staff, productIds);
const staffIds = new Set(staffRows.records.map((person) => person.id));
const accepted = [
  ["STOCK", stock, 4],
  ["STAFF", staff, 7],
  ["LEAVE", leave, 2],
  ["AVAILABILITY", availability, 6],
  ["CRM", crm, 16],
];

for (const [kind, source, expectedRows] of accepted) {
  const result = validateImport(kind, source, productIds, staffIds);
  assert.equal(result.rowCount, expectedRows, `${kind} row count`);
  assert.equal(result.records.length, expectedRows, `${kind} persisted payload rows`);
}

const rejects = (kind, source, pattern, ids = staffIds) => {
  assert.throws(
    () => validateImport(kind, source, productIds, ids),
    (error) => error instanceof ImportValidationError && error.errors.some((message) => pattern.test(message)),
    `${kind} invalid fixture should be rejected with ${pattern}`,
  );
};

const duplicateCrmId = crm.replace("ORD-001", "ORD-002");
rejects("CRM", duplicateCrmId, /CRM order IDs must not contain duplicates/);
const unknownStaff = leave.replace('"staff_id": "S04"', '"staff_id": "S99"');
rejects("LEAVE", unknownStaff, /unknown staff ID S99/);
const changedCsv = `${crm}\n`;
assert.equal(hashUpload(crm), hashUpload(crm), "same uploaded bytes have a stable content hash");
assert.notEqual(hashUpload(crm), hashUpload(changedCsv), "changed uploaded bytes have a different content hash");

console.log("Import validation passed: STOCK 4, STAFF 7, LEAVE 2, AVAILABILITY 6, CRM 16.");
console.log("Rejection checks passed: duplicate CRM order ID and leave row referencing unknown staff.");
console.log("Idempotency input check passed: identical content hashes match; changed content hashes differ.");
