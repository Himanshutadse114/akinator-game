// Akinator-style guessing game backend.
// Optional Jev (TypeSafe AI) integration: set TYPESAFE_API_KEY to let Jev pick
// questions and guesses. The key never leaves the server.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_TIMEOUT_MS = 8000;
const MAX_QUESTIONS = 20;

const app = express();
app.use(express.json());

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch {
    return fallback;
  }
}

const seedCharacters = loadJson('characters.json', []);
const questions = loadJson('questions.json', []);
let customCharacters = loadJson('custom.json', []);
if (!Array.isArray(customCharacters)) customCharacters = [];

const allCharacters = () => seedCharacters.concat(customCharacters);
const charById = (id) => allCharacters().find((c) => c.id === id);
const questionById = (id) => questions.find((q) => q.id === id);
const hasAttr = (c, attr) => Boolean(c && c.attrs && c.attrs[attr]);

const sessions = new Map();
const newSessionId = () => crypto.randomBytes(8).toString('hex');
// Trim: on Windows `set KEY=value && npm start` can sneak a trailing space into the value.
const JEV_KEY = (process.env.TYPESAFE_API_KEY || '').trim();
const jevAvailable = () => Boolean(JEV_KEY);
let jevLastError = null; // surfaced via /api/status so failures are visible, not silent

// ---------- Jev helpers ----------
async function jevCall(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
  try {
    const res = await fetch(JEV_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + JEV_KEY,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const snippet = (await res.text()).slice(0, 200);
      jevLastError = `HTTP ${res.status}: ${snippet}`;
      console.warn(`[jev] API error ${res.status}: ${snippet}`);
      return null;
    }
    jevLastError = null;
    return await res.json();
  } catch (err) {
    jevLastError = `network/timeout: ${err && err.message ? err.message : err}`;
    console.warn(`[jev] network error: ${jevLastError}`);
    return null; // network error / timeout -> caller falls back
  } finally {
    clearTimeout(timer);
  }
}

function historyText(session) {
  const lines = Object.entries(session.asked).map(([qid, ans]) => {
    const q = questionById(qid);
    return `- "${q ? q.text : qid}" -> ${ans}`;
  });
  return lines.length ? lines.join('\n') : '(no answers yet)';
}

async function jevPickQuestion(session) {
  const unasked = questions.filter((q) => !(q.id in session.asked));
  if (!unasked.length) return null;
  const names = session.candidates.map((id) => {
    const c = charById(id);
    return c ? c.name : id;
  });
  const criteria = {};
  unasked.forEach((q) => {
    criteria[q.id] = q.text;
  });
  const data = await jevCall({
    model: 'jev-latest',
    state:
      `The player is thinking of a character. Remaining candidates (${names.length}): ${names.join(', ')}.\n` +
      `Answers so far:\n${historyText(session)}`,
    questions: {
      pick: {
        type: 'choice',
        instructions:
          'Which question, if answered, would best narrow down which character the player is thinking of?',
        criteria,
      },
    },
  });
  const choice = data && data.answers && data.answers.pick && data.answers.pick.choice;
  if (choice && unasked.some((q) => q.id === choice)) return choice;
  return null;
}

// Fallback (also used when no API key): information gain —
// pick the unasked question whose yes/no split is closest to 50/50.
function fallbackPickQuestion(session) {
  const unasked = questions.filter((q) => !(q.id in session.asked));
  if (!unasked.length) return null;
  const n = session.candidates.length;
  const shuffled = unasked.slice().sort(() => Math.random() - 0.5); // random tiebreak
  let best = null;
  let bestScore = -Infinity;
  for (const q of shuffled) {
    const yes = session.candidates.filter((id) => hasAttr(charById(id), q.attr)).length;
    const score = -Math.abs(yes - (n - yes));
    if (score > bestScore) {
      bestScore = score;
      best = q;
    }
  }
  return best ? best.id : null;
}

async function pickNextQuestion(session) {
  if (jevAvailable()) {
    const qid = await jevPickQuestion(session);
    if (qid) return questionById(qid);
  }
  const qid = fallbackPickQuestion(session);
  return qid ? questionById(qid) : null;
}

async function pickGuess(session) {
  const cands = session.candidates.map(charById).filter(Boolean);
  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];
  if (jevAvailable()) {
    const criteria = {};
    cands.forEach((c) => {
      criteria[c.id] = c.name;
    });
    const data = await jevCall({
      model: 'jev-latest',
      state:
        `The player is thinking of a character. Candidates: ${cands.map((c) => c.name).join(', ')}.\n` +
        `Answers so far:\n${historyText(session)}`,
      questions: {
        guess: {
          type: 'choice',
          instructions: 'Which character is the player most likely thinking of?',
          criteria,
        },
      },
    });
    const choice = data && data.answers && data.answers.guess && data.answers.guess.choice;
    const picked = cands.find((c) => c.id === choice);
    if (picked) return picked;
  }
  return cands[0];
}

function yesAttrsFrom(session) {
  const out = [];
  for (const [qid, ans] of Object.entries(session.asked)) {
    if (ans === 'yes') {
      const q = questionById(qid);
      if (q) out.push({ attr: q.attr, text: q.text });
    }
  }
  return out;
}

async function nextStep(session) {
  const askedCount = Object.keys(session.asked).length;
  const outOfQuestions = !questions.some((q) => !(q.id in session.asked));
  // Only guess when there's a single clear winner, or we've truly run out of
  // questions. Never guess early just because few candidates remain — keep digging.
  if (session.candidates.length <= 1 || askedCount >= MAX_QUESTIONS || outOfQuestions) {
    const guess = await pickGuess(session);
    if (!guess) return { type: 'stumped', sessionId: session.id, yesAttrs: yesAttrsFrom(session) };
    session.lastGuess = guess.id;
    return {
      type: 'guess',
      id: guess.id,
      name: guess.name,
      emoji: guess.emoji,
      kind: guess.kind,
      sessionId: session.id,
      progress: { asked: askedCount, remaining: session.candidates.length },
    };
  }
  const q = await pickNextQuestion(session);
  if (!q) {
    const guess = await pickGuess(session);
    if (!guess) return { type: 'stumped', sessionId: session.id, yesAttrs: yesAttrsFrom(session) };
    session.lastGuess = guess.id;
    return {
      type: 'guess',
      id: guess.id,
      name: guess.name,
      emoji: guess.emoji,
      kind: guess.kind,
      sessionId: session.id,
      progress: { asked: askedCount, remaining: session.candidates.length },
    };
  }
  return {
    type: 'question',
    question: q,
    sessionId: session.id,
    progress: { asked: askedCount, remaining: session.candidates.length },
  };
}

// ---------- API ----------
app.get('/api/status', (req, res) => {
  res.json({ jevAvailable: jevAvailable(), jevError: jevLastError });
});

app.post('/api/new', async (req, res) => {
  const session = {
    id: newSessionId(),
    candidates: allCharacters().map((c) => c.id),
    asked: {},
    lastGuess: null,
  };
  sessions.set(session.id, session);
  res.json(await nextStep(session));
});

app.post('/api/answer', async (req, res) => {
  const { sessionId, questionId, answer } = req.body || {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(400).json({ error: 'unknown session' });
  const q = questionById(questionId);
  if (!q || !['yes', 'no', 'unknown'].includes(answer)) {
    return res.status(400).json({ error: 'bad answer payload' });
  }
  session.asked[questionId] = answer;
  if (answer !== 'unknown') {
    const filtered = session.candidates.filter((id) => {
      const has = hasAttr(charById(id), q.attr);
      return answer === 'yes' ? has : !has;
    });
    if (filtered.length > 0) session.candidates = filtered; // keep previous set if empty
  }
  res.json(await nextStep(session));
});

app.post('/api/guess-result', async (req, res) => {
  const { sessionId, correct } = req.body || {};
  const session = sessions.get(sessionId);
  if (!session) return res.status(400).json({ error: 'unknown session' });
  if (correct) {
    sessions.delete(sessionId);
    return res.json({ type: 'win', sessionId });
  }
  if (session.lastGuess) {
    session.candidates = session.candidates.filter((id) => id !== session.lastGuess);
  }
  session.lastGuess = null;
  const askedCount = Object.keys(session.asked).length;
  if (session.candidates.length === 0 || askedCount >= MAX_QUESTIONS) {
    return res.json({ type: 'stumped', sessionId, yesAttrs: yesAttrsFrom(session) });
  }
  const step = await nextStep(session);
  if (step.type === 'stumped') step.yesAttrs = yesAttrsFrom(session);
  res.json(step);
});

app.post('/api/learn', (req, res) => {
  const { name, kind, yesAttrs } = req.body || {};
  if (!name || !['real', 'fictional'].includes(kind)) {
    return res.status(400).json({ error: 'bad learn payload' });
  }
  const attrs = {};
  (Array.isArray(yesAttrs) ? yesAttrs : []).forEach((a) => {
    attrs[a] = true;
  });
  const entry = {
    id: 'custom-' + Date.now().toString(36),
    name: String(name).slice(0, 80),
    emoji: '❓',
    kind,
    attrs,
  };
  customCharacters.push(entry);
  try {
    fs.writeFileSync(
      path.join(DATA_DIR, 'custom.json'),
      JSON.stringify(customCharacters, null, 2) + '\n'
    );
  } catch {
    return res.status(500).json({ error: 'could not save' });
  }
  res.json({ ok: true, id: entry.id });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`akinator-game listening on http://localhost:${PORT} (jev: ${jevAvailable() ? 'on' : 'off'})`);
});
