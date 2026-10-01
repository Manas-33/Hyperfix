'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { firebaseReady, getAuthI, getDb, getProvider } from '../lib/firebase';
import { useSoundEffects } from '../lib/useSoundEffects';

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

function Icon({ name, size = 18 }) {
  const paths = {
    grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    focus: 'M8 3H3v5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5 M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8',
    plus: 'M12 5v14 M5 12h14',
    arrow: 'M5 12h14 M13 6l6 6-6 6',
    check: 'M5 12l4 4L19 6',
    search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',
    spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z',
    settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
    keyboard: 'M3 5h18v14H3z M7 9h.01 M12 9h.01 M17 9h.01 M7 13h.01 M12 13h.01 M17 13h.01 M8 16h8',
    edit: 'm15 5 4 4 M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z',
    mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M5 11v1a7 7 0 0 0 14 0v-1 M12 19v3 M8 22h8',
    close: 'm6 6 12 12 M6 18 18 6',
    inbox: 'M4 4h16l2 12v4H2v-4Z M2 16h6l2 3h4l2-3h6',
    sound: 'M11 4 6 8H3v8h3l5 4Z M15 8a6 6 0 0 1 0 8 M18 5a10 10 0 0 1 0 14',
    muted: 'M11 4 6 8H3v8h3l5 4Z M16 9l6 6 M16 15l6-6',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || paths.spark} /></svg>;
}

function Dialog({ title, onClose, children }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return <dialog className="modal" ref={ref} aria-label={title} onCancel={(e) => { e.preventDefault(); closeRef.current(); }} onClick={(e) => { if (e.target === ref.current) { const r = ref.current.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <button className="dialog-close gear" onClick={onClose} aria-label="Close dialog"><Icon name="close" /></button>{children}
  </dialog>;
}

export default function Page() {
  const { soundEnabled, toggleSound, playSound, unlockSound } = useSoundEffects();
  const [board, setBoard] = useState(null);        // null = still loading
  const [model, setModel] = useState(MODELS[0][0]);
  const [theme, setTheme] = useState('system');
  const [user, setUser] = useState(null);
  const [authKnown, setAuthKnown] = useState(!firebaseReady);
  const [dump, setDump] = useState('');
  const [listening, setListening] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState(null);
  const [focusMode, setFocusMode] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [undo, setUndo] = useState(null);
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
    try { const t = localStorage.getItem('cyh:theme'); if (['light', 'dark', 'system'].includes(t)) setTheme(t); } catch (e) {}
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

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
    playSound('add');
  }
  function addPlain() {
    if (!dump.trim()) return;
    addLines(dump.split('\n'));
    setDump('');
    setQuery('');
    toast('Added to your board.');
  }
  async function organize() {
    if (!dump.trim()) { toast('Dump some thoughts first.'); return; }
    unlockSound();
    setOrganizing(true);
    try {
      const items = await callAI('organize', dump.trim());
      if (!items.length) { toast('No tasks found in that.'); return; }
      addLines(items);
      setDump('');
      setQuery('');
      toast('Added ' + items.length + ' task' + (items.length > 1 ? 's' : '') + ' ✨');
    } catch (e) { toast(e.message, true); }
    finally { setOrganizing(false); }
  }

  const [busySteps, setBusySteps] = useState(null); // card id currently generating
  async function generateSteps(id, instr) {
    unlockSound();
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
      playSound('add');
    } catch (e) { toast(e.message, true); }
    finally { setBusySteps(null); }
  }

  function move(id, to) {
    const found = findCard(board, id);
    if (!found || found.col === to) return;
    if (to === 'doing' && board.doing.length >= board.limit) { toast('One thing at a time. Finish or free up In Progress first.'); return; }
    mutate((b) => {
      const f = findCard(b, id); if (!f) return;
      if (to === 'doing' && f.col !== 'doing' && b.doing.length >= b.limit) { toast('One thing at a time. Finish or free up In Progress first.'); return; }
      b[f.col].splice(f.idx, 1);
      // Count reflects what's actually in Done: +1 entering, -1 leaving.
      if (to === 'done' && f.col !== 'done') b.cleared++;
      else if (f.col === 'done' && to !== 'done') b.cleared = Math.max(0, b.cleared - 1);
      b[to].push(f.card);
    });
    playSound(to === 'done' ? 'complete' : 'start');
  }
  function del(id) {
    const found = findCard(board, id);
    if (!found) return;
    setUndo({ cards: [{ col: found.col, idx: found.idx, card: clone(found.card) }], cleared: found.col === 'done' ? 1 : 0 });
    mutate((b) => { const f = findCard(b, id); if (!f) return; if (f.col === 'done') b.cleared = Math.max(0, b.cleared - 1); b[f.col].splice(f.idx, 1); });
    playSound('remove');
  }
  function editText(id, text) { const t = text.trim(); if (!t) return; mutate((b) => { const f = findCard(b, id); if (f) f.card.text = t; }); }
  function setLimit(n) { mutate((b) => { b.limit = n; }); }
  function clearDone() {
    setUndo({ cards: board.done.map((card, idx) => ({ col: 'done', idx, card: clone(card) })), cleared: 0 });
    mutate((b) => { b.done = []; });
  }
  function restore() {
    mutate((b) => { undo.cards.forEach(({ col, idx, card }) => { if (!findCard(b, card.id)) { const destination = col === 'doing' && b.doing.length >= b.limit ? 'todo' : col; b[destination].splice(idx, 0, card); } }); b.cleared += undo.cleared; });
    setUndo(null);
    playSound('add');
  }

  function toggleSteps(id) { mutate((b) => { const f = findCard(b, id); if (f) f.card.stepsOpen = !f.card.stepsOpen; }); }
  function toggleStep(id, i) {
    const step = findCard(board, id)?.card.steps?.[i];
    if (!step) return;
    mutate((b) => { const f = findCard(b, id); if (f?.card.steps?.[i]) f.card.steps[i].done = !f.card.steps[i].done; });
    if (!step.done) playSound('tick');
  }
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
    const found = findCard(board, id);
    if (!found) return;
    if (colId === 'doing' && found.col !== 'doing' && board.doing.length >= board.limit) { toast('In Progress is full. Reorder within it, or finish something.'); return; }
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
    playSound(colId === 'done' && found.col !== 'done' ? 'complete' : 'tick');
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
    setQuery('');
    setFocusMode((f) => !f);
  }

  function capture() {
    setFocusMode(false);
    requestAnimationFrame(() => dumpRef.current?.focus());
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
      if (typing || settingsOpen || helpOpen || el?.tagName === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFocus(); }
      else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); capture(); }
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

  const total = board.todo.length + board.doing.length + board.done.length;
  const progress = total ? Math.round(board.done.length / total * 100) : 0;
  const filtered = Object.fromEntries(COLS.map(({ id }) => [id, board[id].filter((card) => card.text.toLowerCase().includes(query.trim().toLowerCase()))]));

  return (
    <div className={'workspace' + (focusMode ? ' focusmode' : '')}>
      <main className="main">
        <header className="topbar">
          <a className="brand" href="/" aria-label="Hyperfix home"><span className="brand-mark">✳</span>HYPERFIX<span className="brand-tag">A LITTLE LESS SCATTERED.</span></a>
          <nav className="view-switch" aria-label="Workspace views">
            <button className={!focusMode ? 'selected' : ''} onClick={() => { setFocusMode(false); setQuery(''); }} aria-pressed={!focusMode}>The board</button>
            <button className={focusMode ? 'selected' : ''} onClick={toggleFocus} aria-pressed={focusMode}><Icon name="focus" size={16} /> Focus <kbd>F</kbd></button>
          </nav>
          <div className="head-right">
            {firebaseReady && !user && authKnown && <button className="signbtn" onClick={signIn}>Sign in <Icon name="arrow" size={15} /></button>}
            {user && <button className="account-button" onClick={() => setSettingsOpen(true)} aria-label="Account settings">{user.photoURL ? <img className="avatar" src={user.photoURL} alt="" /> : (user.displayName || 'You').slice(0, 1)}</button>}
            <button className="gear sound-toggle" onClick={toggleSound} aria-label="Sound effects" aria-pressed={soundEnabled} title={soundEnabled ? 'Mute sound effects' : 'Enable sound effects'}><Icon name={soundEnabled ? 'sound' : 'muted'} /></button>
            <button className="gear" onClick={() => setHelpOpen(true)} aria-label="Keyboard shortcuts"><Icon name="keyboard" /></button>
            <button className="gear" onClick={() => setSettingsOpen(true)} aria-label="Settings"><Icon name="settings" /></button>
          </div>
        </header>
        <div className="content">
          <section className="board-section" id="task-board" aria-label="Task board">
            <div className="board-toolbar"><h1>{focusMode ? 'In the moment' : 'The workbench'} <span>{board.todo.length + board.doing.length} open</span></h1>
              <label className="search"><Icon name="search" size={17} /><input type="search" aria-label="Search tasks" placeholder="Find a task…" value={query} onChange={(e) => setQuery(e.target.value)} />{query && <button aria-label="Clear search" onClick={() => setQuery('')}><Icon name="close" size={14} /></button>}</label>
              <button className="capture-link" onClick={capture}><Icon name="plus" size={16} /> Capture a thought <kbd>D</kbd></button>
            </div>
            {query && <p className="search-result" role="status">{Object.values(filtered).reduce((sum, cards) => sum + cards.length, 0)} matching tasks <button className="link-btn" onClick={() => setQuery('')}>Show all tasks</button></p>}
      <div className="board">
        {COLS.map((c) => (
          <div
            key={c.id}
            className={'col ' + c.id}
            aria-label={c.title}
            onDragOver={onColDragOver}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('drag-over', 'drop-end'); }}
            onDrop={(e) => onColDrop(e, c.id)}
          >
            <div className="col-head">
              <h3 className="col-title"><span className="col-number">{c.id === 'todo' ? '01' : c.id === 'doing' ? '02' : '03'}</span>{c.id === 'doing' ? 'In focus' : c.title}</h3>
              {c.id === 'doing'
                ? <span className={'count' + (board.doing.length >= board.limit ? ' full' : '')}>{board.doing.length} / {board.limit}</span>
                : <span className="count">{board[c.id].length}</span>}
              {c.id === 'done' && board.done.length > 0 && (
                <button className="clear-done" onClick={clearDone}>Clear</button>
              )}
            </div>

            {c.id === 'doing' && (
              <div className="limit">
                Focus limit
                {[1, 2, 3].map((n) => (
                  <button key={n} className={board.limit === n ? 'on' : ''} onClick={() => setLimit(n)} aria-label={"Focus limit: " + n} aria-pressed={board.limit === n}>{n}</button>
                ))}
              </div>
            )}

            {filtered[c.id].length > 0
              ? filtered[c.id].map((card) => (
                  <Card
                    key={card.id}
                    canDrag={!query.trim()}
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
                  <span className="empty-icon"><Icon name={c.id === 'todo' ? 'inbox' : c.id === 'doing' ? 'focus' : 'check'} size={24} /></span>
                  <strong>{query ? 'No matching tasks' : c.id === 'todo' ? 'A fresh start' : c.id === 'doing' ? 'Find your one thing' : 'Room for your wins'}</strong>
                  <p>{query ? 'Try a different word or clear your search.' : c.id === 'todo' ? 'Capture what’s on your mind. It all starts here.' : c.id === 'doing' ? 'Start a task from To Do and give it a little space.' : 'Good work goes here. Big or small, it counts.'}</p>
                  {!query && c.id === 'todo' && <button className="empty-action" onClick={capture}><Icon name="plus" size={15} /> Add your first task</button>}
                  {!query && c.id === 'doing' && board.todo.length > 0 && <button className="empty-action" onClick={() => move(board.todo[0].id, 'doing')}>Start next task <Icon name="arrow" size={15} /></button>}
                </div>}
          </div>
        ))}
      </div>
      <div className="board-footer"><span><Icon name="check" size={14} /> Your board saves automatically</span><button onClick={() => setHelpOpen(true)}>Work a little faster <kbd>?</kbd></button></div>
      </section>
          <div className="overview">
            <section className="dump" aria-labelledby="capture-title">
              <div className="note-label"><span>THE SCRATCHPAD</span><Icon name="edit" size={17} /></div>
              <div className="section-label"><h2 id="capture-title">Off your mind.<br /><em>Onto the page.</em></h2></div>
              <p className="capture-description">Messy thoughts welcome. Add one task per line, or let AI untangle them.</p>
              <div className="ta-wrap">
                <textarea ref={dumpRef} aria-label="Brain dump" className="dumpbox" value={dump} disabled={organizing}
                  onChange={(e) => setDump(e.target.value)}
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (!organizing) { if (e.shiftKey) organize(); else addPlain(); } } }}
                  placeholder={"Reply to that email…\nThat idea I had earlier…\nThe thing I keep putting off…"} />
                {micSupported && <button className={'mic' + (listening ? ' live' : '')} disabled={organizing} onClick={toggleMic} aria-label={listening ? 'Stop dictation' : 'Dictate thoughts'} aria-pressed={listening}><Icon name="mic" /></button>}
              </div>
              <div className="dump-row"><div className="dump-btns">
                <button className="btn btn-ghost" onClick={organize} disabled={organizing || !dump.trim()} title={user ? 'Turn your thoughts into tasks' : 'Google sign-in required for AI'}><Icon name="spark" size={16} />{organizing ? 'Organizing…' : 'Organize with AI'}</button>
                <button className="btn btn-primary" onClick={addPlain} disabled={organizing || !dump.trim()} title="Add each line as a task (⌘/Ctrl + Enter)">Add tasks <Icon name="arrow" size={16} /></button>
              </div></div>
              {!user && <div className="ai-note">AI organizing requires sign-in. Adding tasks is always available.</div>}
            </section>
            <section className="progress-card" aria-label="Board progress">
              <div className="progress-top"><span>A LITTLE PROGRESS</span><Icon name="check" size={16} /></div>
              <div className="progress-number">{board.done.length}<span> / {total}</span><div>loose ends tied up</div></div>
              <div className="progress-track" role="progressbar" aria-label="Tasks completed" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: progress + '%' }} /></div>
              <p>{total === 0 ? 'Every clear head starts with one small step.' : progress === 100 ? 'Look at that. A little more space to breathe.' : board.doing.length ? 'You’ve found your focus. Keep going.' : 'Pick a task below. One is enough.'}</p>
            </section>
          </div>

      </div>
      </main>

      {settingsOpen && (
        <Dialog title="Settings" onClose={() => setSettingsOpen(false)}>
            <h2>Settings</h2>
            <p className="sub">Make this workspace your own.</p>

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
              <label htmlFor="themeSel">Appearance</label>
              <select id="themeSel" value={theme} onChange={(e) => { setTheme(e.target.value); try { localStorage.setItem('cyh:theme', e.target.value); } catch (err) {} }}>
                <option value="system">Match device</option><option value="light">Light</option><option value="dark">Dark</option>
              </select>
            </div>
            <div className="field">
              <div className="sound-setting"><div><span className="setting-label">Sound effects</span><p className="hint">Soft cues for tasks and checklists. Saved on this device.</p></div><button className="sound-switch" role="switch" aria-checked={soundEnabled} aria-label="Sound effects" onClick={toggleSound}><span /></button></div>
              <button className="sound-preview" onClick={() => playSound('complete')} disabled={!soundEnabled}><Icon name="sound" size={14} /> Preview completion sound</button>
            </div>
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
        </Dialog>
      )}

      {helpOpen && (
        <Dialog title="Keyboard shortcuts" onClose={() => setHelpOpen(false)}>
            <h2>Keyboard shortcuts</h2>
            <p className="sub">Work the board without touching the mouse.</p>
            <ul className="keylist">
              <li><kbd>D</kbd><span>Jump to the brain dump</span></li>
              <li><kbd>S</kbd><span>Start next — move the top To Do into In Progress</span></li>
              <li><kbd>F</kbd><span>Focus mode — spotlight the one thing</span></li>
              <li><kbd>Esc</kbd><span>Exit focus mode / close dialogs</span></li>
              <li><kbd>?</kbd><span>Show or hide this list</span></li>
              <li><kbd>⌘/Ctrl</kbd><kbd>↵</kbd><span>Add each line as a task</span></li>
              <li><kbd>⌘/Ctrl</kbd><kbd>Shift</kbd><kbd>↵</kbd><span>Organize thoughts with AI</span></li>
            </ul>
            <div className="modal-row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn btn-primary" onClick={() => setHelpOpen(false)}>Got it</button>
            </div>
        </Dialog>
      )}

      {undo && <div className="undo-bar" role="status"><span>{undo.cards.length === 1 ? 'Task removed' : 'Completed tasks cleared'}</span><button onClick={restore}>Undo</button><button className="undo-dismiss" aria-label="Dismiss undo" onClick={() => setUndo(null)}><Icon name="close" size={15} /></button></div>}
      <div role="status" aria-live="polite" className={'toast' + (toastMsg ? ' show' : '') + (toastMsg && toastMsg.isErr ? ' err' : '')}>
        {toastMsg && toastMsg.msg}
      </div>
    </div>
  );
}

// ---------------- Card ----------------
function Card({ card, col, canDrag, busySteps, focusAddId, dragId, clearMarkers, onMove, onDel, onEdit, onToggleSteps, onGenerate, onToggleStep, onDeleteStep, onAddStep, onToggleList, onToggleRegen, onSetInstr }) {
  const textRef = useRef(null);
  const [editing, setEditing] = useState(false);

  const hasSteps = card.steps && card.steps.length;

  return (
    <div
      className="card"
      draggable={canDrag && !editing}
      data-id={card.id}
      onDragStart={(e) => { dragId.current = card.id; e.currentTarget.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; }}
      onDragEnd={(e) => { e.currentTarget.classList.remove('dragging'); dragId.current = null; clearMarkers(); }}
    >
      <div className="card-meta"><span>{col === 'doing' ? 'ONE THING AT A TIME' : col === 'done' ? 'NICELY DONE' : 'UP NEXT'}</span><button className="edit-task" aria-label={'Edit ' + card.text} title="Edit task" onClick={() => { setEditing(true); setTimeout(() => { textRef.current?.focus(); document.getSelection()?.selectAllChildren(textRef.current); }, 0); }}><Icon name="edit" size={14} /></button></div>
      <div
        className="card-text"
        ref={textRef}
        title="Double-click to edit"
        contentEditable={editing}
        suppressContentEditableWarning
        onDoubleClick={() => { setEditing(true); setTimeout(() => { textRef.current && textRef.current.focus(); document.getSelection().selectAllChildren(textRef.current); }, 0); }}
        onBlur={(e) => { const text = e.currentTarget.textContent.trim(); if (!text) e.currentTarget.textContent = card.text; setEditing(false); onEdit(card.id, text); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
      >{card.text}</div>

      <div className="card-actions">
        {col === 'todo' && <button className="chip go" onClick={() => onMove(card.id, 'doing')}>Start →</button>}
        {col === 'doing' && <>
          <button className="chip icon" title="Back to To Do" onClick={() => onMove(card.id, 'todo')}>←</button>
          <button className="chip done" onClick={() => onMove(card.id, 'done')}><Icon name="check" size={14} /> Complete</button>
        </>}
        {col === 'done' && <button className="chip" onClick={() => onMove(card.id, 'todo')}>↩ Reopen</button>}
        {col !== 'done' && !hasSteps && <button className="chip ai" onClick={() => onToggleSteps(card.id)}><Icon name="spark" size={13} /> Break into steps</button>}
        <button className="x" aria-label={"Delete " + card.text} title="Delete task" onClick={() => onDel(card.id)}>×</button>
      </div>

      {(hasSteps || card.stepsOpen) && (
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
  const [editSteps, setEditSteps] = useState(false);

  useEffect(() => { setLocalInstr(card.instr || ''); }, [card.instr]);
  useEffect(() => {
    if (focusAddId.current === card.id) { focusAddId.current = null; addRef.current && addRef.current.focus(); }
  });

  const commitAdd = () => { if (addText.trim()) { onAddStep(card.id, addText); setAddText(''); setEditSteps(true); } };
  const manualAdd = (
    <div className="step-add">
      <input ref={addRef} type="text" aria-label="Add a step" placeholder="add a step yourself…" value={addText}
        onChange={(e) => setAddText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitAdd(); } }} />
      <button className="add-btn" onClick={commitAdd}>Add</button>
    </div>
  );

  if (!card.steps) {
    return (
      <div className="steps">
        <div className="steps-instr">
          <textarea aria-label="Step instructions" placeholder='optional: how detailed? any constraints? (e.g. "beginner, under 5 steps")'
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
        {!card.listCollapsed && (
          <button className={'steps-regen-link' + (editSteps ? ' on' : '')} onClick={() => setEditSteps((v) => !v)}>
            {editSteps ? 'Done' : 'Edit'}
          </button>
        )}
      </div>

      {!card.listCollapsed && <>
        <ul className="steplist">
          {card.steps.map((s, i) => (
            <li key={i} className={s.done ? 'checked' : ''}>
              <input type="checkbox" aria-label={s.text} checked={!!s.done} onChange={() => onToggleStep(card.id, i)} />
              <span>{s.text}</span>
              {editSteps && <button className="step-x" title="Delete step" onClick={() => onDeleteStep(card.id, i)}>×</button>}
            </li>
          ))}
        </ul>

        {editSteps && <>
          {manualAdd}
          <button className={'steps-regen-link' + (card.regenOpen ? ' on' : '')} style={{ marginTop: 8 }} onClick={() => onToggleRegen(card.id)}>
            {card.regenOpen ? 'Cancel regenerate' : '↻ Regenerate with AI'}
          </button>
          {card.regenOpen && (
            <div className="steps-instr" style={{ marginTop: 8 }}>
              <textarea aria-label="Regenerate instructions" placeholder="refine: extra instructions to regenerate…"
                value={localInstr}
                onChange={(e) => setLocalInstr(e.target.value)}
                onBlur={() => onSetInstr(card.id, localInstr)} />
              <button className="mini-btn" disabled={busy} onClick={() => onGenerate(card.id, localInstr)}>
                {busy ? <><span className="spin" />Thinking…</> : 'Regenerate'}
              </button>
            </div>
          )}
        </>}
      </>}
    </div>
  );
}
