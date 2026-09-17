import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 005-A04 rendered evidence: the actual ADR-005 components (EvidenceReview,
// RuleConfirmation, ConcessionForm, KnowledgeEmptyState, EvalTrend) are
// transpiled with the repo's own tsc and rendered to static markup. Node's
// type-stripping cannot load .tsx, so this harness emits real JS into a
// test-owned temp dir (with a node_modules symlink for react) and renders
// that. Evidence HTML is written to evaluation/knowledge/evidence/.

const ROOT = process.cwd();

interface ComponentModule {
  EvidenceReview: (props: Record<string, unknown>) => unknown;
  RuleConfirmation: (props: Record<string, unknown>) => unknown;
  ConcessionForm: (props: Record<string, unknown>) => unknown;
  KnowledgeEmptyState: (props: Record<string, unknown>) => unknown;
  EvalTrend: (props: Record<string, unknown>) => unknown;
}

let cached: { dir: string; mod: ComponentModule } | null = null;

async function loadComponents(): Promise<{ dir: string; mod: ComponentModule }> {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "gather-adr005-ui-"));
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
  const out = join(dir, "out");
  execFileSync(
    join(ROOT, "node_modules", ".bin", "tsc"),
    [
      join(ROOT, "src/components/gather/knowledge/EvidenceReview.tsx"),
      join(ROOT, "src/components/gather/knowledge/RuleConfirmation.tsx"),
      join(ROOT, "src/components/gather/knowledge/ConcessionForm.tsx"),
      join(ROOT, "src/components/gather/knowledge/KnowledgeEmptyState.tsx"),
      join(ROOT, "src/components/gather/evals/EvalTrend.tsx"),
      "--outDir", out,
      "--jsx", "react-jsx",
      "--module", "nodenext",
      "--target", "es2022",
      "--moduleResolution", "nodenext",
      "--allowImportingTsExtensions",
      "--rewriteRelativeImportExtensions",
      "--skipLibCheck",
    ],
    { cwd: ROOT, stdio: "pipe" },
  );
  const file = (rel: string): string => pathToFileURL(join(out, rel)).href;
  const [review, rule, form, empty, trend] = await Promise.all([
    import(file(join("components", "gather", "knowledge", "EvidenceReview.js"))),
    import(file(join("components", "gather", "knowledge", "RuleConfirmation.js"))),
    import(file(join("components", "gather", "knowledge", "ConcessionForm.js"))),
    import(file(join("components", "gather", "knowledge", "KnowledgeEmptyState.js"))),
    import(file(join("components", "gather", "evals", "EvalTrend.js"))),
  ]);
  const mod: ComponentModule = {
    EvidenceReview: review.EvidenceReview,
    RuleConfirmation: rule.RuleConfirmation,
    ConcessionForm: form.ConcessionForm,
    KnowledgeEmptyState: empty.KnowledgeEmptyState,
    EvalTrend: trend.EvalTrend,
  };
  cached = { dir, mod };
  return cached;
}

function render(component: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(component as Parameters<typeof createElement>[0], props));
}

function evidencePage(title: string, width: number, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — ${width}px — ADR-005 rendered evidence (fictional fixtures only)</title>
</head>
<body style="margin:0;padding:16px;font-family:system-ui,sans-serif;background:#f6f2ea;">
<main style="max-width:${width}px;margin:0 auto;">
<p style="color:#5b564a;font-size:14px;">ADR-005 rendered evidence · viewport ${width}px · all content fictional fixtures, nothing confirmed or authoritative.</p>
${body}
</main>
</body>
</html>
`;
}

function writeEvidence(name: string, width: number, body: string): string {
  const dir = join(ROOT, "evaluation", "knowledge", "evidence");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}-${width}.html`);
  writeFileSync(path, evidencePage(name, width, body));
  return path;
}

const DOC_REF = {
  kind: "document",
  locator: "fixture://fictional/adr005/pricing-sheet",
  label: "Fictional pricing sheet",
  fictional: true,
};

function inspectionProps(selectedIds: string[]): Record<string, unknown> {
  return {
    inspection: {
      businessId: "biz-fiction",
      sourceLocator: DOC_REF.locator,
      provenance: "prepared",
      missingKeys: ["price_line"],
      current: [],
      candidates: [
        {
          id: "kc-1",
          businessId: "biz-fiction",
          accountId: "",
          key: "price_line",
          subjectId: "plated",
          value: { unitCents: 9500 },
          confidence: "probable",
          sourceReferences: [DOC_REF],
          sourceRevision: "v1",
          observedAt: "2026-09-17T00:00:00.000Z",
          ingestedAt: "2026-09-17T00:00:00.000Z",
          status: "pending",
          conflictsWith: ["kc-2"],
          sourceLabel: "Fictional pricing sheet",
          currentFact: null,
        },
        {
          id: "kc-2",
          businessId: "biz-fiction",
          accountId: "",
          key: "price_line",
          subjectId: "plated",
          value: { unitCents: 10500 },
          confidence: "uncertain",
          sourceReferences: [DOC_REF],
          sourceRevision: "v2",
          observedAt: "2026-09-17T00:00:00.000Z",
          ingestedAt: "2026-09-17T00:00:00.000Z",
          status: "pending",
          conflictsWith: ["kc-1"],
          sourceLabel: "Fictional pricing sheet",
          currentFact: {
            id: "fact-1",
            businessId: "biz-fiction",
            key: "price_line",
            value: { unitCents: 9000 },
            confidence: "verified",
            sourceReferences: [DOC_REF],
            observedAt: "2026-09-17T00:00:00.000Z",
            revision: 3,
            accountId: "",
            subjectId: "plated",
            scope: "global",
            reviewState: "none",
          },
        },
      ],
    },
    selectedIds,
    onToggleCandidate: () => {},
    onBatchConfirm: () => {},
  };
}

test("005-A04 evidence review renders candidates, conflicts and batch confirm for keyboard/mobile", async () => {
  const { mod } = await loadComponents();
  const empty = render(mod.EvidenceReview, inspectionProps([]));
  assert.match(empty, /<input[^>]*type="checkbox"/, "native checkboxes, keyboard operable");
  assert.match(empty, /for="candidate-kc-1"/, "labels linked to controls");
  assert.match(empty, /Conflicts with:/, "conflicts visible");
  assert.match(empty, /No confirmed fact yet/, "current-vs-new distinction visible");
  assert.match(empty, /revision 3/, "current counterpart shown");
  assert.match(empty, /disabled/, "confirm disabled with nothing selected");
  assert.match(empty, /Missing information/, "missing keys shown");

  const selected = render(mod.EvidenceReview, inspectionProps(["kc-1"]));
  assert.match(selected, /Confirm 1 selected/, "count on the action");
  assert.ok(!/disabled/.test(selected), "confirm enabled with a selection");

  writeEvidence("evidence-review", 1440, selected);
  writeEvidence("evidence-review", 390, selected);
});

test("005-A04 rule confirmation shows parsed scope; ambiguity shows questions, never a confirm", async () => {
  const { mod } = await loadComponents();
  const parsed = render(mod.RuleConfirmation, {
    result: {
      status: "parsed",
      echo: "Give booking booking-7 10% off, up to $500 USD",
      draft: {
        kind: "concession-policy",
        key: "policy",
        subjectId: "concessions",
        scope: { type: "booking", id: "booking-7", label: "booking booking-7 only" },
        value: { allowed: true },
        limits: ["at most 10% per proposal", "at most 500.00 USD cumulative"],
        warnings: ["Every outbound action still needs its own exact approval."],
        sendAuthority: "none",
      },
    },
    onConfirm: () => {},
    onBack: () => {},
  });
  assert.match(parsed, /booking booking-7 only/, "visible scope before confirmation");
  assert.match(parsed, /<strong>none<\/strong>/, "no send authority, stated plainly");
  assert.match(parsed, /Confirm as owner policy/, "explicit owner confirm control");

  const unclear = render(mod.RuleConfirmation, {
    result: {
      status: "needs_clarification",
      echo: "give them a deal",
      questions: ["Which scope does this concession cover?"],
    },
    onConfirm: () => {},
    onBack: () => {},
  });
  assert.match(unclear, /Which scope does this concession cover\?/);
  assert.match(unclear, /Nothing was saved/);
  assert.ok(!unclear.includes("Confirm as owner policy"), "no confirm path when ambiguous");

  writeEvidence("rule-confirmation", 1440, parsed);
  writeEvidence("rule-confirmation", 390, parsed);
});

test("005-A04 concession form is labelled, scoped, and disclaims send authority", async () => {
  const { mod } = await loadComponents();
  const markup = render(mod.ConcessionForm, { onSubmit: () => {} });
  for (const id of [
    "concession-scope-type",
    "concession-scope-id",
    "concession-percent",
    "concession-cap",
    "concession-floor",
    "concession-dates",
    "concession-packages",
  ]) {
    assert.match(markup, new RegExp(`for="${id}"`), `label for ${id}`);
    assert.match(markup, new RegExp(`id="${id}"`), `control id ${id}`);
  }
  assert.match(markup, /<select/, "native scope select");
  assert.match(markup, /One booking/, "booking scope option");
  assert.match(markup, /One customer/, "customer scope option");
  assert.ok(!/grant.*send|send.*approv|auto-send|standing approval/i.test(markup), "no send-authority grant offered");
  assert.match(markup, /no standing send authority/i, "disclaimer rendered");

  const errored = render(mod.ConcessionForm, { onSubmit: () => {}, serverError: "scope id is required" });
  assert.match(errored, /role="alert"/, "errors announced to assistive tech");

  writeEvidence("concession-form", 1440, markup);
  writeEvidence("concession-form", 390, markup);
});

test("005-A04 empty/error states keep no-facts, unavailable, stale and error distinct", async () => {
  const { mod } = await loadComponents();
  const bodies: Record<string, string> = {};
  for (const variant of ["no-facts", "unavailable", "stale", "error"] as const) {
    const markup = render(mod.KnowledgeEmptyState, {
      variant,
      detail: "fictional detail",
      reasons: variant === "stale" ? ["price_line/plated is withheld: source changed"] : [],
      onRetry: () => {},
    });
    bodies[variant] = markup;
  }
  const titles = new Set(
    Object.values(bodies).map((markup) => markup.match(/<h2[^>]*>([^<]+)<\/h2>/)?.[1]),
  );
  assert.equal(titles.size, 4, "four distinct states, never collapsed");
  for (const variant of ["unavailable", "stale", "error"] as const) {
    assert.ok(
      !bodies[variant]!.includes("No business information found yet"),
      `${variant} must never read as an empty result`,
    );
  }
  assert.match(bodies["stale"]!, /price_line\/plated is withheld/, "stale names withheld facts");
  writeEvidence("empty-states", 1440, Object.values(bodies).join("\n"));
});

test("005-A04 eval trend renders denominators, verdict and disclaimer", async () => {
  const { mod } = await loadComponents();
  const markup = render(mod.EvalTrend, {
    comparison: {
      caseSetVersion: "005-v1",
      before: { passed: 5, denominator: 6 },
      after: { passed: 5, denominator: 7 },
      verdict: "unchanged",
      sharedCaseIds: ["K01", "K02", "K03", "K04", "K05", "K06"],
      sharedBeforePassed: 5,
      sharedAfterPassed: 5,
      addedCaseIds: ["K07"],
      removedCaseIds: [],
      denominatorNote: "Denominator changed (added: K07). Verdict compares only the 6 shared cases.",
      disclaimer: "Scores describe only this versioned case set.",
    },
  });
  assert.match(markup, /<table/, "score table");
  assert.match(markup, /5\/6/, "before numerator/denominator");
  assert.match(markup, /5\/7/, "after numerator/denominator");
  assert.match(markup, /unchanged/, "honest verdict");
  assert.match(markup, /K07/, "added cases listed");
  assert.match(markup, /Scores describe only this versioned case set/, "disclaimer rendered");
  writeEvidence("eval-trend", 1440, markup);
});

test("005-A04 interactive controls are native and keyboard-focusable", async () => {
  const { mod } = await loadComponents();
  const pages = [
    render(mod.EvidenceReview, inspectionProps(["kc-1"])),
    render(mod.ConcessionForm, { onSubmit: () => {} }),
    render(mod.RuleConfirmation, {
      result: {
        status: "parsed",
        echo: "x",
        draft: {
          kind: "capacity",
          key: "space",
          subjectId: "hall",
          scope: { type: "global", label: "whole business" },
          value: {},
          limits: [],
          warnings: [],
          sendAuthority: "none",
        },
      },
      onConfirm: () => {},
      onBack: () => {},
    }),
  ];
  for (const markup of pages) {
    assert.ok(/<(button|input|select)[\s>]/.test(markup), "native controls present");
    assert.ok(!/<div[^>]*(onclick|role="button")/i.test(markup), "no fake div-buttons");
    assert.ok(!/tabindex="[1-9]/i.test(markup), "no positive tabindex traps");
  }
});
