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
      unsubscribers.push(dbSdk.onSnapshot(ref, {includeMetadataChanges:true}, snapshot => {
        data[kind] = snapshot.docs.map(doc => ({...doc.data(), id:doc.id}));
        data.ready[kind] = !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites;
        notify();
      }, handlers.error));
    }
    const settingsRef = dbSdk.doc(db, "users", user.uid, "meta", "settings");
    unsubscribers.push(dbSdk.onSnapshot(settingsRef, {includeMetadataChanges:true}, snapshot => {
      data.settings = {exists:snapshot.exists(), value:snapshot.exists() ? snapshot.data().settings : null};
      data.ready.settings = !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites;
      notify();
    }, handlers.error));
  }, handlers.error);

  return {
    signIn(email, password) { return authSdk.signInWithEmailAndPassword(auth, email, password); },
    signUp(email, password) { return authSdk.createUserWithEmailAndPassword(auth, email, password); },
    signOut() { return authSdk.signOut(auth); },
    getUser() { return currentUser; },
    async refresh() {
      const user = currentUser;
      const session = epoch;
      if (!user) throw new Error("ログインしてください");
      const [todos, goals, settings] = await Promise.all([
        dbSdk.getDocsFromServer(dbSdk.collection(db, "users", user.uid, "todos")),
        dbSdk.getDocsFromServer(dbSdk.collection(db, "users", user.uid, "goals")),
        dbSdk.getDocFromServer(dbSdk.doc(db, "users", user.uid, "meta", "settings"))
      ]);
      if (session !== epoch || !currentUser || currentUser.uid !== user.uid) throw new Error("ログイン状態が変わりました");
      return {
        todos:todos.docs.map(doc => ({...doc.data(), id:doc.id})),
        goals:goals.docs.map(doc => ({...doc.data(), id:doc.id})),
        settings:settings.exists() ? settings.data().settings : null,
        hasSettings:settings.exists()
      };
    },
    write(kind, id, value) {
      if (!currentUser) return Promise.reject(new Error("ログインしてください"));
      const path = kind === "settings"
        ? dbSdk.doc(db, "users", currentUser.uid, "meta", "settings")
        : dbSdk.doc(db, "users", currentUser.uid, kind, id);
      return dbSdk.setDoc(path, kind === "settings" ? {settings:value} : value);
    }
  };
}
