import { readAnalytics } from "@/lib/analytics-reader";
import { analyticsProviderSchema } from "@/lib/analytics-types";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export function GET(request: Request): Response {
  const parsed = analyticsProviderSchema.safeParse(new URL(request.url).searchParams.get("provider") ?? "codex");
  if (!parsed.success) {
    return Response.json({ error: "Provider must be codex or claude." }, {
      status: 400, headers: { "Cache-Control": "no-store" },
    });
  }
  try {
    return Response.json(readAnalytics(parsed.data), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[codex-analytics-ledger] Analytics refresh failed", error);
    return Response.json(
      { error: `Unable to read local ${parsed.data === "claude" ? "Claude" : "Codex"} analytics.` },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
