type RpcResponse = { result?: unknown; error?: { code?: number; message?: string } };
type McpTool = { name: string; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } };

function responseJson(text: string, contentType: string): RpcResponse {
  let raw = text;
  if (contentType.includes("text/event-stream")) {
    const dataLines = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
    raw = dataLines.at(-1) ?? "";
  }
  if (!raw) return {};
  try { return JSON.parse(raw) as RpcResponse; }
  catch { throw new Error("Zapier MCP returned an unreadable response."); }
}

async function postRpc(url: string, token: string, method: string, params?: unknown, sessionId?: string, id?: number) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const hasId = id !== undefined;
  const response = await fetch(url, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ jsonrpc: "2.0", ...(hasId ? { id } : {}), method, ...(params === undefined ? {} : { params }) }),
  });
  if (!response.ok) throw new Error(`Zapier MCP returned HTTP ${response.status}.`);
  const parsed = responseJson(await response.text(), response.headers.get("content-type") ?? "");
  if (parsed.error) throw new Error(`Zapier MCP error ${parsed.error.code ?? ""}: ${parsed.error.message ?? "request failed"}`);
  return { result: parsed.result as Record<string, unknown> | undefined, sessionId: response.headers.get("mcp-session-id") ?? sessionId };
}

function normalizeKey(value: string) { return value.toLowerCase().replace(/[^a-z]/g, ""); }

function mapDraftArguments(tool: McpTool, recipient: string, subject: string, body: string) {
  const properties = tool.inputSchema?.properties ?? {};
  const required = tool.inputSchema?.required ?? [];
  const values: Record<string, string> = {};
  for (const key of Object.keys(properties)) {
    const name = normalizeKey(key);
    if (["to", "recipient", "recipientemail", "email", "emailaddress"].includes(name)) values[key] = recipient;
    else if (name === "subject" || name === "subjectline") values[key] = subject;
    else if (["body", "message", "messagetext", "bodytext", "plainbody", "content"].includes(name)) values[key] = body;
  }
  const missing = required.filter((key) => values[key] === undefined);
  if (missing.length) throw new Error(`Configured Zapier draft tool has unsupported required fields: ${missing.join(", ")}.`);
  return values;
}

export async function createGmailDraft(input: { recipient: string; subject: string; body: string }) {
  const url = process.env.ZAPIER_MCP_URL;
  const token = process.env.ZAPIER_MCP_TOKEN;
  const toolName = process.env.ZAPIER_CREATE_DRAFT_TOOL;
  if (!url || !token || !toolName) throw new Error("Set ZAPIER_MCP_URL, ZAPIER_MCP_TOKEN and ZAPIER_CREATE_DRAFT_TOOL on the server to enable Gmail drafts.");
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); }
  catch { throw new Error("ZAPIER_MCP_URL must be a valid HTTPS URL."); }
  if (parsedUrl.protocol !== "https:") throw new Error("ZAPIER_MCP_URL must use HTTPS.");

  const initialized = await postRpc(url, token, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "kitchen-planner", version: "0.1.0" },
  }, undefined, 1);
  await postRpc(url, token, "notifications/initialized", undefined, initialized.sessionId);
  const listed = await postRpc(url, token, "tools/list", {}, initialized.sessionId, 2);
  const tools = (listed.result?.tools ?? []) as McpTool[];
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`Configured Zapier MCP tool “${toolName}” is not available on this server.`);
  const args = mapDraftArguments(tool, input.recipient, input.subject, input.body);
  const called = await postRpc(url, token, "tools/call", { name: tool.name, arguments: args }, initialized.sessionId, 3);
  if (called.result?.isError === true) throw new Error("Zapier MCP reported that Gmail Create Draft failed.");
  return { toolName: tool.name };
}

export function isZapierMcpConfigured() {
  return Boolean(process.env.ZAPIER_MCP_URL && process.env.ZAPIER_MCP_TOKEN && process.env.ZAPIER_CREATE_DRAFT_TOOL);
}
