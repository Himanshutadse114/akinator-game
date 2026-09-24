let sessionId = null;
let currentQuestion = null;

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
  $(id).classList.remove('hidden');
}

async function init() {
  try {
    const st = await (await fetch('/api/status')).json();
    const pill = $('brain-pill');
    pill.textContent = st.jevAvailable
      ? `Jev connected · ${st.characters} characters`
      : `Local brain · ${st.characters} characters`;
    pill.classList.add(st.jevAvailable ? 'jev' : 'local');
  } catch {
    const pill = $('brain-pill');
    pill.textContent = 'Local brain';
    pill.classList.add('local');
  }
  show('screen-start');
}

async function startGame() {
  $('learn-msg').textContent = '';
  $('jev-log').innerHTML = '<p class="jev-empty">Press Start and watch Jev think.</p>';
  show('screen-loading');
  try {
    const step = await api('/api/new', {});
    handleStep(step);
  } catch {
    show('screen-start');
  }
}

function handleStep(step) {
  if (!step || step.error) {
    show('screen-start');
    return;
  }
  sessionId = step.sessionId || sessionId;
  renderJev(step.jev || []);
  if (step.type === 'question') {
    currentQuestion = step.question;
    $('question-text').textContent = step.question.text;
    $('progress').textContent =
      `Question ${step.asked + 1} · ${step.candidates} possibilities left`;
    show('screen-question');
  } else if (step.type === 'guess') {
    const g = step.guess || {};
    $('guess-emoji').textContent = g.emoji || '❓';
    $('guess-name').textContent = g.name || 'No idea!';
    $('guess-reason').textContent = step.reason ? `decided: ${step.reason}` : '';
    show('screen-guess');
  } else if (step.type === 'win') {
    $('win-name').textContent = step.guess && step.guess.name ? `${step.guess.emoji || ''} ${step.guess.name}` : '';
    show('screen-win');
  } else if (step.type === 'stumped') {
    $('learn-name').value = '';
    $('learn-emoji').value = '';
    show('screen-stumped');
  }
}

async function answer(a) {
  if (!currentQuestion) return;
  const qid = currentQuestion.id;
  currentQuestion = null;
  show('screen-loading');
  const step = await api('/api/answer', { sessionId, questionId: qid, answer: a });
  handleStep(step);
}

async function guessResult(correct) {
  show('screen-loading');
  const step = await api('/api/guess-result', { sessionId, correct });
  handleStep(step);
}

async function learn() {
  const name = $('learn-name').value.trim();
  const emoji = $('learn-emoji').value.trim();
  if (!name) {
    $('learn-msg').textContent = 'Please enter a name first.';
    return;
  }
  const r = await api('/api/learn', { sessionId, name, emoji });
  $('learn-msg').textContent = r.ok ? 'Learned! I will get it next time.' : 'Could not save.';
  if (r.jev) renderJev(r.jev);
}

const KIND_ICON = { pick: '🎯', should_guess: '🤔', guess: '🔮', info: 'ℹ️' };

function renderJev(log) {
  const box = $('jev-log');
  box.innerHTML = '';
  const jevDecisions = log.filter((e) => !e.fallback && e.kind !== 'info').length;
  $('jev-count').textContent = jevDecisions ? `${jevDecisions} decisions` : '';
  if (!log.length) {
    box.innerHTML = '<p class="jev-empty">Press Start and watch Jev think.</p>';
    return;
  }
  [...log].reverse().forEach((e) => {
    const div = document.createElement('div');
    div.className = 'jev-entry' + (e.fallback ? ' fallback' : '');
    const meta = [];
    if (e.ms) meta.push(`${e.ms}ms`);
    if (e.confidence != null && e.kind !== 'should_guess') meta.push(`conf ${Math.round(e.confidence * 100)}%`);
    let bars = '';
    (e.probs || []).forEach((p) => {
      const pct = Math.round(p.p * 100);
      bars +=
        `<div class="bar"><span class="blabel">${escapeHtml(p.label)}</span>` +
        `<div class="btrack"><div class="bfill" style="width:${pct}%"></div></div>` +
        `<span class="bpct">${pct}%</span></div>`;
    });
    div.innerHTML =
      `<div class="jhead">${e.fallback ? '<span class="fbadge">local</span>' : '<span class="jbadge">jev</span>'}` +
      `<strong>${escapeHtml(e.title)}</strong></div>` +
      (e.detail ? `<div class="jdetail">${escapeHtml(e.detail)}</div>` : '') +
      bars +
      (e.verdict ? `<div class="jverdict">${escapeHtml(e.verdict)}</div>` : '') +
      (meta.length ? `<div class="jmeta">${KIND_ICON[e.kind] || ''} ${meta.join(' · ')}</div>` : '');
    box.appendChild(div);
  });
}

window.addEventListener('DOMContentLoaded', init);
