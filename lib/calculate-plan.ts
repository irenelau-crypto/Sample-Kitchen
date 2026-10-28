export type Scenario = {
  timezone: string;
  order_cutoff: string;
  week_start: string;
  week_end: string;
  settings: {
    permanent_shift_start: string;
    permanent_shift_end: string;
    permanent_productive_hours: number;
    part_time_productive_hours: number;
    max_shifts_per_person_per_day: number;
  };
};

type Order = {
  id: string;
  production_date: string;
  customer: string;
  product_id: string;
  quantity: number | string;
  status: string;
  received_at: string;
};

type Product = { id: string; name: string; labour_hours_per_unit: number };
type Recipe = { product_id: string; ingredient_id: string; quantity_per_unit: number };
type Inventory = {
  ingredient_id: string;
  name: string;
  unit: string;
  on_hand: number;
  committed: number;
  pack_size: number;
  pack_name: string;
};
type Staff = {
  id: string;
  name: string;
  employment_type: string;
  role: string;
  skills: string[];
};
type Leave = { staff_id: string; date: string; status: string; reason: string };
type Availability = { staff_id: string; date: string; start: string; end: string; status: string };

export type PlanInput = {
  scenario: Scenario;
  orders: Order[];
  products: Product[];
  recipes: Recipe[];
  inventory: Inventory[];
  staff: Staff[];
  leave: Leave[];
  availability: Availability[];
};

function dateRange(start: string, end: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(cursor.valueOf()) || Number.isNaN(last.valueOf()) || cursor > last) throw new Error("Scenario week dates are invalid.");
  while (cursor <= last) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function wholeNumber(value: number | string, at: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${at} must be a positive whole number.`);
  return parsed;
}

function staffNameOrder(a: Staff, b: Staff): number {
  return a.name.localeCompare(b.name, "en");
}

export function calculatePlan(input: PlanInput) {
  const { scenario, orders, products, recipes, inventory, staff, leave, availability } = input;
  const days = dateRange(scenario.week_start, scenario.week_end);
  const productById = new Map(products.map((product) => [product.id, product]));
  const recipesByProduct = new Map<string, Recipe[]>();
  for (const recipe of recipes) recipesByProduct.set(recipe.product_id, [...(recipesByProduct.get(recipe.product_id) ?? []), recipe]);

  const eligibleOrders: Array<Order & { quantity: number }> = [];
  const excludedOrders: Array<Order & { quantity: number; reasons: string[] }> = [];
  const cutoff = Date.parse(scenario.order_cutoff);
  if (!Number.isFinite(cutoff)) throw new Error("Scenario order cutoff is invalid.");
  const orderIds = new Set<string>();
  for (const order of orders) {
    if (orderIds.has(order.id)) throw new Error(`Duplicate CRM order ID: ${order.id}.`);
    orderIds.add(order.id);
    const quantity = wholeNumber(order.quantity, `Order ${order.id} quantity`);
    if (!productById.has(order.product_id)) throw new Error(`Order ${order.id} uses unknown product ${order.product_id}.`);
    if (!Number.isFinite(Date.parse(order.received_at))) throw new Error(`Order ${order.id} has an invalid received_at time.`);
    const reasons: string[] = [];
    if (order.status.trim().toLowerCase() !== "confirmed") reasons.push(`Status is ${order.status}; only confirmed orders enter the plan.`);
    if (!days.includes(order.production_date)) reasons.push(`Production date ${order.production_date} is outside the planning week.`);
    if (Date.parse(order.received_at) > cutoff) reasons.push(`Received after the cutoff ${scenario.order_cutoff}.`);
    if (reasons.length) excludedOrders.push({ ...order, quantity, reasons });
    else eligibleOrders.push({ ...order, quantity });
  }

  const dailyProduction = days.map((date) => {
    const byProduct = Object.fromEntries(products.map((product) => [product.id, 0])) as Record<string, number>;
    let totalSandwiches = 0;
    let labourHours = 0;
    for (const order of eligibleOrders) {
      if (order.production_date !== date) continue;
      byProduct[order.product_id] += order.quantity;
      totalSandwiches += order.quantity;
      labourHours += order.quantity * productById.get(order.product_id)!.labour_hours_per_unit;
    }
    return { date, byProduct, totalSandwiches, labourHours: round(labourHours, 2) };
  });

  const ingredientDemand = new Map<string, number>();
  for (const order of eligibleOrders) {
    for (const recipe of recipesByProduct.get(order.product_id) ?? []) {
      ingredientDemand.set(recipe.ingredient_id, (ingredientDemand.get(recipe.ingredient_id) ?? 0) + order.quantity * recipe.quantity_per_unit);
    }
  }
  const inventoryIds = new Set(inventory.map((item) => item.ingredient_id));
  for (const ingredientId of ingredientDemand.keys()) {
    if (!inventoryIds.has(ingredientId)) throw new Error(`Stock count is missing ingredient ${ingredientId}.`);
  }
  const stockRequest = inventory.map((item) => {
    const demand = ingredientDemand.get(item.ingredient_id) ?? 0;
    const usableStock = item.on_hand - item.committed;
    const shortage = Math.max(0, demand - usableStock);
    const packs = Math.ceil(shortage / item.pack_size);
    return {
      ingredient_id: item.ingredient_id,
      name: item.name,
      unit: item.unit,
      demand,
      on_hand: item.on_hand,
      committed: item.committed,
      usable_stock: usableStock,
      shortage,
      pack_size: item.pack_size,
      pack_name: item.pack_name,
      packs_to_request: packs,
      request_quantity: packs * item.pack_size,
    };
  });

  const assignedHoursByStaff = new Map(staff.map((person) => [person.id, 0]));
  const roster = dailyProduction.map((day) => {
    const approvedLeave = new Set(leave.filter((entry) => entry.date === day.date && entry.status.toLowerCase() === "approved").map((entry) => entry.staff_id));
    const onLeave = (person: Staff) => approvedLeave.has(person.id);
    const productionQualified = (person: Staff) => person.skills.includes("production");
    const permanent = staff.filter((person) => person.employment_type === "Permanent" && productionQualified(person) && !onLeave(person));
    const partTime = staff.filter((person) => person.employment_type === "Part-time" && productionQualified(person) && !onLeave(person) &&
      availability.some((shift) => shift.staff_id === person.id && shift.date === day.date && shift.status === "Confirmed"));
    const permanentLead = permanent.filter((person) => person.skills.includes("supervisor")).sort(staffNameOrder)[0];
    const partTimeLead = partTime.filter((person) => person.skills.includes("supervisor")).sort(staffNameOrder)[0];
    const lead = permanentLead ?? partTimeLead;
    const assigned: Array<{ staff_id: string; name: string; employment_type: string; start: string; end: string; productive_hours: number; supervisor: boolean }> = [];
    const assignedToday = new Set<string>();
    let capacity = 0;
    const assign = (person: Staff, hours: number, start: string, end: string) => {
      if (assignedToday.has(person.id)) return;
      assignedToday.add(person.id);
      assignedHoursByStaff.set(person.id, (assignedHoursByStaff.get(person.id) ?? 0) + hours);
      capacity += hours;
      assigned.push({ staff_id: person.id, name: person.name, employment_type: person.employment_type, start, end, productive_hours: hours, supervisor: person.skills.includes("supervisor") });
    };
    const requiredHours = day.labourHours;
    if (requiredHours > 0 && lead) {
      if (lead.employment_type === "Permanent") {
        assign(lead, scenario.settings.permanent_productive_hours, scenario.settings.permanent_shift_start, scenario.settings.permanent_shift_end);
      } else {
        const shift = availability.find((entry) => entry.staff_id === lead.id && entry.date === day.date && entry.status === "Confirmed")!;
        assign(lead, scenario.settings.part_time_productive_hours, shift.start, shift.end);
      }
    }
    const byLeastAssigned = (a: Staff, b: Staff) => (assignedHoursByStaff.get(a.id) ?? 0) - (assignedHoursByStaff.get(b.id) ?? 0) || staffNameOrder(a, b);
    for (const person of permanent.filter((person) => person.id !== lead?.id).sort(byLeastAssigned)) {
      if (capacity >= requiredHours) break;
      assign(person, scenario.settings.permanent_productive_hours, scenario.settings.permanent_shift_start, scenario.settings.permanent_shift_end);
    }
    for (const person of partTime.sort(byLeastAssigned)) {
      if (capacity >= requiredHours) break;
      const shift = availability.find((entry) => entry.staff_id === person.id && entry.date === day.date && entry.status === "Confirmed")!;
      assign(person, scenario.settings.part_time_productive_hours, shift.start, shift.end);
    }
    const uncoveredHours = round(Math.max(0, requiredHours - capacity), 2);
    return {
      date: day.date,
      required_hours: requiredHours,
      assigned_capacity_hours: capacity,
      uncovered_hours: uncoveredHours,
      additional_part_time_shifts_to_request: Math.ceil(uncoveredHours / scenario.settings.part_time_productive_hours),
      supervisor_assigned: assigned.some((worker) => worker.supervisor),
      workers: assigned,
      approved_leave_ids: [...approvedLeave],
    };
  });

  const pendingLeaveAlerts = leave.filter((entry) => entry.status.toLowerCase() === "pending");
  return {
    orderSummary: { eligible_count: eligibleOrders.length, excluded_count: excludedOrders.length, eligibleOrders, excludedOrders },
    dailyProduction,
    totalLabourHours: round(dailyProduction.reduce((sum, day) => sum + day.labourHours, 0), 2),
    ingredientDemand: Object.fromEntries(ingredientDemand),
    stockRequest,
    roster,
    approvedLeaveExceptions: leave.filter((entry) => entry.status.toLowerCase() === "approved"),
    pendingLeaveAlerts,
    assignedWeeklyHours: Object.fromEntries(assignedHoursByStaff),
  };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}
