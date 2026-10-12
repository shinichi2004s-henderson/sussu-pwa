// Firebase SDK は、設定が完了してログイン機能を使うときだけ読み込みます。
const sdk = "https://www.gstatic.com/firebasejs/12.17.0/";

export async function createSyncApp(config, handlers) {
  const [{initializeApp}, authSdk, dbSdk] = await Promise.all([
    import(sdk + "firebase-app.js"),
    import(sdk + "firebase-auth.js"),
    import(sdk + "firebase-firestore.js")
  ]);
  const app = initializeApp(config);
  const auth = authSdk.getAuth(app);
  const db = dbSdk.getFirestore(app);
  let unsubscribers = [];
  let epoch = 0;
  let currentUser = null;

  function stopListening() {
    unsubscribers.forEach(stop => stop());
    unsubscribers = [];
  }
  authSdk.onAuthStateChanged(auth, user => {
    stopListening();
    currentUser = user;
    epoch++;
    handlers.auth(user ? {uid:user.uid, email:user.email} : null);
    if (!user) return;

    const session = epoch;
    const data = { todos:null, goals:null, settings:null, ready:{todos:false, goals:false, settings:false} };
    const notify = () => {
      if (session !== epoch || !Object.values(data.ready).every(Boolean)) return;
      handlers.remote({
        todos:data.todos, goals:data.goals,
        settings:data.settings.exists ? data.settings.value : null,
        hasSettings:data.settings.exists
      });
    };
    for (const kind of ["todos", "goals"]) {
      const ref = dbSdk.collection(db, "users", user.uid, kind);
      unsubscribers.push(dbSdk.onSnapshot(ref, snapshot => {
        data[kind] = snapshot.docs.map(doc => ({...doc.data(), id:doc.id}));
        data.ready[kind] = !snapshot.metadata.fromCache;
        notify();
      }, handlers.error));
    }
    const settingsRef = dbSdk.doc(db, "users", user.uid, "meta", "settings");
    unsubscribers.push(dbSdk.onSnapshot(settingsRef, snapshot => {
      data.settings = {exists:snapshot.exists(), value:snapshot.exists() ? snapshot.data().settings : null};
      data.ready.settings = !snapshot.metadata.fromCache;
      notify();
    }, handlers.error));
  }, handlers.error);

  return {
    signIn(email, password) { return authSdk.signInWithEmailAndPassword(auth, email, password); },
    signUp(email, password) { return authSdk.createUserWithEmailAndPassword(auth, email, password); },
    signOut() { return authSdk.signOut(auth); },
    getUser() { return currentUser; },
    write(kind, id, value) {
      if (!currentUser) return Promise.reject(new Error("ログインしてください"));
      const path = kind === "settings"
        ? dbSdk.doc(db, "users", currentUser.uid, "meta", "settings")
        : dbSdk.doc(db, "users", currentUser.uid, kind, id);
      return dbSdk.setDoc(path, kind === "settings" ? {settings:value} : value);
    }
  };
}
