# Clear your head

A calm, single-focus to-do board. Dump every half-formed thought into one box,
let AI turn it into clean tasks, then pick one thing to work on and finish it.
Any task can be broken into a step-by-step checklist by AI, or by hand.

## Features

- **Brain dump to clean tasks.** Paste messy, unstructured thoughts and AI splits
  them, removes duplicates, and rewrites each one as a concrete, actionable to-do.
- **One-thing focus.** A three-column flow (To Do, In Progress, Done) with a
  focus limit that stops you from overloading In Progress.
- **AI step breakdowns.** Turn any task into an ordered checklist, with an
  optional instruction like "beginner, under 5 steps". Add or delete steps yourself too.
- **Voice input.** Dictate your brain dump with the browser's speech recognition.
- **Drag to reorder.** Rearrange cards within a column or move them between
  columns, with a live drop indicator.
- **Sync across devices.** Sign in with Google and your board follows you in real
  time. Without sign-in, everything stays local to the browser.

## How it works

- **AI stays server-side.** The browser calls a Next.js API route, which talks to
  the Anthropic API using a key that never reaches the client. The route is gated
  by Google sign-in, so only allowed accounts can trigger AI calls.
- **Real-time sync.** A signed-in user's board lives in a single Firestore
  document and streams to every open device via live snapshots. Local storage
  keeps a copy so the board still works offline and while signed out.
- **Voice.** Uses the browser Web Speech API, and quietly falls back to typing
  where it is not supported.

## Built with

- [Next.js](https://nextjs.org) (App Router)
- [Anthropic API](https://www.anthropic.com) for task organizing and step breakdowns
- [Firebase](https://firebase.google.com) Authentication and Cloud Firestore
- Web Speech API for voice dictation

## Run it locally

You will need Node 18+, an Anthropic API key, and a Firebase project with
Firestore and Google sign-in enabled.

```bash
npm install
cp .env.local.example .env.local   # then fill in your own values
npm run dev
```

Open <http://localhost:3000>. See `.env.local.example` for the values to provide.
Without Firebase configured, the app still runs in local-only mode with no
sign-in or sync.
