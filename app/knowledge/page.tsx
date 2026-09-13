import { KnowledgeBrowser } from "../../src/components/knowledge/index.ts";
import "../../src/components/knowledge/knowledge.css";

export const metadata = {
  title: "Knowledge — Gather",
  description: "Review and correct what Gather knows about your business",
};

/**
 * Owner business-knowledge review entry point. Workspace navigation can link
 * here later (see the Venue nav in src/components/gather/GatherWorkspace.tsx,
 * owned by the commercial-integration lane) — this route is stable at
 * /knowledge regardless of when the nav item lands.
 */
export default function KnowledgePage() {
  return <KnowledgeBrowser />;
}
