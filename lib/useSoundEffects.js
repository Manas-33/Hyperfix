'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const SOUND_KEY = 'cyh:sounds';
const NOTES = {
  add: [[440, 0, 0.1], [660, 0.055, 0.14]],
  start: [[330, 0, 0.1], [440, 0.06, 0.16]],
  complete: [[523.25, 0, 0.18], [659.25, 0.075, 0.2], [783.99, 0.15, 0.28]],
  tick: [[880, 0, 0.075]],
  remove: [[220, 0, 0.09], [165, 0.04, 0.12]],
};

export function useSoundEffects() {
  const [soundEnabled, setSoundEnabled] = useState(true);
  const enabled = useRef(true);
  const context = useRef(null);
  const voices = useRef(new Set());
  const generation = useRef(0);
  const lastPlay = useRef(-Infinity);

  const stop = useCallback(() => {
    generation.current++;
    for (const oscillator of voices.current) {
      try { oscillator.stop(); } catch (error) { /* Already finished. */ }
    }
    voices.current.clear();
  }, []);

  useEffect(() => {
    try {
      enabled.current = localStorage.getItem(SOUND_KEY) !== 'off';
      setSoundEnabled(enabled.current);
    } catch (error) { /* Sound preferences are optional. */ }
    const onVisibility = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
      context.current?.close().catch(() => {});
      context.current = null;
    };
  }, [stop]);

  // Create/resume only from an action, never on page load or cloud updates.
  const unlockSound = useCallback(() => {
    if (!enabled.current || document.hidden) return null;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return null;
      if (!context.current || context.current.state === 'closed') context.current = new AudioContext();
      if (context.current.state === 'suspended') context.current.resume().catch(() => {});
      return context.current;
    } catch (error) { return null; }
  }, []);

  const playSound = useCallback((name = 'tick') => {
    const audio = unlockSound();
    if (!audio) return;
    const version = generation.current;
    const play = () => {
      if (!enabled.current || document.hidden || version !== generation.current || audio.state !== 'running') return;
      if (audio.currentTime - lastPlay.current < 0.06) return;
      lastPlay.current = audio.currentTime;
      try {
        for (const [frequency, delay, duration] of NOTES[name] || NOTES.tick) {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          const start = audio.currentTime + delay;
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(frequency, start);
          gain.gain.setValueAtTime(0, start);
          gain.gain.linearRampToValueAtTime(0.045, start + 0.008);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
          oscillator.connect(gain);
          gain.connect(audio.destination);
          voices.current.add(oscillator);
          oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); voices.current.delete(oscillator); };
          oscillator.start(start);
          oscillator.stop(start + duration + 0.015);
        }
      } catch (error) { /* Audio must never interrupt a task action. */ }
    };
    if (audio.state === 'running') play();
    else audio.resume().then(play).catch(() => {});
  }, [unlockSound]);

  const toggleSound = useCallback(() => {
    enabled.current = !enabled.current;
    setSoundEnabled(enabled.current);
    try { localStorage.setItem(SOUND_KEY, enabled.current ? 'on' : 'off'); } catch (error) {}
    if (enabled.current) playSound('tick');
    else stop();
  }, [playSound, stop]);

  return { soundEnabled, toggleSound, playSound, unlockSound };
}
