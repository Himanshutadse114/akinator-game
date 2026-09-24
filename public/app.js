let sessionId = null;
let currentQuestion = null;

const $ = (id) => document.getElementById(id);

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
    pill.textContent = st.jevAvailable ? 'Jev connected' : 'Local brain';
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
  if (step.type === 'question') {
    currentQuestion = step.question;
    $('question-text').textContent = step.question.text;
    $('progress').textContent =
      `Question ${step.progress.asked + 1} · ${step.progress.remaining} possibilities left`;
    show('screen-question');
  } else if (step.type === 'guess') {
    $('guess-emoji').textContent = step.emoji || '';
    $('guess-name').textContent = step.name;
    $('guess-kind').textContent = step.kind === 'real' ? 'Real person' : 'Fictional character';
    show('screen-guess');
  } else if (step.type === 'win') {
    show('screen-win');
  } else if (step.type === 'stumped') {
    buildLearnForm(step.yesAttrs || []);
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

function buildLearnForm(yesAttrs) {
  const box = $('learn-attrs');
  box.innerHTML = '';
  yesAttrs.forEach(({ attr, text }) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.value = attr;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + text));
    box.appendChild(label);
  });
  $('learn-name').value = '';
}

async function learn() {
  const name = $('learn-name').value.trim();
  const kindEl = document.querySelector('input[name="kind"]:checked');
  const kind = kindEl ? kindEl.value : 'real';
  const yesAttrs = [...document.querySelectorAll('#learn-attrs input:checked')].map((cb) => cb.value);
  if (!name) {
    $('learn-msg').textContent = 'Please enter a name first.';
    return;
  }
  const r = await api('/api/learn', { name, kind, yesAttrs });
  $('learn-msg').textContent = r.ok ? 'Learned! I will get it next time.' : 'Could not save.';
}

window.addEventListener('DOMContentLoaded', init);
