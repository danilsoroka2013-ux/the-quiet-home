// Firebase Web App configuration (Firebase Console → Project settings → Your apps).
// This client config is public by design; protect the database with Realtime Database Rules
// (see database.rules.json and the Firebase checklist in DEPLOY.md). The apiKey is NOT a secret:
// GitHub secret-scanning alerts about it are expected for Firebase web apps — do not revoke it.
export const firebaseConfig = {
  apiKey: 'AIzaSyBcGdmLkXvKB_osfAT85Ndbk_3LpGJKgUA',
  authDomain: 'the-quiet-home.firebaseapp.com',
  databaseURL: 'https://the-quiet-home-default-rtdb.europe-west1.firebasedatabase.app',
  projectId: 'the-quiet-home',
  storageBucket: 'the-quiet-home.firebasestorage.app',
  messagingSenderId: '197483725952',
  appId: '1:197483725952:web:baa5f7003e2046c526d265',
  measurementId: 'G-ZDKE2PWL0S',
};
