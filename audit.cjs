#!/usr/bin/env node
// Example: audit a landing page against a checklist of conversion elements.
// Each element is one atomic noul question; all of them ride in a single call.
//
//   node audit.cjs page.txt
//   curl -s https://example.com | node -e '...extract text...' | node audit.cjs
//
// This is the shape most "score my content" prompts should take: a fixed list
// of yes/no judgments about supplied text, not a prose request for a critique.
const { readFileSync } = require("node:fs");
const { decide, loadSDK } = require("./lib/decision-engine.cjs");

const CHECKS = {
  has_top_social_proof: "Does the text show social proof near the top, such as a user count, named customers, or testimonial avatars above the fold?",
  has_video_demo: "Does the text mention a video demo, interactive walkthrough, or looping GIF showing the product in use?",
  has_testimonials: "Are there direct quoted testimonials attributed to named customers?",
  has_trusted_logos: "Is there a 'trusted by' section naming specific companies that use this product?",
  has_pricing: "Are concrete prices or pricing tiers stated?",
  has_founder_note: "Is there a founder, builder, or team introduction section?",
  has_faq: "Is there a frequently-asked-questions section?",
  has_risk_reversal: "Is there an explicit guarantee, refund, or escrow promise that reduces buyer risk?",
  has_bottom_cta: "Does the page close with a clear call to action?",
};

async function main() {
  const file = process.argv[2];
  const pageText = (file ? readFileSync(file, "utf8") : readFileSync(0, "utf8")).slice(0, 20000);
  if (!pageText.trim()) {
    console.error("Usage: node audit.cjs <page.txt>   (or pipe page text on stdin)");
    process.exit(2);
  }
  const SDK = loadSDK();
  if (!SDK) {
    console.error("@typesafe-ai/sdk is not installed; run npm install");
    process.exit(2);
  }
  const questions = Object.fromEntries(
    Object.entries(CHECKS).map(([id, q]) => [id, SDK.noul(q)]),
  );
  const res = await decide({ state: { pageText }, questions, downstream: "page-audit" });
  if (res.fallback) {
    console.error(`decision layer unavailable: ${res.reason}`);
    process.exit(1);
  }
  const missing = [];
  for (const [id, r] of Object.entries(res.results)) {
    const present = r.decision === "yes";
    if (!present && r.gate === "auto") missing.push(id);
    console.log(`${present ? "yes" : "no "}  ${String(r.confidence.toFixed(2)).padEnd(5)} ${r.gate.padEnd(8)} ${id}`);
  }
  console.log(`\nConfidently missing: ${missing.length ? missing.join(", ") : "nothing"}`);
}

main().catch((e) => {
  console.error("audit:", String((e && e.message) || e).slice(0, 200));
  process.exit(1);
});
