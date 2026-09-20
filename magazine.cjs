const { TypeSafeClient, score, noul } = require('@typesafe-ai/sdk');

const client = new TypeSafeClient();

async function editorialPlacement({ title, excerpt, category }) {
  const res = await client.systemOne({
    state: { title, excerpt, category },
    questions: {
      placement: score('How homepage-worthy is this article?', [
        'Filler: compact listing only',
        'Standard card',
        'Section lead',
        'Homepage hero',
      ]),
    },
    model: 'jev-latest',
  });
  return res.answers.placement;
}

async function breakingUrgency({ title, excerpt }) {
  const res = await client.systemOne({
    state: { title, excerpt },
    questions: { breaking: noul('Is this breaking news requiring the Fresh strip?') },
    model: 'jev-latest',
  });
  return res.answers.breaking.noul;
}

async function rerankCandidates(query, candidates) {
  const questions = {};
  candidates.forEach((c, i) => {
    questions[`c${i}`] = noul({
      question: 'Is this article relevant to the search query?',
      compare: ['`query`', `\`candidates[${i}]\``],
    });
  });
  const res = await client.systemOne({
    state: { query, candidates },
    questions,
    model: 'jev-latest',
  });
  return candidates
    .map((c, i) => ({ candidate: c, p: res.answers[`c${i}`].noul }))
    .sort((a, b) => b.p - a.p);
}

module.exports = { editorialPlacement, breakingUrgency, rerankCandidates };
