"use client";

import { useState } from "react";

type ImportKind = "STOCK" | "STAFF" | "LEAVE" | "AVAILABILITY" | "CRM";
type SavedImport = {
  id: string;
  kind: ImportKind;
  exportId: string | null;
  sourceName: string;
  sourceSystem: string | null;
  sourceTimestamp: string | null;
  rowCount: number;
  importedAt: string;
};

const sources: Array<{ kind: ImportKind; label: string; help: string; accept: string }> = [
  { kind: "STOCK", label: "Import stock count", help: "Physical count JSON; saved checked time is shown below.", accept: ".json,application/json" },
  { kind: "STAFF", label: "Import staff master", help: "Import this before leave or availability exports.", accept: ".json,application/json" },
  { kind: "LEAVE", label: "Import leave decisions", help: "Staff IDs must exist in the saved staff master.", accept: ".json,application/json" },
  { kind: "AVAILABILITY", label: "Import part-time availability", help: "Staff IDs must exist in the saved staff master.", accept: ".json,application/json" },
  { kind: "CRM", label: "Upload weekly CRM orders", help: "CSV columns, dates, product IDs and order IDs are validated.", accept: ".csv,text/csv" },
];

export default function ImportsPage() {
  const [token, setToken] = useState("");
  const [files, setFiles] = useState<Partial<Record<ImportKind, File>>>({});
  const [imports, setImports] = useState<SavedImport[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<ImportKind | null>(null);
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<string[]>([]);

  async function refresh() {
    setLoading(true);
    setMessage("");
    setErrors([]);
    try {
      const response = await fetch("/api/imports", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not load saved imports.");
      setImports(result.imports as SavedImport[]);
      setMessage("Saved import status loaded.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load saved imports.");
    } finally { setLoading(false); }
  }

  async function submit(kind: ImportKind) {
    const file = files[kind];
    if (!file) { setMessage("Choose a file first."); return; }
    setBusy(kind);
    setMessage("");
    setErrors([]);
    try {
      const form = new FormData();
      form.set("kind", kind);
      form.set("file", file);
      const response = await fetch("/api/imports", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
      const result = await response.json();
      if (!response.ok) {
        setErrors(Array.isArray(result.validationErrors) ? result.validationErrors : []);
        throw new Error(result.error ?? "Import failed.");
      }
      setMessage(result.message);
      setFiles((current) => ({ ...current, [kind]: undefined }));
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Import failed.");
    } finally { setBusy(null); }
  }

  function latest(kind: ImportKind) { return imports.find((item) => item.kind === kind); }

  return (
    <main style={{ maxWidth: 860, margin: "40px auto", padding: "0 20px", fontFamily: "Arial, sans-serif", color: "#17302a" }}>
      <p><a href="/">← Kitchen Planner</a></p>
      <h1>Owner data imports</h1>
      <p>Accepted files are validated on the server and saved to Postgres. Invalid uploads leave saved imports unchanged.</p>

      <section aria-labelledby="access-heading" style={{ border: "1px solid #cbd5d1", borderRadius: 12, padding: 16, margin: "24px 0" }}>
        <h2 id="access-heading">Owner access</h2>
        <label htmlFor="owner-token">Import access token</label>
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <input id="owner-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} style={{ minWidth: 260, padding: 10 }} />
          <button type="button" disabled={!token || loading} onClick={refresh}>{loading ? "Loading…" : "Load saved imports"}</button>
        </div>
        <small>Set `IMPORTS_ACCESS_TOKEN` on the server. The token stays in this page’s memory and is sent only to the import API.</small>
      </section>

      {message && <p role="status" aria-live="polite">{message}</p>}
      {errors.length > 0 && <ul role="alert">{errors.map((error) => <li key={error}>{error}</li>)}</ul>}

      <div style={{ display: "grid", gap: 14 }}>
        {sources.map((source) => {
          const saved = latest(source.kind);
          return <section key={source.kind} style={{ border: "1px solid #cbd5d1", borderRadius: 12, padding: 16 }}>
            <h2>{source.label}</h2>
            <p>{source.help}</p>
            <input aria-label={`${source.label} file`} type="file" accept={source.accept} onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) setFiles((current) => ({ ...current, [source.kind]: selected }));
            }} />
            <button type="button" disabled={!token || !files[source.kind] || busy !== null} onClick={() => submit(source.kind)} style={{ marginLeft: 8 }}>
              {busy === source.kind ? "Validating and saving…" : "Validate and import"}
            </button>
            {saved && <p>
              <strong>Latest saved:</strong> {saved.sourceName}
              {saved.exportId ? ` · Export ${saved.exportId}` : ""}
              {saved.sourceSystem ? ` · ${saved.sourceSystem}` : ""}
              {saved.rowCount} records · imported {new Date(saved.importedAt).toLocaleString()}
              {saved.sourceTimestamp ? ` · source time ${new Date(saved.sourceTimestamp).toLocaleString()}` : ""}
            </p>}
          </section>;
        })}
      </div>
    </main>
  );
}
