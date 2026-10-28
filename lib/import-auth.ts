import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function requireImportAccess(request: NextRequest): NextResponse | null {
  const expected = process.env.IMPORTS_ACCESS_TOKEN;
  if (!expected) return NextResponse.json({ error: "Owner import access is not configured on the server." }, { status: 503 });

  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  const matches = suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes);
  if (!matches) return NextResponse.json({ error: "Enter the owner import access token to continue." }, { status: 401 });
  return null;
}
