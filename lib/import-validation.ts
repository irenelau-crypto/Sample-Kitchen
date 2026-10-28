import { createHash } from "node:crypto";

export const IMPORT_KINDS = ["STOCK", "STAFF", "LEAVE", "AVAILABILITY", "CRM"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export class ImportValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super("The uploaded file failed validation.");
    this.errors = errors;
  }
}

export type ValidatedImport = {
  payload: unknown;
  records: unknown[];
  exportId: string | null;
  sourceSystem: string | null;
  sourceTimestamp: Date | null;
  rowCount: number;
};

const CRM_HEADERS = [
  "export_id", "exported_at", "export_status", "id", "production_date",
  "customer", "product_id", "quantity", "status", "received_at",
];

function object(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImportValidationError([`${at} must be an object.`]);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, at: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ImportValidationError([`${at} must be a non-empty string.`]);
  }
  return value.trim();
}

function number(value: unknown, at: string, allowZero = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (!allowZero && value <= 0)) {
    throw new ImportValidationError([`${at} must be a ${allowZero ? "non-negative" : "positive"} number.`]);
  }
  return value;
}

export function validDate(value: unknown, at: string): string {
  const raw = text(value, at);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new ImportValidationError([`${at} must use YYYY-MM-DD.`]);
  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== raw) {
    throw new ImportValidationError([`${at} is not a valid calendar date.`]);
  }
  return raw;
}

function zonedDateTime(value: unknown, at: string): Date {
  const raw = text(value, at);
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new ImportValidationError([`${at} must be a valid ISO date-time with a time zone.`]);
  }
  return new Date(raw);
}

function unique(values: string[], at: string) {
  if (new Set(values).size !== values.length) throw new ImportValidationError([`${at} must not contain duplicates.`]);
}

function parseJson(source: string): unknown {
  try { return JSON.parse(source); }
  catch { throw new ImportValidationError(["File must contain valid JSON."]); }
}

function envelope(source: string, label: string) {
  const parsed = object(parseJson(source), "file");
  const sourceSystem = text(parsed.source_system, "source_system");
  const exportId = text(parsed.export_id, "export_id");
  const exportedAt = zonedDateTime(parsed.exported_at, "exported_at");
  text(parsed.effective_month, "effective_month");
  if (!/^\d{4}-\d{2}$/.test(parsed.effective_month as string)) {
    throw new ImportValidationError(["effective_month must use YYYY-MM."]);
  }
  if (!Array.isArray(parsed.records)) throw new ImportValidationError(["records must be an array."]);
  return { parsed, sourceSystem, exportId, exportedAt, records: parsed.records, label };
}

function validateStock(source: string): ValidatedImport {
  const rows = parseJson(source);
  if (!Array.isArray(rows) || rows.length === 0) throw new ImportValidationError(["Stock file must be a non-empty array."]);
  const checkedAt: Date[] = [];
  const ids = rows.map((item, index) => {
    const row = object(item, `stock row ${index + 1}`);
    text(row.name, `stock row ${index + 1} name`);
    text(row.unit, `stock row ${index + 1} unit`);
    number(row.on_hand, `stock row ${index + 1} on_hand`);
    number(row.committed, `stock row ${index + 1} committed`);
    number(row.pack_size, `stock row ${index + 1} pack_size`, false);
    text(row.pack_name, `stock row ${index + 1} pack_name`);
    checkedAt.push(zonedDateTime(row.checked_at, `stock row ${index + 1} checked_at`));
    return text(row.ingredient_id, `stock row ${index + 1} ingredient_id`);
  });
  unique(ids, "ingredient_id");
  if (checkedAt.some((date) => date.valueOf() !== checkedAt[0].valueOf())) {
    throw new ImportValidationError(["All stock rows must have the same checked_at time."]);
  }
  return { payload: rows, records: rows, exportId: null, sourceSystem: "Physical stock count", sourceTimestamp: checkedAt[0], rowCount: rows.length };
}

function validateStaff(source: string): ValidatedImport {
  const data = envelope(source, "staff master");
  const ids = data.records.map((item, index) => {
    const row = object(item, `staff row ${index + 1}`);
    const id = text(row.id, `staff row ${index + 1} id`);
    text(row.name, `staff ${id} name`);
    const employment = text(row.employment_type, `staff ${id} employment_type`);
    if (employment !== "Permanent" && employment !== "Part-time") throw new ImportValidationError([`staff ${id} employment_type must be Permanent or Part-time.`]);
    text(row.role, `staff ${id} role`);
    if (!Array.isArray(row.skills) || row.skills.some((skill) => typeof skill !== "string" || !skill.trim())) {
      throw new ImportValidationError([`staff ${id} skills must be an array of non-empty strings.`]);
    }
    return id;
  });
  unique(ids, "staff IDs");
  return { payload: data.parsed, records: data.records, exportId: data.exportId, sourceSystem: data.sourceSystem, sourceTimestamp: data.exportedAt, rowCount: data.records.length };
}

function validateLeave(source: string, staffIds: Set<string>): ValidatedImport {
  const data = envelope(source, "leave export");
  const ids: string[] = [];
  for (const [index, item] of data.records.entries()) {
    const row = object(item, `leave row ${index + 1}`);
    const id = text(row.id, `leave row ${index + 1} id`);
    ids.push(id);
    const staffId = text(row.staff_id, `leave ${id} staff_id`);
    if (!staffIds.has(staffId)) throw new ImportValidationError([`leave ${id} references unknown staff ID ${staffId}. Import the staff master first.`]);
    validDate(row.date, `leave ${id} date`);
    if (!["Approved", "Pending", "Rejected"].includes(text(row.status, `leave ${id} status`))) {
      throw new ImportValidationError([`leave ${id} status must be Approved, Pending or Rejected.`]);
    }
    text(row.reason, `leave ${id} reason`);
  }
  unique(ids, "leave IDs");
  return { payload: data.parsed, records: data.records, exportId: data.exportId, sourceSystem: data.sourceSystem, sourceTimestamp: data.exportedAt, rowCount: data.records.length };
}

function validateAvailability(source: string, staffIds: Set<string>): ValidatedImport {
  const data = envelope(source, "part-time availability export");
  const keys: string[] = [];
  for (const [index, item] of data.records.entries()) {
    const row = object(item, `availability row ${index + 1}`);
    const staffId = text(row.staff_id, `availability row ${index + 1} staff_id`);
    if (!staffIds.has(staffId)) throw new ImportValidationError([`Availability references unknown staff ID ${staffId}. Import the staff master first.`]);
    const date = validDate(row.date, `availability row ${index + 1} date`);
    const start = text(row.start, `availability ${staffId} start`);
    const end = text(row.end, `availability ${staffId} end`);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || start >= end) {
      throw new ImportValidationError([`Availability for ${staffId} on ${date} must have valid increasing 24-hour start and end times.`]);
    }
    if (text(row.status, `availability ${staffId} status`) !== "Confirmed") {
      throw new ImportValidationError([`Availability for ${staffId} on ${date} must have Confirmed status.`]);
    }
    keys.push(`${staffId}:${date}`);
  }
  unique(keys, "staff/date availability pairs");
  return { payload: data.parsed, records: data.records, exportId: data.exportId, sourceSystem: data.sourceSystem, sourceTimestamp: data.exportedAt, rowCount: data.records.length };
}

function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
    } else field += char;
  }
  if (quoted) throw new ImportValidationError(["CSV contains an unterminated quoted field."]);
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function validateCrm(source: string, knownProducts: Set<string>): ValidatedImport {
  const rows = parseCsv(source);
  if (rows.length < 2) throw new ImportValidationError(["CRM CSV must include a header and at least one order row."]);
  const headers = rows[0].map((header) => header.trim().replace(/^\uFEFF/, ""));
  if (new Set(headers).size !== headers.length) throw new ImportValidationError(["CRM CSV contains duplicate column names."]);
  const missing = CRM_HEADERS.filter((header) => !headers.includes(header));
  const extra = headers.filter((header) => !CRM_HEADERS.includes(header));
  if (missing.length || extra.length) {
    throw new ImportValidationError([`CRM columns must match the expected schema. Missing: ${missing.join(", ") || "none"}. Unexpected: ${extra.join(", ") || "none"}.`]);
  }
  const index = Object.fromEntries(headers.map((header, i) => [header, i]));
  const records = rows.slice(1).map((cells, i) => {
    if (cells.length !== headers.length) throw new ImportValidationError([`CRM row ${i + 2} has ${cells.length} values; expected ${headers.length}.`]);
    const record = Object.fromEntries(headers.map((header) => [header, cells[index[header]].trim()]));
    for (const key of headers) text(record[key], `CRM row ${i + 2} ${key}`);
    return record;
  });
  const ids: string[] = [];
  const exportIds = new Set<string>();
  const exportedAtValues = new Set<string>();
  for (const [i, value] of records.entries()) {
    const row = value as Record<string, string>;
    const line = i + 2;
    ids.push(row.id);
    exportIds.add(row.export_id);
    exportedAtValues.add(row.exported_at);
    zonedDateTime(row.exported_at, `CRM row ${line} exported_at`);
    validDate(row.production_date, `CRM row ${line} production_date`);
    zonedDateTime(row.received_at, `CRM row ${line} received_at`);
    if (!knownProducts.has(row.product_id)) throw new ImportValidationError([`CRM row ${line} uses unknown product_id ${row.product_id}.`]);
    const quantity = Number(row.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) throw new ImportValidationError([`CRM row ${line} quantity must be a positive integer.`]);
  }
  unique(ids, "CRM order IDs");
  if (exportIds.size !== 1) throw new ImportValidationError(["All CRM rows must have the same export_id."]);
  if (exportedAtValues.size !== 1) throw new ImportValidationError(["All CRM rows must have the same exported_at value."]);
  return {
    payload: { export_id: records[0].export_id, exported_at: records[0].exported_at, export_status: records[0].export_status, records },
    records,
    exportId: records[0].export_id,
    sourceSystem: "CRM weekly export",
    sourceTimestamp: zonedDateTime(records[0].exported_at, "exported_at"),
    rowCount: records.length,
  };
}

export function validateImport(kind: ImportKind, source: string, knownProducts: Set<string>, staffIds = new Set<string>()): ValidatedImport {
  switch (kind) {
    case "STOCK": return validateStock(source);
    case "STAFF": return validateStaff(source);
    case "LEAVE": return validateLeave(source, staffIds);
    case "AVAILABILITY": return validateAvailability(source, staffIds);
    case "CRM": return validateCrm(source, knownProducts);
  }
}

export function hashUpload(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}
