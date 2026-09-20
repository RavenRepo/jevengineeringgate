// Cascade demo: classifier.dev (keyless batch pre-filter) -> Jev (precise rerank).
// Run: node --env-file=.env cascade.cjs
const { rerankCandidates } = require('./magazine.cjs');

// Anything the filter is unsure about survives: a dropped item is invisible.
const KEEP_CONFIDENCE = 0.8;
const PREFILTER_TIMEOUT_MS = 8000;

async function prefilter(query, snippets) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREFILTER_TIMEOUT_MS);
  try {
    const res = await fetch('https://classifier.dev', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'jev-cascade/1.0' },
      body: JSON.stringify({
        labels: ['relevant', 'not relevant'],
        inputs: snippets,
        instructions: `Relevant means it helps answer: ${query}. When in doubt, keep it.`,
      }),
      signal: controller.signal,
    });
    const { results } = await res.json();
    return snippets.filter(
      (_, i) => results[i].label === 'relevant' || results[i].confidence < KEEP_CONFIDENCE,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const query = 'how do I build a production AI agent';
  const snippets = [
    'Agent stack 2026 production patterns',
    'How to bake sourdough bread',
    'MCP tool servers in practice',
    'The weather is nice today',
    'CrewAI alternatives compared',
  ];
  const survivors = await prefilter(query, snippets);
  console.log('survivors:', survivors.length, '/', snippets.length);
  const ranked = await rerankCandidates(query, survivors);
  for (const r of ranked) console.log(r.p.toFixed(2), r.candidate);
}
main().catch((e) => { console.error('ERR', e.message.slice(0, 200)); process.exit(1); });
