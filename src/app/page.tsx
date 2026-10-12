import { CodexDashboard } from "@/components/dashboard/codex-dashboard";
import { initialAnalytics } from "@/lib/analytics-reader";
import { analyticsProviderSchema } from "@/lib/analytics-types";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: {
  searchParams: Promise<{ provider?: string | string[] }>;
}): Promise<React.ReactNode> {
  const parsed = analyticsProviderSchema.safeParse((await searchParams).provider ?? "codex");
  return <CodexDashboard initialData={initialAnalytics(parsed.success ? parsed.data : "codex")} />;
}
