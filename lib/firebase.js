import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const cfg = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// True only when the Firebase env vars are present.
export const firebaseReady = !!cfg.apiKey && !!cfg.projectId;

let _app = null, _auth = null, _db = null, _provider = null;

// Initialize on first use, in the browser only. Returns true once ready.
function ensure() {
  if (!firebaseReady || typeof window === 'undefined') return false;
  if (!_app) {
    _app = getApps().length ? getApp() : initializeApp(cfg);
    _auth = getAuth(_app);
    _db = getFirestore(_app);
    _provider = new GoogleAuthProvider();
  }
  return true;
}

export function getAuthI() { return ensure() ? _auth : null; }
export function getDb() { return ensure() ? _db : null; }
export function getProvider() { return ensure() ? _provider : null; }
