import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.13.2';
const COLORS = ['#d45b52', '#4d8cbd', '#7d9d62', '#b187c5'];
let sdkPromise;
let appInstance;

export function isFirebaseConfigured() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.databaseURL && firebaseConfig.projectId && firebaseConfig.appId);
}

// Карта типичных отказов Firebase в человеческое сообщение.
// Локально всё «вроде настроено», но молча валится именно на этих местах.
export function describeFirebaseError(error) {
  const raw = String(error?.code || error?.message || error || '').toLowerCase();
  if (raw.includes('permission_denied') || raw.includes('permission denied') || raw.includes('permission-denied')) {
    return 'База запрещает доступ (правила Realtime Database). Опубликуйте правила из файла database.rules.json в консоли Firebase.';
  }
  if (raw.includes('operation-not-allowed') || raw.includes('admin-restricted-operation') || raw.includes('operation_not_allowed')) {
    return 'Анонимный вход выключен. Firebase Console → Authentication → Sign-in method → Anonymous → Enable.';
  }
  if (raw.includes('api-key-not-valid') || raw.includes('invalid-api-key') || raw.includes('api key not valid')) {
    return 'Ключ API отклонён (ограничен или отозван). Google Cloud Console → Credentials → ключ браузера: проверьте ограничения (HTTP referrer) либо снимите их.';
  }
  if (raw.includes('network') || raw.includes('failed to fetch') || raw.includes('unavailable') || raw.includes('timeout') || raw.includes('timed out')) {
    return 'Сервер Firebase недоступен. Проверьте интернет и блокировщики рекламы (они часто режут gstatic.com / firebasedatabase.app).';
  }
  if (raw.includes('auth/') || raw.includes('token')) {
    return 'Firebase Authentication отклонил вход. Проверьте, что включён провайдер Anonymous и не истёк срок тестовых правил.';
  }
  if (raw.includes('app-deleted') || raw.includes('invalid-app') || raw.includes('project')) {
    return 'Проект Firebase не найден или не совпадает по конфигу. Сверьте projectId / appId в src/firebase-config.js с консолью Firebase.';
  }
  return 'Не удалось подключиться к мультиплееру. Подробности смотрите в консоли браузера (F12 → Console).';
}

async function loadFirebaseSdk() {
  if (!sdkPromise) {
    sdkPromise = Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-database.js`),
    ]).then(([app, auth, database]) => ({ app, auth, database }))
      // Если SDK не загрузился (сеть/блокировщик), не кэшируем провал — дадим ретрай.
      .catch((error) => { sdkPromise = null; throw error; });
  }
  return sdkPromise;
}

export async function connectToQuickGame(profile = {}, onPlayers = () => {}, onWorld = () => {}, onHost = () => {}, onStart = () => {}, onError = () => {}) {
  if (!isFirebaseConfigured()) return null;
  const report = (error, context) => {
    const message = describeFirebaseError(error);
    console.error(`Firebase (${context}):`, error);
    try { onError(message); } catch (callbackError) { console.debug('Firebase onError callback failed:', callbackError); }
    return message;
  };
  try {
    const { app: appSdk, auth: authSdk, database: dbSdk } = await loadFirebaseSdk();
    const { initializeApp, getApps } = appSdk;
    const app = getApps().length ? getApps()[0] : (appInstance ||= initializeApp(firebaseConfig));
    const auth = authSdk.getAuth(app);
    const db = dbSdk.getDatabase(app);
    const credentials = await authSdk.signInAnonymously(auth);
    const uid = credentials.user.uid;
    const roomList = dbSdk.ref(db, 'rooms');
    const candidateRoomId = dbSdk.push(roomList).key;
    const queueRef = dbSdk.ref(db, 'matchmaking/quick');
    const palette = COLORS;
    const transaction = await dbSdk.runTransaction(queueRef, (current) => {
      const now = Date.now();
      if (!current || !current.roomId || !current.expiresAt || current.expiresAt <= now || Object.keys(current.players || {}).length >= 4) {
        current = { roomId: candidateRoomId, createdAt: now, expiresAt: now + 25000, players: {} };
      }
      current.players ||= {};
      if (!current.players[uid] && Object.keys(current.players).length < 4) {
        const slot = Object.keys(current.players).length;
        current.players[uid] = { joinedAt: now, color: palette[slot % palette.length], displayName: profile.displayName || `Игрок ${slot + 1}` };
      }
      return current;
    }, { applyLocally: false });
    if (!transaction.committed) throw new Error('Транзакция очереди не подтвердилась (PERMISSION_DENIED или оффлайн).');
    const queue = transaction.snapshot.val();
    if (!queue?.roomId || !queue.players?.[uid]) throw new Error('Очередь Firebase вернула пустую комнату.');
    const roomId = queue.roomId;
    const slot = Object.keys(queue.players).indexOf(uid);
    const playerProfile = {
      displayName: profile.displayName || `Игрок ${slot + 1}`,
      color: queue.players[uid].color || palette[slot % palette.length],
      x: 0, z: 0, floor: 0, floorY: 0, yaw: 0, pitch: 0, crouched: false,
      joinedAt: Date.now(),
    };
    const roomRef = dbSdk.ref(db, `rooms/${roomId}`);
    const playerRef = dbSdk.ref(db, `rooms/${roomId}/players/${uid}`);
    const roomTransaction = await dbSdk.runTransaction(roomRef, (room) => {
      room ||= { createdAt: Date.now(), players: {}, world: {} };
      room.players ||= {};
      if (Object.keys(room.players).length === 0) {
        room.world = {};
        room.hostId = uid;
        room.createdAt = Date.now();
      }
      room.players[uid] = playerProfile;
      room.hostId ||= uid;
      room.status = Object.keys(room.players).length >= 4 ? 'full' : 'open';
      room.updatedAt = Date.now();
      return room;
    }, { applyLocally: false });
    if (!roomTransaction.committed) throw new Error('Транзакция комнаты не подтвердилась (PERMISSION_DENIED или оффлайн).');
    await dbSdk.onDisconnect(playerRef).remove();
    const playersRef = dbSdk.ref(db, `rooms/${roomId}/players`);
    const worldRef = dbSdk.ref(db, `rooms/${roomId}/world`);
    const hostRef = dbSdk.ref(db, `rooms/${roomId}/hostId`);
    let currentHostId = roomTransaction.snapshot.val()?.hostId || uid;
    const electHostIfMissing = async (players) => {
      if (currentHostId && players[currentHostId]) return;
      const candidate = Object.entries(players)
        .sort((a, b) => (a[1]?.joinedAt || 0) - (b[1]?.joinedAt || 0) || a[0].localeCompare(b[0]))[0]?.[0];
      if (!candidate) return;
      try {
        await dbSdk.runTransaction(hostRef, (hostId) => hostId && players[hostId] ? hostId : candidate, { applyLocally: false });
      } catch (error) {
        console.debug('Firebase host election:', error);
      }
    };
    const unsubscribePlayers = dbSdk.onValue(playersRef, (snapshot) => {
      const players = snapshot.val() || {};
      onPlayers(players);
      electHostIfMissing(players);
    }, (error) => report(error, 'players'));
    const unsubscribeWorld = dbSdk.onValue(worldRef, (snapshot) => onWorld(snapshot.val() || null), (error) => report(error, 'world'));
    const unsubscribeHost = dbSdk.onValue(hostRef, (snapshot) => {
      if (!snapshot.exists()) return;
      currentHostId = snapshot.val();
      onHost(currentHostId);
    }, (error) => report(error, 'host'));

    // Сигнал начала матча: хост пишет startedAt, остальные получают и стартуют.
    const startRef = dbSdk.ref(db, `rooms/${roomId}/startedAt`);
    const unsubscribeStart = dbSdk.onValue(startRef, (snapshot) => {
      if (snapshot.exists()) onStart(snapshot.val());
    }, (error) => report(error, 'start'));

    return {
      uid,
      roomId,
      hostId: roomTransaction.snapshot.val()?.hostId || uid,
      slot,
      profile: playerProfile,
      players: roomTransaction.snapshot.val()?.players || {},
      world: roomTransaction.snapshot.val()?.world || {},
      connected: true,
      publish: (state) => dbSdk.update(playerRef, { ...state, lastUpdated: dbSdk.serverTimestamp() }),
      publishWorld: (patch) => dbSdk.update(worldRef, patch),
      startMatch: () => dbSdk.update(startRef, Date.now()),
      leave: async () => {
        unsubscribePlayers(); unsubscribeWorld(); unsubscribeHost(); unsubscribeStart();
        await dbSdk.remove(playerRef);
        try {
          await dbSdk.runTransaction(roomRef, (room) => {
            if (!room?.players) return room;
            delete room.players[uid];
            if (!Object.keys(room.players).length) return null;
            if (room.hostId === uid) room.hostId = Object.keys(room.players)[0];
            return room;
          }, { applyLocally: false });
        } catch { /* onDisconnect removes this presence if the client vanishes unexpectedly. */ }
      },
    };
  } catch (error) {
    const message = report(error, 'connect');
    const enriched = new Error(message);
    enriched.userMessage = message;
    enriched.cause = error;
    throw enriched;
  }
}
