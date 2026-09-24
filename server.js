// Akinator-style guessing game + Jev decision showcase.
// Every decision Jev makes (which question to ask, whether to guess yet,
// who the final guess is) is logged with probabilities and latency, and
// returned to the frontend so you can watch the decision model think.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_TIMEOUT_MS = 8000;
const MAX_QUESTIONS = 20;
const MIN_QUESTIONS_BEFORE_GUESS = 4;
const GUESS_CONFIDENCE_THRESHOLD = 0.7;
const JEV_MAX_OPTIONS = 150; // comfortably under the 255-per-call limit

const app = express();
app.use(express.json());

// ---------- data ----------
const characters = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'characters.json'), 'utf8'));
const questions = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'questions.json'), 'utf8'));
const CUSTOM_PATH = path.join(DATA_DIR, 'custom.json');
let custom = [];
try { custom = JSON.parse(fs.readFileSync(CUSTOM_PATH, 'utf8')); } catch { custom = []; }
const allCharacters = () => characters.concat(custom);
const byId = id => allCharacters().find(c => c.id === id);
const questionById = id => questions.find(q => q.id === id);

// ---------- Jev ----------
const JEV_KEY = (process.env.TYPESAFE_API_KEY || '').trim();
const jevAvailable = () => Boolean(JEV_KEY);
let jevLastError = null;

async function jevCall(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(JEV_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${JEV_KEY}` },
      body: JSON.stringify({ model: 'jev-latest', ...body }),
      signal: controller.signal,
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      jevLastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      console.error('[jev]', jevLastError);
      return { error: jevLastError, ms };
    }
    jevLastError = null;
    return { data: await res.json(), ms };
  } catch (err) {
    const ms = Date.now() - t0;
    jevLastError = `Network/timeout: ${err.message}`;
    console.error('[jev]', jevLastError);
    return { error: jevLastError, ms };
  } finally {
    clearTimeout(timer);
  }
}

function logJev(session, entry) {
  session.jev.push({ at: new Date().toISOString(), ...entry });
}

function historyText(session) {
  return session.history
    .map(h => `Q: ${h.question} -> ${h.answer}`)
    .join('\n') || '(no answers yet)';
}

// Decision 1: which question to ask next (Jev choice over unasked questions).
async function pickNextQuestion(session) {
  const unasked = questions.filter(q => !(q.id in session.asked));
  if (!unasked.length) return null;

  if (jevAvailable()) {
    const state =
      `You are playing a 20-questions character guessing game.\n` +
      `Candidates remaining: ${session.candidates.length}. ` +
      `Questions asked so far: ${Object.keys(session.asked).length}.\n` +
      `Answer history:\n${historyText(session)}`;
    const criteria = {};
    for (const q of unasked) criteria[q.id] = q.text;
    const { data, ms, error } = await jevCall({
      state,
      questions: {
        next_question: {
          type: 'choice',
          instructions: 'Pick the single question that will best narrow down who the player is thinking of.',
          criteria,
        },
      },
    });
    const ans = data && data.answers && data.answers.next_question;
    if (!error && ans && ans.choice && questionById(ans.choice)) {
      const probs = Object.entries(ans.probabilities || {})
        .map(([id, p]) => ({ label: questionById(id) ? questionById(id).text : id, p }))
        .sort((a, b) => b.p - a.p)
        .slice(0, 5);
      logJev(session, {
        kind: 'pick',
        title: 'Jev picked the next question',
        detail: questionById(ans.choice).text,
        probs,
        confidence: ans.confidence,
        ms,
        fallback: false,
      });
      return questionById(ans.choice);
    }
    if (error) console.error('[jev] pick failed, using local fallback');
  }

  // Local fallback: max information gain.
  const q = bestQuestionInfoGain(session);
  logJev(session, {
    kind: 'pick',
    title: 'Next question (local brain)',
    detail: q ? q.text : 'none left',
    probs: [],
    confidence: null,
    ms: 0,
    fallback: true,
  });
  return q;
}

// Decision 2: guess now or keep asking? (Jev yes/no probability.)
async function jevShouldGuess(session) {
  const names = session.candidates.map(byId).filter(Boolean).map(c => c.name);
  const shown = names.slice(0, 80);
  const state =
    `You are playing a 20-questions character guessing game.\n` +
    `Questions asked: ${Object.keys(session.asked).length} of ${MAX_QUESTIONS}.\n` +
    `Candidates remaining: ${names.length}` +
    (names.length > shown.length ? ` (showing ${shown.length}): ${shown.join(', ')}` : `: ${shown.join(', ')}`) + `\n` +
    `Answer history:\n${historyText(session)}`;
  const { data, ms, error } = await jevCall({
    state,
    questions: {
      should_guess: {
        type: 'noul',
        instructions: 'Given the answers so far and the remaining candidates, are you confident enough to make the final guess NOW instead of asking another question?',
      },
    },
  });
  const ans = data && data.answers && data.answers.should_guess;
  if (!error && ans && typeof ans.noul === 'number') {
    return { p: ans.noul, ms, fallback: false };
  }
  return { p: 0, ms: ms || 0, fallback: true };
}

// Decision 3: who is it? (Jev choice over remaining candidates.)
function doGuess(session, reason) {
  const cands = session.candidates.map(byId).filter(Boolean);
  session.phase = 'guess';

  const finish = (char, probs, ms, fallback, note) => {
    session.guessId = char ? char.id : null;
    logJev(session, {
      kind: 'guess',
      title: 'Jev made the final guess',
      detail: char ? `${char.emoji || ''} ${char.name}`.trim() : 'no candidates',
      probs: probs || [],
      confidence: null,
      ms: ms || 0,
      fallback: !!fallback,
      verdict: note || reason,
    });
    return {
      type: 'guess',
      guess: char ? { id: char.id, name: char.name, emoji: char.emoji } : null,
      candidatesLeft: cands.length,
      asked: Object.keys(session.asked).length,
      reason,
    };
  };

  if (!cands.length) return Promise.resolve(finish(null, [], 0, false, 'no candidates left'));
  if (cands.length === 1) return Promise.resolve(finish(cands[0], [], 0, false, 'only one candidate left'));

  if (jevAvailable() && cands.length <= JEV_MAX_OPTIONS) {
    const criteria = {};
    for (const c of cands) criteria[c.id] = c.name;
    return jevCall({
      state:
        `20-questions character guessing game. Answer history:\n${historyText(session)}\n` +
        `Pick who the player is thinking of.`,
      questions: {
        final_guess: {
          type: 'choice',
          instructions: 'Based on all the answers, pick the character the player is most likely thinking of.',
          criteria,
        },
      },
    }).then(({ data, ms, error }) => {
      const ans = data && data.answers && data.answers.final_guess;
      if (!error && ans && ans.choice && byId(ans.choice)) {
        const probs = Object.entries(ans.probabilities || {})
          .map(([id, p]) => ({ label: byId(id) ? byId(id).name : id, p }))
          .sort((a, b) => b.p - a.p)
          .slice(0, 5);
        return finish(byId(ans.choice), probs, ms, false, reason);
      }
      if (error) console.error('[jev] guess failed, using local fallback');
      return finish(cands[0], [], 0, true, 'jev unavailable, top candidate');
    });
  }
  return Promise.resolve(finish(
    cands[0], [], 0, true,
    cands.length > JEV_MAX_OPTIONS ? 'too many candidates for one Jev call' : 'jev unavailable'
  ));
}

// ---------- game logic ----------
function bestQuestionInfoGain(session) {
  const cands = session.candidates;
  let best = null, bestScore = -1;
  for (const q of questions) {
    if (q.id in session.asked) continue;
    let yes = 0;
    for (const id of cands) {
      const c = byId(id);
      if (c && c.attrs && c.attrs[q.attr]) yes++;
    }
    const no = cands.length - yes;
    const score = Math.min(yes, no); // split closest to 50/50
    if (score > bestScore) { bestScore = score; best = q; }
  }
  return best;
}

function filterCandidates(session) {
  let cands = allCharacters().map(c => c.id);
  for (const [qid, ans] of Object.entries(session.asked)) {
    if (ans === 'unknown') continue;
    const q = questionById(qid);
    if (!q) continue;
    cands = cands.filter(id => {
      const c = byId(id);
      const has = !!(c && c.attrs && c.attrs[q.attr]);
      return ans === 'yes' ? has : !has;
    });
  }
  session.candidates = cands;
}

async function nextStep(session) {
  const asked = Object.keys(session.asked).length;
  const remaining = session.candidates.length;
  const outOfQuestions = !questions.some(q => !(q.id in session.asked));

  let guessNow = false;
  let reason = '';
  if (remaining <= 1) {
    guessNow = true; reason = 'single candidate';
  } else if (asked >= MAX_QUESTIONS || outOfQuestions) {
    guessNow = true; reason = 'out of questions';
  } else if (jevAvailable() && asked >= MIN_QUESTIONS_BEFORE_GUESS) {
    const g = await jevShouldGuess(session);
    const pct = Math.round(g.p * 100);
    logJev(session, {
      kind: 'should_guess',
      title: 'Jev decided: guess now or keep asking?',
      detail: g.fallback ? 'Jev unreachable, keep asking' : `confidence ${pct}%`,
      probs: g.fallback ? [] : [{ label: 'Guess now', p: g.p }, { label: 'Keep asking', p: 1 - g.p }],
      confidence: g.p,
      ms: g.ms,
      fallback: g.fallback,
      verdict: !g.fallback && g.p >= GUESS_CONFIDENCE_THRESHOLD ? 'Guessing now' : 'Asking another question',
    });
    if (!g.fallback && g.p >= GUESS_CONFIDENCE_THRESHOLD) {
      guessNow = true; reason = `jev confident (${pct}%)`;
    }
  }

  if (guessNow) return doGuess(session, reason);
  const q = await pickNextQuestion(session);
  if (!q) return doGuess(session, 'no questions left');
  return {
    type: 'question',
    question: { id: q.id, text: q.text },
    candidates: session.candidates.length,
    asked,
  };
}

// ---------- sessions ----------
const sessions = new Map();
function newSession() {
  const s = {
    id: crypto.randomUUID(),
    asked: {},
    history: [],
    candidates: allCharacters().map(c => c.id),
    phase: 'playing',
    guessId: null,
    jev: [],
  };
  sessions.set(s.id, s);
  return s;
}
const getSession = id => sessions.get(id);

// ---------- API ----------
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    jevAvailable: jevAvailable(),
    jevError: jevLastError,
    characters: allCharacters().length,
    questions: questions.length,
  });
});

app.post('/api/new', async (req, res) => {
  const s = newSession();
  logJev(s, {
    kind: 'info',
    title: 'New game started',
    detail: `${s.candidates.length} characters in the world`,
    probs: [],
    confidence: null,
    ms: 0,
    fallback: false,
  });
  const step = await nextStep(s);
  res.json({ sessionId: s.id, ...step, jev: s.jev });
});

app.post('/api/answer', async (req, res) => {
  const { sessionId, questionId, answer } = req.body || {};
  const s = getSession(sessionId);
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (s.phase !== 'playing') return res.status(400).json({ error: 'game already over' });
  if (!questionById(questionId) || !['yes', 'no', 'unknown'].includes(answer)) {
    return res.status(400).json({ error: 'bad request' });
  }
  s.asked[questionId] = answer;
  s.history.push({ question: questionById(questionId).text, answer });
  filterCandidates(s);
  const step = await nextStep(s);
  res.json({ sessionId: s.id, ...step, jev: s.jev });
});

app.post('/api/guess-result', (req, res) => {
  const { sessionId, correct } = req.body || {};
  const s = getSession(sessionId);
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (correct) {
    s.phase = 'done';
    const name = byId(s.guessId) ? byId(s.guessId).name : '';
    logJev(s, { kind: 'info', title: 'Jev got it right', detail: name, probs: [], confidence: null, ms: 0, fallback: false });
    return res.json({ type: 'win', guess: byId(s.guessId), jev: s.jev });
  }
  s.phase = 'learn';
  logJev(s, { kind: 'info', title: 'Jev missed — teach it', detail: 'add the character so it knows next time', probs: [], confidence: null, ms: 0, fallback: false });
  res.json({ type: 'stumped', jev: s.jev });
});

app.post('/api/learn', (req, res) => {
  const { sessionId, name, emoji } = req.body || {};
  const s = getSession(sessionId);
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const attrs = {};
  for (const [qid, ans] of Object.entries(s.asked)) {
    if (ans !== 'yes') continue;
    const q = questionById(qid);
    if (q) attrs[q.attr] = true;
  }
  const entry = {
    id: 'custom-' + crypto.randomUUID().slice(0, 8),
    name: name.trim(),
    emoji: (emoji || '').trim() || '❓',
    kind: 'fictional',
    attrs,
  };
  custom.push(entry);
  fs.writeFileSync(CUSTOM_PATH, JSON.stringify(custom, null, 2) + '\n');
  s.phase = 'done';
  logJev(s, { kind: 'info', title: 'Learned a new character', detail: entry.name, probs: [], confidence: null, ms: 0, fallback: false });
  res.json({ ok: true, learned: entry.name, jev: s.jev });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`akinator-game on http://localhost:${PORT}`));
