'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { firebaseReady, getAuthI, getDb, getProvider } from '../lib/firebase';

const COLS = [
  { id: 'todo', title: 'To Do', dot: 'todo' },
  { id: 'doing', title: 'In Progress', dot: 'doing' },
  { id: 'done', title: 'Done', dot: 'done' },
];
const BOARD_KEY = 'cyh:board';
const MODEL_KEY = 'cyh:model';
const MODELS = [
  ['claude-sonnet-4-6', 'Sonnet 4.6 (smart, balanced, recommended)'],
  ['claude-haiku-4-5-20251001', 'Haiku 4.5 (fastest, cheapest)'],
  ['claude-sonnet-5', 'Sonnet 5 (smartest, priciest)'],
];

const today = () => new Date().toISOString().slice(0, 10);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clone = (o) => JSON.parse(JSON.stringify(o));
const emptyBoard = () => ({ todo: [], doing: [], done: [], limit: 1, cleared: 0, clearedDate: today() });

function normalize(b) {
  const n = Object.assign(emptyBoard(), b || {});
  ['todo', 'doing', 'done'].forEach((c) => { if (!Array.isArray(n[c])) n[c] = []; });
  if (!n.limit) n.limit = 1;
  if (n.clearedDate !== today()) { n.clearedDate = today(); n.cleared = 0; }
  return n;
}
function findCard(board, id) {
  for (const c of ['todo', 'doing', 'done']) {
    const i = board[c].findIndex((t) => t.id === id);
    if (i > -1) return { col: c, idx: i, card: board[c][i] };
  }
  return null;
}

export default function Page() {
  const [board, setBoard] = useState(null);        // null = still loading
  const [model, setModel] = useState(MODELS[0][0]);
  const [user, setUser] = useState(null);
  const [authKnown, setAuthKnown] = useState(!firebaseReady);
  const [dump, setDump] = useState('');
  const [listening, setListening] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);
  const [focusMode, setFocusMode] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const dumpRef = useRef(null);

  const applyingRemote = useRef(false);
  const writeTimer = useRef(null);
  const dragId = useRef(null);
  const focusAddId = useRef(null);
  const recog = useRef(null);
  const voiceBase = useRef('');

  // ---- toast ----
  const toastT = useRef(null);
  const toast = useCallback((msg, isErr) => {
    setToastMsg({ msg, isErr });
    clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setToastMsg(null), isErr ? 4200 : 2400);
  }, []);

  // ---- initial local load ----
  useEffect(() => {
    let b = null;
    try { const raw = localStorage.getItem(BOARD_KEY); if (raw) b = JSON.parse(raw); } catch (e) {}
    setBoard(normalize(b));
    try { const m = localStorage.getItem(MODEL_KEY); if (m) setModel(m); } catch (e) {}
  }, []);

  // ---- auth ----
  useEffect(() => {
    const a = getAuthI();
    if (!a) return;
    const unsub = onAuthStateChanged(a, (u) => { setUser(u); setAuthKnown(true); });
    return () => unsub();
  }, []);

  // ---- firestore snapshot for signed-in user ----
  useEffect(() => {
    const database = getDb();
    if (!database || !user) return;
    const ref = doc(database, 'boards', user.uid);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (snap.metadata.hasPendingWrites) return; // our own local echo
        if (snap.exists()) {
          const data = snap.data();
          if (data && data.json) {
            try {
              const remote = normalize(JSON.parse(data.json));
              applyingRemote.current = true;
              setBoard(remote);
              try { localStorage.setItem(BOARD_KEY, JSON.stringify(remote)); } catch (e) {}
              applyingRemote.current = false;
            } catch (e) {}
          }
        } else {
          // first run on this account, seed with whatever is local
          let b = null;
          try { const raw = localStorage.getItem(BOARD_KEY); if (raw) b = JSON.parse(raw); } catch (e) {}
          setDoc(ref, { json: JSON.stringify(normalize(b)), updatedAt: Date.now() }).catch(() => {});
        }
      },
      (err) => toast('Cloud sync error: ' + (err.code || err.message), true)
    );
    return () => unsub();
  }, [user, toast]);

  // ---- voice ----
  useEffect(() => {
    const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) return;
    const r = new SR();
    r.continuous = true; r.interimResults = true; r.lang = 'en-US';
    r.onstart = () => setListening(true);
    r.onend = () => setListening(false);
    r.onerror = (e) => {
      setListening(false);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Mic permission blocked. Allow it in your browser.', true);
    };
    r.onresult = (e) => {
      let txt = '';
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      setDump(voiceBase.current + txt);
    };
    recog.current = r;
  }, [toast]);

  // ---- debounced cloud write ----
  const cloudWrite = useCallback((next) => {
    if (applyingRemote.current || !user) return;
    const database = getDb();
    if (!database) return;
    clearTimeout(writeTimer.current);
    writeTimer.current = setTimeout(() => {
      setDoc(doc(database, 'boards', user.uid), { json: JSON.stringify(next), updatedAt: Date.now() })
        .catch((err) => toast('Cloud write failed: ' + (err.code || ''), true));
    }, 400);
  }, [user, toast]);

  // ---- helper to mutate the board immutably ----
  const mutate = useCallback((fn) => {
    setBoard((cur) => {
      const next = clone(cur);
      fn(next);
      try { localStorage.setItem(BOARD_KEY, JSON.stringify(next)); } catch (e) {}
      cloudWrite(next);
      return next;
    });
  }, [cloudWrite]);

  // ---- AI ----
  async function callAI(action, text, instr) {
    const headers = { 'content-type': 'application/json' };
    if (user) {
      try { headers.authorization = 'Bearer ' + (await user.getIdToken()); } catch (e) {}
    } else {
      throw new Error('Sign in to use AI.');
    }
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, text, instr, model }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'AI request failed.');
    return data.items || [];
  }

  // ---- board actions ----
  function addLines(lines) {
    lines = lines.map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return;
    mutate((b) => { lines.forEach((t) => b.todo.push({ id: uid(), text: t, steps: null, stepsOpen: false, instr: '' })); });
  }
  function addPlain() {
    if (!dump.trim()) return;
    addLines(dump.split('\n'));
    setDump('');
  }
  async function organize() {
    if (!dump.trim()) { toast('Dump some thoughts first.'); return; }
    setOrganizing(true);
    try {
      const items = await callAI('organize', dump.trim());
      if (!items.length) { toast('No tasks found in that.'); return; }
      addLines(items);
      setDump('');
      toast('Added ' + items.length + ' task' + (items.length > 1 ? 's' : '') + ' ✨');
    } catch (e) { toast(e.message, true); }
    finally { setOrganizing(false); }
  }

  const [busySteps, setBusySteps] = useState(null); // card id currently generating
  async function generateSteps(id, instr) {
    setBusySteps(id);
    try {
      const f = findCard(board, id); if (!f) return;
      const steps = await callAI('steps', f.card.text, instr);
      if (!steps.length) { toast('Could not break that down.'); return; }
      mutate((b) => {
        const g = findCard(b, id); if (!g) return;
        g.card.steps = steps.map((s) => ({ text: s, done: false }));
        g.card.instr = instr || '';
        g.card.stepsOpen = true; g.card.regenOpen = false; g.card.listCollapsed = false;
      });
    } catch (e) { toast(e.message, true); }
    finally { setBusySteps(null); }
  }

  function move(id, to) {
    mutate((b) => {
      const f = findCard(b, id); if (!f) return;
      if (to === 'doing' && f.col !== 'doing' && b.doing.length >= b.limit) { toast('One thing at a time. Finish or free up In Progress first.'); return; }
      b[f.col].splice(f.idx, 1);
      // Count reflects what's actually in Done: +1 entering, -1 leaving.
      if (to === 'done' && f.col !== 'done') b.cleared++;
      else if (f.col === 'done' && to !== 'done') b.cleared = Math.max(0, b.cleared - 1);
      b[to].push(f.card);
    });
  }
  function del(id) { mutate((b) => { const f = findCard(b, id); if (!f) return; if (f.col === 'done') b.cleared = Math.max(0, b.cleared - 1); b[f.col].splice(f.idx, 1); }); }
  function editText(id, text) { const t = text.trim(); if (!t) return; mutate((b) => { const f = findCard(b, id); if (f) f.card.text = t; }); }
  function setLimit(n) { mutate((b) => { b.limit = n; }); }
  function clearDone() { mutate((b) => { b.done = []; }); }

  function toggleSteps(id) { mutate((b) => { const f = findCard(b, id); if (f) f.card.stepsOpen = !f.card.stepsOpen; }); }
  function toggleStep(id, i) { mutate((b) => { const f = findCard(b, id); if (f && f.card.steps) f.card.steps[i].done = !f.card.steps[i].done; }); }
  function deleteStep(id, i) { mutate((b) => { const f = findCard(b, id); if (f && f.card.steps) { f.card.steps.splice(i, 1); if (!f.card.steps.length) f.card.steps = null; } }); }
  function addStep(id, text) { const t = (text || '').trim(); if (!t) return; focusAddId.current = id; mutate((b) => { const f = findCard(b, id); if (f) { if (!f.card.steps) f.card.steps = []; f.card.steps.push({ text: t, done: false }); } }); }
  function toggleStepList(id) { mutate((b) => { const f = findCard(b, id); if (f) f.card.listCollapsed = !f.card.listCollapsed; }); }
  function toggleRegen(id) { mutate((b) => { const f = findCard(b, id); if (f) f.card.regenOpen = !f.card.regenOpen; }); }
  function setInstr(id, v) { mutate((b) => { const f = findCard(b, id); if (f) f.card.instr = v; }); }

  // ---- drag & drop ----
  function dragAfter(colEl, y) {
    const cards = [...colEl.querySelectorAll('.card:not(.dragging)')];
    let closest = { off: -Infinity, el: null };
    for (const el of cards) {
      const box = el.getBoundingClientRect();
      const off = y - (box.top + box.height / 2);
      if (off < 0 && off > closest.off) closest = { off, el };
    }
    return closest.el;
  }
  function clearMarkers() {
    document.querySelectorAll('.col.drag-over,.col.drop-end').forEach((el) => el.classList.remove('drag-over', 'drop-end'));
    document.querySelectorAll('.card.drop-before').forEach((el) => el.classList.remove('drop-before'));
  }
  function onColDragOver(e) {
    if (!dragId.current) return;
    e.preventDefault();
    clearMarkers();
    const col = e.currentTarget;
    col.classList.add('drag-over');
    const after = dragAfter(col, e.clientY);
    if (after) after.classList.add('drop-before'); else col.classList.add('drop-end');
  }
  function onColDrop(e, colId) {
    e.preventDefault();
    clearMarkers();
    if (!dragId.current) return;
    const after = dragAfter(e.currentTarget, e.clientY);
    const afterId = after ? after.dataset.id : null;
    const id = dragId.current;
    mutate((b) => {
      const f = findCard(b, id); if (!f) return;
      const crossIn = colId !== f.col;
      if (colId === 'doing' && crossIn && b.doing.length >= b.limit) { toast('In Progress is full. Reorder within it, or finish something.'); return; }
      const [card] = b[f.col].splice(f.idx, 1);
      // Count reflects what's actually in Done: +1 entering, -1 leaving.
      if (colId === 'done' && crossIn) b.cleared++;
      else if (f.col === 'done' && crossIn) b.cleared = Math.max(0, b.cleared - 1);
      let idx = afterId == null ? b[colId].length : b[colId].findIndex((c) => c.id === afterId);
      if (idx < 0) idx = b[colId].length;
      b[colId].splice(idx, 0, card);
    });
  }

  // ---- auth actions ----
  async function signIn() {
    const a = getAuthI();
    if (!a) { toast('Cloud sync isn’t configured.', true); return; }
    try { await signInWithPopup(a, getProvider()); }
    catch (e) { if (e.code !== 'auth/popup-closed-by-user') toast('Sign-in failed: ' + (e.code || e.message), true); }
  }
  async function signOutNow() {
    const a = getAuthI();
    if (!a) return;
    await signOut(a);
    toast('Signed out. Now local to this browser.');
  }

  function saveModel(m) { setModel(m); try { localStorage.setItem(MODEL_KEY, m); } catch (e) {} }

  // ---- voice toggle ----
  function toggleMic() {
    const r = recog.current;
    if (!r) return;
    if (listening) { r.stop(); return; }
    voiceBase.current = dump && !dump.endsWith('\n') ? dump + '\n' : dump;
    try { r.start(); } catch (e) {}
  }

  // Focus mode auto-exits when the one thing is finished, so you never get stranded
  // on an empty screen with To Do hidden.
  useEffect(() => {
    if (focusMode && board && board.doing.length === 0) setFocusMode(false);
  }, [focusMode, board]);

  function toggleFocus() {
    if (!focusMode && (!board || board.doing.length === 0)) {
      toast('Pick one thing to focus on first.');
      return;
    }
    setFocusMode((f) => !f);
  }

  // Keyboard shortcuts. All single-key ones are ignored while typing in a field.
  useEffect(() => {
    function onKey(e) {
      const el = document.activeElement;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      // Esc: back out of whatever is open (help > settings > focus mode).
      if (e.key === 'Escape') {
        if (helpOpen) { setHelpOpen(false); return; }
        if (settingsOpen) { setSettingsOpen(false); return; }
        if (focusMode) { setFocusMode(false); return; }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFocus(); }
      else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); dumpRef.current?.focus(); }
      else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        if (board && board.todo.length) move(board.todo[0].id, 'doing');
        else toast('Nothing in To Do to start.');
      }
      else if (e.key === '?') { e.preventDefault(); setHelpOpen((h) => !h); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusMode, settingsOpen, helpOpen, board]);

  if (!board) {
    return <div className="wrap"><div className="loading">Loading your board…</div></div>;
  }

  const micSupported = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

  return (
    <div className={'wrap' + (focusMode ? ' focusmode' : '')}>
      {focusMode && <div className="focus-backdrop" onClick={() => setFocusMode(false)} />}
      <header className="top">
        <div>
          <h1>Hyperfix</h1>
          <div className="flow">Dump it all out <span className="arrow">→</span> pick <b>one thing</b> <span className="arrow">→</span> done</div>
        </div>
        <div className="head-right">
          <div className="cleared">✓ <span>{board.cleared}</span> cleared today</div>
          {firebaseReady && (
            user
              ? <>
                  <span className="sync-pill">✓ Synced</span>
                  <button className="signbtn" onClick={signOutNow} title="Sign out">
                    {user.photoURL && <img className="avatar" src={user.photoURL} alt="" />}
                    Sign out
                  </button>
                </>
              : authKnown && <button className="signbtn" onClick={signIn}>Sign in to sync</button>
          )}
          {!firebaseReady && <span className="sync-pill local">Local only</span>}
          <button
            className={'focusbtn' + (focusMode ? ' on' : '')}
            onClick={toggleFocus}
            title={focusMode ? 'Show the whole board' : 'Hide everything but the one thing'}
          >
            {focusMode ? '← Show all' : '◎ Focus'}
          </button>
          <button className="gear" onClick={() => setHelpOpen(true)} title="Keyboard shortcuts (?)">⌨</button>
          <button className="gear" onClick={() => setSettingsOpen(true)} title="Settings">⚙</button>
        </div>
      </header>

      <div className="dump">
        <p className="dump-label">Brain dump <small>(just empty your head, AI sorts it into clean tasks)</small></p>
        <div className="ta-wrap">
          <textarea
            ref={dumpRef}
            className="dumpbox"
            value={dump}
            onChange={(e) => setDump(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); organize(); } }}
            placeholder={"reply to Sam and also send him the q3 numbers\nbook dentist sometime\nthat thing for the report is due\nbuy milk eggs bread\n..."}
          />
          {micSupported && (
            <button className={'mic' + (listening ? ' live' : '')} onClick={toggleMic} title="Dictate">🎤</button>
          )}
        </div>
        <div className="dump-row">
          <span className="hint">Everything lands in To Do. Pick one to focus.</span>
          <div className="dump-btns">
            <button className="btn btn-ghost" onClick={addPlain} title="Add each line as-is, no AI">Add as-is</button>
            <button className="btn btn-primary" onClick={organize} disabled={organizing}>
              {organizing ? <><span className="spin" />Organizing…</> : '✨ Organize with AI'}
            </button>
          </div>
        </div>
      </div>

      <div className="board">
        {COLS.map((c) => (
          <div
            key={c.id}
            className={'col ' + c.id}
            onDragOver={onColDragOver}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('drag-over', 'drop-end'); }}
            onDrop={(e) => onColDrop(e, c.id)}
          >
            <div className="col-head">
              <div className="col-title"><span className={'dot ' + c.dot} />{c.title}</div>
              {c.id === 'doing'
                ? <span className={'count' + (board.doing.length >= board.limit ? ' full' : '')}>{board.doing.length} / {board.limit}</span>
                : <span className="count">{board[c.id].length}</span>}
              {c.id === 'done' && board.done.length > 0 && (
                <button className="clear-done" onClick={clearDone}>clear all</button>
              )}
            </div>

            {c.id === 'doing' && (
              <div className="limit">
                focus limit
                {[1, 2, 3].map((n) => (
                  <button key={n} className={board.limit === n ? 'on' : ''} onClick={() => setLimit(n)}>{n}</button>
                ))}
              </div>
            )}

            {board[c.id].length > 0
              ? board[c.id].map((card) => (
                  <Card
                    key={card.id}
                    card={card}
                    col={c.id}
                    busySteps={busySteps}
                    focusAddId={focusAddId}
                    dragId={dragId}
                    clearMarkers={clearMarkers}
                    onMove={move}
                    onDel={del}
                    onEdit={editText}
                    onToggleSteps={toggleSteps}
                    onGenerate={generateSteps}
                    onToggleStep={toggleStep}
                    onDeleteStep={deleteStep}
                    onAddStep={addStep}
                    onToggleList={toggleStepList}
                    onToggleRegen={toggleRegen}
                    onSetInstr={setInstr}
                  />
                ))
              : <div className="empty">
                  {c.id === 'todo' ? 'Head’s clear. Dump something above.'
                    : c.id === 'doing' ? 'Nothing in progress. Pick ONE thing to start.'
                    : 'Finished things land here.'}
                </div>}
          </div>
        ))}
      </div>

      {settingsOpen && (
        <div className="overlay" onClick={(e) => { if (e.target.classList.contains('overlay')) setSettingsOpen(false); }}>
          <div className="modal">
            <h2>Settings</h2>
            <p className="sub">Your AI key lives on the server, never in this browser.</p>

            {firebaseReady ? (
              user ? (
                <div className="acct">
                  {user.photoURL && <img src={user.photoURL} alt="" />}
                  <div className="who">{user.displayName || 'Signed in'}<small>{user.email} · syncing across your devices</small></div>
                </div>
              ) : (
                <div className="field">
                  <button className="btn btn-primary" onClick={signIn} style={{ width: '100%' }}>Sign in with Google to sync</button>
                  <div className="hint" style={{ marginTop: 6 }}>Optional. Without it, your board stays on this browser only.</div>
                </div>
              )
            ) : (
              <div className="hint" style={{ marginBottom: 14 }}>Cloud sync isn’t configured (no Firebase keys). The board works locally in this browser.</div>
            )}

            <div className="field">
              <label htmlFor="modelSel">AI model</label>
              <select id="modelSel" value={model} onChange={(e) => saveModel(e.target.value)}>
                {MODELS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
              <div className="hint" style={{ marginTop: 6 }}>The server may override this with its own default.</div>
            </div>

            <div className="modal-row">
              {firebaseReady && user
                ? <button className="link-btn" onClick={() => { signOutNow(); setSettingsOpen(false); }}>Sign out</button>
                : <span />}
              <button className="btn btn-primary" onClick={() => setSettingsOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {helpOpen && (
        <div className="overlay" onClick={(e) => { if (e.target.classList.contains('overlay')) setHelpOpen(false); }}>
          <div className="modal">
            <h2>Keyboard shortcuts</h2>
            <p className="sub">Work the board without touching the mouse.</p>
            <ul className="keylist">
              <li><kbd>D</kbd><span>Jump to the brain dump</span></li>
              <li><kbd>S</kbd><span>Start next — move the top To Do into In Progress</span></li>
              <li><kbd>F</kbd><span>Focus mode — spotlight the one thing</span></li>
              <li><kbd>Esc</kbd><span>Exit focus mode / close dialogs</span></li>
              <li><kbd>?</kbd><span>Show or hide this list</span></li>
              <li><kbd>⌘/Ctrl</kbd><kbd>↵</kbd><span>Organize the brain dump with AI</span></li>
            </ul>
            <div className="modal-row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={() => setHelpOpen(false)}>Got it</button>
            </div>
          </div>
        </div>
      )}

      <div className={'toast' + (toastMsg ? ' show' : '') + (toastMsg && toastMsg.isErr ? ' err' : '')}>
        {toastMsg && toastMsg.msg}
      </div>
    </div>
  );
}

// ---------------- Card ----------------
function Card({ card, col, busySteps, focusAddId, dragId, clearMarkers, onMove, onDel, onEdit, onToggleSteps, onGenerate, onToggleStep, onDeleteStep, onAddStep, onToggleList, onToggleRegen, onSetInstr }) {
  const textRef = useRef(null);
  const [editing, setEditing] = useState(false);

  const hasSteps = card.steps && card.steps.length;
  const stepLabel = card.stepsOpen ? '⚡ Hide steps' : (hasSteps ? '⚡ Steps' : '⚡ Break down');

  return (
    <div
      className="card"
      draggable
      data-id={card.id}
      onDragStart={(e) => { dragId.current = card.id; e.currentTarget.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; }}
      onDragEnd={(e) => { e.currentTarget.classList.remove('dragging'); dragId.current = null; clearMarkers(); }}
    >
      <div
        className="card-text"
        ref={textRef}
        title="Double-click to edit"
        contentEditable={editing}
        suppressContentEditableWarning
        onDoubleClick={() => { setEditing(true); setTimeout(() => { textRef.current && textRef.current.focus(); document.getSelection().selectAllChildren(textRef.current); }, 0); }}
        onBlur={(e) => { setEditing(false); onEdit(card.id, e.currentTarget.textContent); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
      >{card.text}</div>

      <div className="card-actions">
        {col === 'todo' && <button className="chip go" onClick={() => onMove(card.id, 'doing')}>Start →</button>}
        {col === 'doing' && <>
          <button className="chip" onClick={() => onMove(card.id, 'todo')}>← Back</button>
          <button className="chip done" onClick={() => onMove(card.id, 'done')}>Done ✓</button>
        </>}
        {col === 'done' && <button className="chip" onClick={() => onMove(card.id, 'todo')}>↩ Reopen</button>}
        {col !== 'done' && <button className="chip ai" onClick={() => onToggleSteps(card.id)}>{stepLabel}</button>}
        {col === 'done' && hasSteps && <button className="chip ai" onClick={() => onToggleSteps(card.id)}>{card.stepsOpen ? 'Hide steps' : 'Steps'}</button>}
        <button className="x" title="Delete" onClick={() => onDel(card.id)}>×</button>
      </div>

      {card.stepsOpen && (
        <StepsPanel
          card={card}
          busy={busySteps === card.id}
          focusAddId={focusAddId}
          onGenerate={onGenerate}
          onToggleStep={onToggleStep}
          onDeleteStep={onDeleteStep}
          onAddStep={onAddStep}
          onToggleList={onToggleList}
          onToggleRegen={onToggleRegen}
          onSetInstr={onSetInstr}
        />
      )}
    </div>
  );
}

// ---------------- StepsPanel ----------------
function StepsPanel({ card, busy, focusAddId, onGenerate, onToggleStep, onDeleteStep, onAddStep, onToggleList, onToggleRegen, onSetInstr }) {
  const addRef = useRef(null);
  const [addText, setAddText] = useState('');
  const [localInstr, setLocalInstr] = useState(card.instr || '');

  useEffect(() => { setLocalInstr(card.instr || ''); }, [card.instr]);
  useEffect(() => {
    if (focusAddId.current === card.id) { focusAddId.current = null; addRef.current && addRef.current.focus(); }
  });

  const commitAdd = () => { if (addText.trim()) { onAddStep(card.id, addText); setAddText(''); } };
  const manualAdd = (
    <div className="step-add">
      <input ref={addRef} type="text" placeholder="add a step yourself…" value={addText}
        onChange={(e) => setAddText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitAdd(); } }} />
      <button className="add-btn" onClick={commitAdd}>Add</button>
    </div>
  );

  if (!card.steps) {
    return (
      <div className="steps">
        <div className="steps-instr">
          <textarea placeholder='optional: how detailed? any constraints? (e.g. "beginner, under 5 steps")'
            value={localInstr}
            onChange={(e) => setLocalInstr(e.target.value)}
            onBlur={() => onSetInstr(card.id, localInstr)} />
          <button className="mini-btn" disabled={busy} onClick={() => onGenerate(card.id, localInstr)}>
            {busy ? <><span className="spin" />Thinking…</> : 'Generate steps'}
          </button>
        </div>
        <p className="steps-or">or build the list yourself</p>
        {manualAdd}
      </div>
    );
  }

  const doneCount = card.steps.filter((s) => s.done).length;
  return (
    <div className="steps">
      <div className="steps-head">
        <button className="steps-toggle" onClick={() => onToggleList(card.id)} title={card.listCollapsed ? 'Show steps' : 'Hide steps'}>
          <span className="caret">{card.listCollapsed ? '▸' : '▾'}</span>Steps
          <span className="cnt">{doneCount} / {card.steps.length} done</span>
        </button>
        <button className={'steps-regen-link' + (card.regenOpen ? ' on' : '')} onClick={() => onToggleRegen(card.id)}>
          {card.regenOpen ? 'Cancel' : 'Regenerate'}
        </button>
      </div>

      {card.regenOpen && (
        <div className="steps-instr">
          <textarea placeholder="refine: extra instructions to regenerate…"
            value={localInstr}
            onChange={(e) => setLocalInstr(e.target.value)}
            onBlur={() => onSetInstr(card.id, localInstr)} />
          <button className="mini-btn" disabled={busy} onClick={() => onGenerate(card.id, localInstr)}>
            {busy ? <><span className="spin" />Thinking…</> : 'Regenerate'}
          </button>
        </div>
      )}

      {!card.listCollapsed && <>
        <ul className="steplist">
          {card.steps.map((s, i) => (
            <li key={i} className={s.done ? 'checked' : ''}>
              <input type="checkbox" checked={!!s.done} onChange={() => onToggleStep(card.id, i)} />
              <span>{s.text}</span>
              <button className="step-x" title="Delete step" onClick={() => onDeleteStep(card.id, i)}>×</button>
            </li>
          ))}
        </ul>
        {manualAdd}
      </>}
    </div>
  );
}
