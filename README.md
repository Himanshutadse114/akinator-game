# Mind Reader — Akinator-style guessing game

Think of **any character** (real or fictional). The app asks yes/no questions,
narrows the candidates, and guesses who you're thinking of. If it fails, you
can teach it the character and it remembers forever.

## Run it

```bash
cd ~/workspace/akinator-game
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

## Enable Jev (TypeSafe AI)

Without a key the app uses a built-in information-gain brain (picks the
question with the closest 50/50 yes/no split). With a key, Jev picks the
questions and makes the final guess:

```bash
TYPESAFE_API_KEY=sk-... npm start
```

The pill at the top shows **Jev connected** or **Local brain**. The key is only
ever used server-side — it is never sent to the browser.

## How the learning works

- `data/characters.json` — the seed database (~69 well-known characters).
- `data/questions.json` — the 24 yes/no questions.
- `data/custom.json` — starts as `[]`. Every character you teach the game via
  the "You stumped me!" screen is appended here, and the server merges it with
  the seed database on every request. Edit or delete entries by hand if you
  like; restart is not required.

## API

- `GET /api/status` → `{ jevAvailable: bool }`
- `POST /api/new` → first question, plus `sessionId`
- `POST /api/answer` `{ sessionId, questionId, answer: "yes"|"no"|"unknown" }`
  → next `{ type: "question", ... }` or `{ type: "guess", ... }`
- `POST /api/guess-result` `{ sessionId, correct: bool }`
  → `{ type: "win" }`, another question/guess, or `{ type: "stumped" }`
- `POST /api/learn` `{ name, kind: "real"|"fictional", yesAttrs: [...] }`
  → `{ ok: true }`

Sessions live in a server-side Map; the client echoes `sessionId` back on
every call.
