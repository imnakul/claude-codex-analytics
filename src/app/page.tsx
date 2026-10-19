import { CodexDashboard } from "@/components/dashboard/codex-dashboard";
import { analyticsProviderSchema } from "@/lib/analytics-types";

export default async function Home({ searchParams }: {
  searchParams: Promise<{ provider?: string | string[] }>;
}): Promise<React.ReactNode> {
  const parsed = analyticsProviderSchema.safeParse((await searchParams).provider ?? "codex");
  return <CodexDashboard initialProvider={parsed.success ? parsed.data : "codex"} />;
}
