const { TypeSafeClient } = require('@typesafe-ai/sdk');

async function main() {
  const key = process.env.TYPESAFE_API_KEY || '';
  console.log('key present:', key.length > 0, 'len:', key.length);
  if (!key) { console.error('missing TYPESAFE_API_KEY'); process.exit(1); }
  const client = new TypeSafeClient();
  const models = await client.models.list();
  console.log('models:', models.map((m) => m.name).join(', '));
  const res = await client.systemOne({
    state: { title: 'Agent stack 2026', excerpt: 'Production patterns' },
    questions: { urgent: require('@typesafe-ai/sdk').noul('Does this convey urgency?') },
    model: 'jev-latest',
  });
  console.log('model:', res.model, 'noul:', res.answers.urgent.noul);
}
main().catch((e) => { console.error('ERR', e.message.slice(0, 200)); process.exit(1); });
