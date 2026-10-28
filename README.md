# Kitchen Planner

A Next.js kitchen-planning app with Prisma/Postgres persistence, validated owner imports, deterministic production and staffing calculations, planning agents, and a reviewed supplier-draft action.

## Local setup

1. Install dependencies with `pnpm install`.
2. Copy `.env.example` to `.env.local` and fill in server-only settings. Keep `.env.local` out of GitHub.
3. Apply the Prisma schema with `pnpm exec prisma db push`, then seed reference data with `pnpm run db:seed`.
4. Run `pnpm dev` for local development or `pnpm build` and `pnpm start` for a production preview.

The import workflow requires `DATABASE_URL` and `IMPORTS_ACCESS_TOKEN`. Running the OpenAI agents additionally requires `OPENAI_API_KEY`. The Gmail draft action requires the Zapier MCP URL, token, and Create Draft tool name. Do not commit those values or paste them into source files.

The operational stock, HR, and CRM examples are intentionally excluded from this repository. Use the owner import screen to upload those files to the configured application.
