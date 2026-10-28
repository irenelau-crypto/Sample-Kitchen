"use client";

import { useMemo, useState } from "react";

type Plan = {
  orderSummary: { eligible_count: number; excluded_count: number; eligibleOrders: Array<Record<string, unknown>>; excludedOrders: Array<Record<string, unknown> & { reasons: string[] }> };
  dailyProduction: Array<{ date: string; byProduct: Record<string, number>; totalSandwiches: number; labourHours: number }>;
  totalLabourHours: number;
  ingredientDemand: Record<string, number>;
  stockRequest: Array<{ ingredient_id: string; name: string; unit: string; demand: number; usable_stock: number; shortage: number; pack_size: number; pack_name: string; packs_to_request: number; request_quantity: number }>;
  roster: Array<{ date: string; required_hours: number; assigned_capacity_hours: number; uncovered_hours: number; additional_part_time_shifts_to_request: number; supervisor_assigned: boolean; workers: Array<{ staff_id: string; name: string; start: string; end: string; productive_hours: number; supervisor: boolean }>; approved_leave_ids: string[] }>;
  pendingLeaveAlerts: Array<{ staff_id: string; date: string; reason: string }>;
  approvedLeaveExceptions: Array<{ staff_id: string; date: string; reason: string }>;
};
type Source = { kind: string; sourceName: string; sourceSystem: string | null; exportId: string | null; rowCount: number; sourceTimestamp: string | null; importedAt: string };
type Recommendations = {
  sales: { summary: string; lateExceptionExplanation: string; datedActions: Array<{ date: string; action: string }> };
  manpower: { gapExplanation: string; coverRequestDates: string[]; managerAction: string };
  purchasing: { shortageExplanation: string; itemReasons: Array<{ ingredientId: string; reason: string }>; supplierDraftNote: string; supplierDraftText: string };
};
type AgentResult = { model: string; createdAt?: string; recommendations: Recommendations; handoffTrace: Array<{ from: string; to: string; data: string[] }> };
type DraftAction = { status: "PENDING" | "CREATED"; recipient: string; subject: string; completedAt?: string | null };

const style = { border: "1px solid var(--line)", borderRadius: 16, padding: 20, background: "var(--surface)" };
const formatter = new Intl.DateTimeFormat("en-SG", { timeZone: "Asia/Singapore", dateStyle: "medium", timeStyle: "short" });
const dayLabel = (date: string) => new Date(`${date}T00:00:00+08:00`).toLocaleDateString("en-SG", { timeZone: "Asia/Singapore", weekday: "long", month: "short", day: "numeric" });
const timeLabel = (date: string) => formatter.format(new Date(date));

export default function Home() {
  const [token, setToken] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [importVersion, setImportVersion] = useState<{ latestImportAt: string } | null>(null);
  const [agents, setAgents] = useState<AgentResult | null>(null);
  const [draftAction, setDraftAction] = useState<DraftAction | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [draftPreviewOpen, setDraftPreviewOpen] = useState(false);
  const [busy, setBusy] = useState<"load" | "agents" | "draft" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  async function loadDashboard() {
    setBusy("load"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/plan", { headers, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.missingImports ? `${data.error} Missing: ${data.missingImports.join(", ")}.` : data.error ?? "Could not load the plan.");
      setPlan(data.plan as Plan);
      setSources(data.sources as Source[]);
      setImportVersion(data.importVersion);
      const savedResponse = await fetch("/api/agents/latest", { headers, cache: "no-store" });
      const savedData = await savedResponse.json();
      if (savedResponse.ok && savedData.run) {
        setAgents({ model: savedData.run.model, createdAt: savedData.run.createdAt, recommendations: savedData.run.recommendations, handoffTrace: savedData.run.handoffTrace });
        setDraftAction(savedData.draftAction ?? null);
      } else {
        setAgents(null); setDraftAction(null);
      }
      setReviewed(false);
      setDraftPreviewOpen(false);
      setNotice("Plan loaded from saved imports.");
    } catch (cause) {
      setPlan(null); setAgents(null); setDraftAction(null);
      setError(cause instanceof Error ? cause.message : "Could not load the plan.");
    } finally { setBusy(null); }
  }

  async function runAgents() {
    setBusy("agents"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/agents/run", { method: "POST", headers, cache: "no-store" });
      const data = await response.json();
      if (data.plan) setPlan(data.plan as Plan);
      if (!response.ok) throw new Error(data.error ?? "Planning agents failed.");
      setAgents({ model: data.model, createdAt: data.createdAt, recommendations: data.recommendations, handoffTrace: data.handoffTrace });
      setDraftAction(null); setReviewed(false);
      setDraftPreviewOpen(false);
      setNotice("All three recommendations are saved with the current imports.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Planning agents failed."); }
    finally { setBusy(null); }
  }

  async function createDraft() {
    setBusy("draft"); setError(""); setNotice("");
    try {
      const response = await fetch("/api/draft", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ reviewed }) });
      const data = await response.json();
      if (data.draftAction) setDraftAction(data.draftAction as DraftAction);
      if (!response.ok) throw new Error(data.error ?? "Gmail draft could not be created.");
      setNotice(data.message ?? "Draft request completed. Check Gmail Drafts.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Gmail draft could not be created."); }
    finally { setBusy(null); }
  }

  const actionPlan = plan ? [
    ...plan.orderSummary.excludedOrders.map((order) => ({ date: String(order.production_date), finding: `Order ${String(order.id)} was excluded: ${order.reasons.join(" ")}`, action: "Manager: decide whether to accept this order and revise the plan." })),
    ...plan.roster.filter((day) => day.uncovered_hours > 0).map((day) => ({ date: day.date, finding: `${day.uncovered_hours} productive hours remain uncovered.`, action: `Manager: request ${day.additional_part_time_shifts_to_request} additional four-hour part-time shift${day.additional_part_time_shifts_to_request === 1 ? "" : "s"}; do not treat it as booked.` })),
    ...plan.stockRequest.filter((item) => item.shortage > 0).map((item) => ({ date: plan.dailyProduction[0]?.date ?? "", finding: `${item.name} is short by ${item.shortage} ${item.unit}; whole-pack request is ${item.packs_to_request} ${item.pack_name}.`, action: "Manager: review the stock request and supplier draft before creating a Gmail draft." })),
  ] : [];

  return <main className="dashboard-shell">
    <header className="topbar">
      <a className="brand" href="/" aria-label="Kitchen Planner home"><span className="brand-mark">K</span><span>Kitchen Planner<small>Sample Central Kitchen</small></span></a>
      <nav><a href="/imports">Owner imports <span aria-hidden="true">↗</span></a></nav>
    </header>

    <section className="hero">
      <div><p className="eyebrow">WEEKLY OPERATIONS · 2–6 NOVEMBER 2026</p><h1>Production plan</h1><p className="hero-copy">Review the saved orders, staffing draft and stock request. Planning agents make recommendations only.</p></div>
      <div className="load-control" style={style}>
        <label htmlFor="dashboard-token">Owner access token</label>
        <div className="token-row"><input id="dashboard-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Enter server-configured token" /><button className="button button-primary" type="button" disabled={!token || busy !== null} onClick={loadDashboard}>{busy === "load" ? "Loading…" : "Load saved plan"}</button></div>
        <small>Token stays in this page’s memory and is sent only to the app’s backend.</small>
      </div>
    </section>

    {error && <div role="alert" className="banner banner-error"><strong>Action needed</strong><span>{error}</span>{/Import all required|Missing:/.test(error) && <a href="/imports">Open owner imports →</a>}</div>}
    {notice && <div role="status" className="banner banner-success">{notice}</div>}

    {plan && <>
      <section className="section-block">
        <div className="section-heading"><div><p className="eyebrow">SOURCE STATUS</p><h2>Current saved inputs</h2></div><p className="muted">Last import {importVersion ? timeLabel(importVersion.latestImportAt) : "—"}</p></div>
        <div className="source-grid">{sources.map((source) => <article className="source-card" key={source.kind}><span className="source-kind">{source.kind}</span><strong>{source.sourceName}</strong><span>{source.exportId ? `Export ${source.exportId}` : source.sourceSystem}</span><small>{source.rowCount} rows · imported {timeLabel(source.importedAt)}</small>{source.sourceTimestamp && <small>Source time {timeLabel(source.sourceTimestamp)}</small>}</article>)}</div>
      </section>

      <section className="metric-grid" aria-label="Plan summary">
        <article className="metric-card"><span>Eligible orders</span><strong>{plan.orderSummary.eligible_count}</strong><small>included in baseline</small></article>
        <article className="metric-card metric-warn"><span>Manager review</span><strong>{plan.orderSummary.excluded_count}</strong><small>excluded orders</small></article>
        <article className="metric-card"><span>Sandwiches</span><strong>{plan.dailyProduction.reduce((sum, day) => sum + day.totalSandwiches, 0).toLocaleString()}</strong><small>production week total</small></article>
        <article className="metric-card"><span>Productive labour</span><strong>{plan.totalLabourHours.toFixed(1)}<i>h</i></strong><small>calculated from recipes</small></article>
      </section>

      <section className="section-block">
        <div className="section-heading"><div><p className="eyebrow">PRODUCTION</p><h2>Daily quantities and labour</h2></div></div>
        <div className="table-wrap"><table><thead><tr><th>Production day</th><th>Cheese</th><th>Egg</th><th>Chicken</th><th>Total</th><th>Labour</th></tr></thead><tbody>{plan.dailyProduction.map((day) => <tr key={day.date}><th scope="row">{dayLabel(day.date)}</th><td>{(day.byProduct.CHEESE ?? 0).toLocaleString()}</td><td>{(day.byProduct.EGG ?? 0).toLocaleString()}</td><td>{(day.byProduct.CHICKEN ?? 0).toLocaleString()}</td><td><strong>{day.totalSandwiches.toLocaleString()}</strong></td><td>{day.labourHours.toFixed(1)} h</td></tr>)}</tbody></table></div>
      </section>

      <section className="section-block">
        <div className="section-heading"><div><p className="eyebrow">ORDER REVIEW</p><h2>Eligible order lines</h2></div><p className="muted">{plan.orderSummary.eligible_count} included in the baseline</p></div>
        <details className="eligible-orders"><summary>Show included order details</summary><div className="table-wrap"><table><thead><tr><th>Order</th><th>Customer</th><th>Product</th><th>Quantity</th><th>Production</th><th>Received</th></tr></thead><tbody>{plan.orderSummary.eligibleOrders.map((order) => <tr key={String(order.id)}><th scope="row">{String(order.id)}</th><td>{String(order.customer)}</td><td>{String(order.product_id)}</td><td>{Number(order.quantity).toLocaleString()}</td><td>{String(order.production_date)}</td><td>{String(order.received_at)}</td></tr>)}</tbody></table></div></details>
      </section>

      <section className="content-grid">
        <article className="section-card"><p className="eyebrow">ORDER REVIEW</p><h2>Excluded orders</h2>{plan.orderSummary.excludedOrders.length ? <ul className="exception-list">{plan.orderSummary.excludedOrders.map((order) => <li key={String(order.id)}><strong>{String(order.id)} · {String(order.customer)}</strong><span>{String(order.product_id)} · {Number(order.quantity).toLocaleString()} sandwiches · production {String(order.production_date)}</span>{order.reasons.map((reason) => <small key={reason}>{reason}</small>)}</li>)}</ul> : <p className="muted">No orders need review.</p>}</article>
        <article className="section-card"><p className="eyebrow">PURCHASING</p><h2>Ingredient stock request</h2><div className="table-wrap"><table><thead><tr><th>Ingredient</th><th>Demand</th><th>Usable</th><th>Request</th></tr></thead><tbody>{plan.stockRequest.map((item) => <tr key={item.ingredient_id}><th scope="row">{item.name}<small>{item.ingredient_id}</small></th><td>{item.demand.toLocaleString()} {item.unit}</td><td>{item.usable_stock.toLocaleString()} {item.unit}</td><td>{item.packs_to_request ? <strong>{item.packs_to_request} × {item.pack_name}</strong> : <span className="badge badge-ok">Covered</span>}</td></tr>)}</tbody></table></div><p className="microcopy">Requested or promised stock never increases physical on-hand quantities.</p></article>
      </section>

      {plan.approvedLeaveExceptions.length > 0 && <section className="section-block"><div className="section-heading"><div><p className="eyebrow">HR EXCEPTIONS</p><h2>Approved leave excluded from availability</h2></div></div><div className="leave-grid">{plan.approvedLeaveExceptions.map((entry, index) => <article className="leave-card" key={`${entry.staff_id}-${entry.date}-${index}`}><strong>{dayLabel(entry.date)}</strong><span>Staff {entry.staff_id} · {entry.reason}</span></article>)}</div></section>}

      <section className="section-block">
        <div className="section-heading"><div><p className="eyebrow">DRAFT ROSTER</p><h2>Named coverage by day</h2></div><p className="muted">Manager approval required · no worker is booked by this plan</p></div>
        <div className="roster-grid">{plan.roster.map((day) => <article className="roster-card" key={day.date}><div className="roster-head"><h3>{dayLabel(day.date)}</h3>{day.uncovered_hours > 0 ? <span className="badge badge-warn">{day.uncovered_hours} h uncovered</span> : <span className="badge badge-ok">Covered</span>}</div><p className="roster-hours">{day.required_hours.toFixed(1)} h required <span>·</span> {day.assigned_capacity_hours} h capacity</p>{day.workers.length ? <ul>{day.workers.map((worker) => <li key={worker.staff_id}><strong>{worker.name}</strong>{worker.supervisor && <span className="badge badge-lead">Lead</span>}<small>{worker.start}–{worker.end} · {worker.productive_hours} productive hours</small></li>)}</ul> : <p className="muted">No shift required.</p>}{day.additional_part_time_shifts_to_request > 0 && <p className="request-callout">Request {day.additional_part_time_shifts_to_request} additional part-time shift{day.additional_part_time_shifts_to_request === 1 ? "" : "s"} for manager review.</p>}</article>)}</div>
      </section>

      {plan.pendingLeaveAlerts.length > 0 && <section className="banner banner-warn"><strong>Pending leave alerts</strong>{plan.pendingLeaveAlerts.map((entry, index) => <span key={`${entry.staff_id}-${entry.date}-${index}`}>{entry.staff_id} · {entry.date}: {entry.reason}</span>)}</section>}

      <section className="section-block">
        <div className="section-heading"><div><p className="eyebrow">MANAGER ACTIONS</p><h2>Dated action plan</h2></div></div>
        {actionPlan.length ? <ol className="action-list">{actionPlan.map((item, index) => <li key={`${item.date}-${index}`}><time>{dayLabel(item.date)}</time><div><strong>{item.finding}</strong><p>{item.action}</p></div></li>)}</ol> : <p className="muted">No exceptions or shortages need action.</p>}
      </section>

      <section className="section-block agent-section">
        <div className="section-heading"><div><p className="eyebrow">THREE PLANNING AGENTS</p><h2>Recommendations for review</h2></div><button className="button button-primary" type="button" disabled={busy !== null} onClick={runAgents}>{busy === "agents" ? "Running agents…" : "Run planning agents"}</button></div>
        {agents ? <>
          <div className="agent-meta">Model <strong>{agents.model}</strong>{agents.createdAt && <span>· run {timeLabel(agents.createdAt)}</span>}</div>
          <div className="agent-grid">
            <article className="agent-card"><span className="agent-number">01</span><h3>Sales &amp; Production</h3><p>{agents.recommendations.sales.summary}</p><p>{agents.recommendations.sales.lateExceptionExplanation}</p><h4>Dated actions</h4><ul>{agents.recommendations.sales.datedActions.map((action, index) => <li key={`${action.date}-${index}`}><strong>{dayLabel(action.date)}:</strong> {action.action}</li>)}</ul></article>
            <article className="agent-card"><span className="agent-number">02</span><h3>Manpower</h3><p>{agents.recommendations.manpower.gapExplanation}</p>{agents.recommendations.manpower.coverRequestDates.map((date) => { const gap = plan.roster.find((day) => day.date === date); return <p key={date}><strong>{dayLabel(date)}:</strong> {gap?.uncovered_hours} hours uncovered; {gap?.additional_part_time_shifts_to_request} shift request for manager review.</p>; })}<p>{agents.recommendations.manpower.managerAction}</p></article>
            <article className="agent-card"><span className="agent-number">03</span><h3>Purchasing</h3><p>{agents.recommendations.purchasing.shortageExplanation}</p><ul>{agents.recommendations.purchasing.itemReasons.map((item) => <li key={item.ingredientId}><strong>{item.ingredientId}:</strong> {item.reason}</li>)}</ul><details onToggle={(event) => setDraftPreviewOpen(event.currentTarget.open)}><summary>Review supplier draft text</summary><pre className="draft-preview">{agents.recommendations.purchasing.supplierDraftText}</pre></details></article>
          </div>
          <details className="handoff"><summary>Agent handoff trace</summary><ol>{agents.handoffTrace.map((handoff, index) => <li key={index}><strong>{handoff.from}</strong> → <strong>{handoff.to}</strong><small>{handoff.data.join(" · ")}</small></li>)}</ol></details>
          <div className="draft-action" style={style}>
            <div><p className="eyebrow">REVIEWED GMAIL ACTION</p><h3>Create an unsent draft</h3><p>The server sends the saved recipient, subject and body to the configured Zapier MCP Gmail Create Draft tool. It does not send the email.</p></div>
            {draftAction?.status === "CREATED" && <p className="banner banner-success">Draft request completed. Check Gmail Drafts to confirm it is present and unsent.</p>}
            {draftAction?.status === "PENDING" && <p className="banner banner-warn">A draft request is pending or could not be confirmed. Check Gmail Drafts and Zapier History before retrying.</p>}
            <label className="review-check"><input type="checkbox" checked={reviewed} disabled={!draftPreviewOpen || Boolean(draftAction)} onChange={(event) => setReviewed(event.target.checked)} />I reviewed the recipient, subject and body above.</label>
            <button className="button button-secondary" type="button" disabled={!reviewed || busy !== null || Boolean(draftAction)} onClick={createDraft}>{busy === "draft" ? "Creating draft…" : "Create Gmail draft"}</button>
          </div>
        </> : <div className="agent-empty"><p>Run the agents after all five imports are saved. The verified numeric plan remains available if an agent request fails.</p></div>}
      </section>
    </>}

    {!plan && !error && <section className="empty-state" style={style}><span className="empty-icon">✳</span><h2>Your plan starts with saved records</h2><p>Load the latest imports from Postgres to calculate production, staffing and purchasing. The dashboard does not bundle sample operational data.</p><a className="button button-secondary" href="/imports">Go to owner imports</a></section>}
    <footer className="footer"><span>Sample Central Kitchen · Asia/Singapore</span><span>Numbers are calculated in code; agents recommend, managers decide.</span></footer>
  </main>;
}
