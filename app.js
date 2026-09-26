(() => {
  "use strict";

  const STORAGE_KEY = "sussu-data-v1";
  const VERSION = 8;
  // The same 16 choices are used for priority and category colors.
  const COLOR_PALETTE = [
    ["赤", "#d95c5c"], ["濃い赤", "#b94359"], ["オレンジ", "#d58a37"], ["黄", "#d4a72c"],
    ["黄緑", "#84a54b"], ["緑", "#4b9a78"], ["深緑", "#327e72"], ["水色", "#5a9aa6"],
    ["青", "#4e7bbf"], ["濃い青", "#345c9a"], ["紫", "#7c68b8"], ["ピンク", "#bd6e9e"],
    ["茶色", "#c07a55"], ["灰色", "#8b95a7"], ["濃い灰色", "#667085"], ["黒", "#344054"]
  ];

  const DEFAULT_STATE = {
    version: VERSION,
    settings: {
      priorityColors: {
        "high-high": "#d95c5c",
        "high-low": "#4e7bbf",
        "low-high": "#d58a37",
        "low-low": "#8b95a7"
      },
      categories: [
        { id: "cat-work", name: "仕事", color: "#4e7bbf" },
        { id: "cat-study", name: "勉強", color: "#7c68b8" },
        { id: "cat-private", name: "プライベート", color: "#4b9a78" },
        { id: "cat-shopping", name: "買い物", color: "#c07a55" },
        { id: "cat-exercise", name: "運動", color: "#5a9aa6" },
        { id: "cat-other", name: "その他", color: "#8b95a7" }
      ]
    },
    todos: [],
    goals: []
  };

  let state = loadState();
  let selectedDate = todayISO();
  let calendarSelectedDate = todayISO();
  let calendarMonth = calendarSelectedDate.slice(0, 7);
  let activePage = "matrixPage";
  let editTodoId = null;
  let undoTimer = null;
  let pendingUndo = null;
  let suppressClickUntil = 0;
  let syncController = null;
  let syncUser = null;
  let syncReady = false;
  let syncQueue = { todos:{}, goals:{}, settings:null };
  let syncInFlight = new Set();
  let syncStatusText = "同期設定を確認中";
  let lastSavedState = JSON.parse(JSON.stringify(state));

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  function safeColor(color) {
    return typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color : "#8b95a7";
  }

  function uid(prefix = "id") {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function cloneDefaultState() {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return cloneDefaultState();
      const parsed = JSON.parse(raw);
      return normalizeState(parsed);
    } catch (e) {
      console.warn("保存データの読み込みに失敗しました", e);
      return cloneDefaultState();
    }
  }

  function normalizeState(input) {
    const base = cloneDefaultState();
    const merged = {
      ...base,
      ...input,
      settings: {
        ...base.settings,
        ...(input.settings || {}),
        priorityColors: {
          ...base.settings.priorityColors,
          ...((input.settings || {}).priorityColors || {})
        },
        categories: Array.isArray((input.settings || {}).categories)
          ? input.settings.categories
          : base.settings.categories
      },
      todos: Array.isArray(input.todos) ? input.todos : [],
      goals: Array.isArray(input.goals) ? input.goals : []
    };
    merged.todos = merged.todos.map((t, i) => ({
      id: t.id || uid("todo"),
      title: t.title || "",
      details: t.details || "",
      categoryId: t.categoryId || "",
      dueDate: t.dueDate || "",
      executionDate: t.executionDate || "",
      startTime: t.startTime || "",
      endTime: t.endTime || "",
      importance: t.importance === "low" ? "low" : "high",
      urgency: t.urgency === "low" ? "low" : "high",
      weekKey: t.weekKey || "",
      subtasks: Array.isArray(t.subtasks) ? t.subtasks : [],
      completed: Boolean(t.completed),
      completedAt: t.completedAt || "",
      deleted: Boolean(t.deleted),
      purged: Boolean(t.purged),
      sortOrder: Number.isFinite(t.sortOrder) ? t.sortOrder : i * 100,
      createdAt: t.createdAt || new Date().toISOString(),
      updatedAt: t.updatedAt || new Date().toISOString()
    }));
    merged.goals = merged.goals.map(g => ({
      ...g,
      id: g.id || uid("goal"),
      relatedTodoIds: Array.isArray(g.relatedTodoIds) ? g.relatedTodoIds : [],
      steps: Array.isArray(g.steps) ? g.steps.map(s => ({
        id: s.id || uid("step"), title: s.title || "", completed: Boolean(s.completed)
      })) : [],
      completed: Boolean(g.completed),
      deleted: Boolean(g.deleted)
    }));
    return merged;
  }

  function saveState() {
    state.version = VERSION;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (error) { showToast("この端末への保存に失敗しました。空き容量を確認してください"); console.error(error); }
    if (syncController && syncReady) captureLocalChanges(lastSavedState, state);
    else if (window.SUSSU_FIREBASE_CONFIG?.apiKey) {
      const owner = localStorage.getItem("sussu-sync-owner-v7");
      if (owner) {
        try {
          const pending = JSON.parse(localStorage.getItem(syncQueueKey(owner)) || "{}");
          const waiting = {todos:pending.todos || {}, goals:pending.goals || {}, settings:pending.settings || null};
          captureLocalChanges(lastSavedState, state, (kind, id, value) => {
            if (kind === "settings") waiting.settings = value;
            else waiting[kind][id] = value;
          });
          localStorage.setItem(syncQueueKey(owner), JSON.stringify(waiting));
        } catch (error) { console.warn("同期待ちデータを保存できません", error); }
      }
    }
    lastSavedState = JSON.parse(JSON.stringify(state));
  }

  function syncQueueKey(uidValue) { return `sussu-sync-pending-v7-${uidValue}`; }
  function syncHasPending() {
    return Boolean(syncQueue.settings || Object.keys(syncQueue.todos).length || Object.keys(syncQueue.goals).length);
  }
  function setSyncStatus(message) {
    syncStatusText = message;
    const banner = $("#syncBanner");
    if (banner) banner.textContent = syncUser && message !== "同期済み" ? message : "";
    const status = $("#syncStatus");
    if (status) status.textContent = message;
  }
  function persistQueue() {
    if (!syncUser) return;
    try { localStorage.setItem(syncQueueKey(syncUser.uid), JSON.stringify(syncQueue)); }
    catch (error) { setSyncStatus("同期待ちの変更を端末に保存できません。容量を確認してください"); }
  }
  function queueSync(kind, id, value) {
    if (kind === "settings") syncQueue.settings = JSON.parse(JSON.stringify(value));
    else syncQueue[kind][id] = JSON.parse(JSON.stringify(value));
    persistQueue();
    setSyncStatus("同期中（端末内には保存済み）");
    flushSyncQueue();
  }
  function captureLocalChanges(before, after, enqueue = queueSync) {
    for (const kind of ["todos", "goals"]) {
      const previous = new Map(before[kind].map(item => [item.id, item]));
      const current = new Map(after[kind].map(item => [item.id, item]));
      for (const [id, item] of current) {
        if (JSON.stringify(item) !== JSON.stringify(previous.get(id))) enqueue(kind, id, item);
      }
      for (const [id, item] of previous) {
        if (!current.has(id)) enqueue(kind, id, {
          ...item, deleted:true, ...(kind === "todos" ? {purged:true} : {}),
          updatedAt:new Date().toISOString()
        });
      }
    }
    if (JSON.stringify(before.settings) !== JSON.stringify(after.settings)) {
      enqueue("settings", "settings", after.settings);
    }
  }
  function flushSyncQueue() {
    if (!syncController || !syncUser || !navigator.onLine) return;
    const targetUid = syncUser.uid;
    for (const kind of ["todos", "goals", "settings"]) {
      const entries = kind === "settings"
        ? (syncQueue.settings ? [["settings",syncQueue.settings]] : [])
        : Object.entries(syncQueue[kind]);
      for (const [id, value] of entries) {
        const key = kind + ":" + id;
        if (syncInFlight.has(key)) continue;
        syncInFlight.add(key);
        const sent = JSON.stringify(value);
        syncController.write(kind, id, value).then(() => {
          if (syncUser?.uid !== targetUid) return;
          if (kind === "settings") {
            if (JSON.stringify(syncQueue.settings) === sent) syncQueue.settings = null;
          } else if (JSON.stringify(syncQueue[kind][id]) === sent) {
            delete syncQueue[kind][id];
          }
          persistQueue();
          setSyncStatus(syncHasPending() ? "同期中（端末内には保存済み）" : "同期済み");
          syncInFlight.delete(key);
          flushSyncQueue();
        }).catch(error => {
          if (syncUser?.uid !== targetUid) return;
          syncInFlight.delete(key);
          console.warn("同期エラー", error);
          setSyncStatus("同期できていません。通信・Firestoreルールを確認し、設定から再試行してください");
        });
      }
    }
  }
  function hasLocalContent(candidate) {
    return candidate.todos.some(t => !t.purged) ||
      candidate.goals.some(g => !g.deleted) ||
      JSON.stringify(candidate.settings) !== JSON.stringify(DEFAULT_STATE.settings);
  }
  function applyRemoteData(remote) {
    const withPending = (kind, serverItems) => {
      const items = new Map(serverItems.map(item => [item.id, item]));
      for (const [id, item] of Object.entries(syncQueue[kind])) items.set(id, item);
      return Array.from(items.values());
    };
    state = normalizeState({
      settings:syncQueue.settings || remote.settings || DEFAULT_STATE.settings,
      todos:withPending("todos", remote.todos),
      goals:withPending("goals", remote.goals)
    });
    lastSavedState = JSON.parse(JSON.stringify(state));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (error) { setSyncStatus("端末内に保存できません。容量を確認してください"); }
    renderAll();
    carryWeeksForward();
  }
  function remoteChanged(remote) {
    if (!syncUser) return;
    if (!syncReady) {
      const ownerKey = "sussu-sync-owner-v7";
      let oldOwner = localStorage.getItem(ownerKey);
      // ログイン直前のデータを保持。元の画面を初期化せず、設定から書き出せる。
      if (oldOwner !== syncUser.uid && hasLocalContent(state)) {
        try { localStorage.setItem("sussu-before-sync-v7", JSON.stringify(state)); }
        catch (error) { setSyncStatus("移行前の保存先が不足しています。JSONを先に書き出してください"); return; }
        const cloudHasContent = remote.todos.length || remote.goals.length || remote.hasSettings;
        const question = cloudHasContent
          ? "この端末のTodoと目標をクラウドのデータに追加しますか？\nOK: 項目を追加（同じIDはクラウド優先） / キャンセル: クラウドの内容を表示\n元データは設定から書き出せます。"
          : "この端末のTodoと目標をクラウドに取り込みますか？\nOK: 取り込む / キャンセル: この端末の内容を保管して空のクラウドを表示";
        if (confirm(question)) {
          const remoteTodoIds = new Set(remote.todos.map(t => t.id));
          const remoteGoalIds = new Set(remote.goals.map(g => g.id));
          for (const item of state.todos) if (!remoteTodoIds.has(item.id)) syncQueue.todos[item.id] = item;
          for (const item of state.goals) if (!remoteGoalIds.has(item.id)) syncQueue.goals[item.id] = item;
          if (!remote.hasSettings) syncQueue.settings = state.settings;
        }
      } else if (!remote.hasSettings) {
        syncQueue.settings = state.settings;
      }
      localStorage.setItem(ownerKey, syncUser.uid);
      oldOwner = syncUser.uid;
      persistQueue();
      syncReady = true;
    }
    applyRemoteData(remote);
    setSyncStatus(syncHasPending() ? "同期中（端末内には保存済み）" : "同期済み");
    flushSyncQueue();
  }
  function startSync() {
    const config = window.SUSSU_FIREBASE_CONFIG;
    if (!config || !config.apiKey || !config.projectId || !config.appId || !config.authDomain) {
      setSyncStatus("同期未設定：firebase-config.js と Firebase 側の設定が必要です");
      return;
    }
    setSyncStatus("同期サービスに接続中");
    import("./sync.js").then(module => module.createSyncApp(config, {
      auth(user) {
        syncUser = user;
        syncReady = false;
        syncInFlight = new Set();
        syncQueue = {todos:{}, goals:{}, settings:null};
        if (user) {
          try {
            const saved = JSON.parse(localStorage.getItem(syncQueueKey(user.uid)) || "{}");
            syncQueue = {todos:saved.todos || {}, goals:saved.goals || {}, settings:saved.settings || null};
          } catch (error) { console.warn(error); }
        }
        setSyncStatus(user ? "クラウドのデータを確認中" : "同期するには設定からログインしてください");
        renderSyncSettings();
      },
      remote:remoteChanged,
      error(error) {
        console.warn("同期エラー", error);
        setSyncStatus("同期できません。接続やFirebase側の設定を確認してください");
      }
    })).then(client => {
      syncController = client;
      renderSyncSettings();
      window.addEventListener("online", flushSyncQueue);
    }).catch(error => {
      console.warn("Firebase を読み込めません", error);
      setSyncStatus("同期機能を読み込めません。接続を確認してください");
    });
  }

  function todayISO() {
    const d = new Date();
    return localISODate(d);
  }

  function localISODate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function parseISODate(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(dateStr, n) {
    const d = parseISODate(dateStr);
    d.setDate(d.getDate() + n);
    return localISODate(d);
  }

  function startOfWeek(dateStr) {
    const d = parseISODate(dateStr);
    const day = d.getDay();
    const delta = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + delta);
    return localISODate(d);
  }

  function weekRangeText(dateStr) {
    const start = startOfWeek(dateStr);
    const end = addDays(start, 6);
    return `${formatMD(start)} 〜 ${formatMD(end)}`;
  }

  function formatMD(dateStr) {
    if (!dateStr) return "";
    const d = parseISODate(dateStr);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function formatDateJa(dateStr) {
    const d = parseISODate(dateStr);
    const week = ["日","月","火","水","木","金","土"][d.getDay()];
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${week}）`;
  }

  function currentYear() {
    return todayISO().slice(0, 4);
  }

  function currentMonthKey() {
    return todayISO().slice(0, 7);
  }

  function priorityKey(todo) {
    return `${todo.importance}-${todo.urgency}`;
  }

  function priorityColor(todo) {
    return safeColor(state.settings.priorityColors[priorityKey(todo)]);
  }

  function categoryFor(id) {
    return state.settings.categories.find(c => c.id === id);
  }

  function activeTodos() {
    return state.todos.filter(t => !t.deleted && !t.completed && !t.purged);
  }

  function escapeHTML(str = "") {
    return String(str).replace(/[&<>"']/g, ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[ch]));
  }

  function renderAll() {
    applyPriorityColors();
    renderMatrix();
    renderSchedule();
    renderCalendar();
  }

  function calendarEntries(date, todos = activeTodos()) {
    return todos.filter(t => t.executionDate === date || t.dueDate === date)
      .map(todo => ({
        todo,
        scheduled: todo.executionDate === date,
        due: todo.dueDate === date
      }))
      .sort((a, b) =>
        Number(b.scheduled) - Number(a.scheduled) ||
        (a.todo.startTime || "99:99").localeCompare(b.todo.startTime || "99:99") ||
        a.todo.sortOrder - b.todo.sortOrder
      );
  }

  function calendarEventHTML(entry) {
    const { todo, scheduled, due } = entry;
    const label = scheduled
      ? `${todo.startTime || "予定"}${due ? "・期限" : ""}`
      : "期限";
    return `<span class="calendar-event ${scheduled ? "" : "due-only"}"
      style="--priority-color:${priorityColor(todo)}" title="${escapeHTML(todo.title)}">
      ${escapeHTML(label)} ${escapeHTML(todo.title)}
    </span>`;
  }

  function calendarAgendaHTML(entry) {
    const { todo, scheduled, due } = entry;
    const cat = categoryFor(todo.categoryId);
    const time = scheduled && todo.startTime
      ? `${todo.startTime}${todo.endTime ? "〜" + todo.endTime : ""}`
      : scheduled ? "時間未定" : "";
    return `<div class="calendar-agenda-item" style="--priority-color:${priorityColor(todo)}">
      <button class="complete-btn" type="button" data-calendar-complete="${escapeHTML(todo.id)}" aria-label="${escapeHTML(todo.title)}を完了"></button>
      <button class="calendar-agenda-main" type="button" data-calendar-edit="${escapeHTML(todo.id)}">
        <strong>${escapeHTML(todo.title)}</strong>
        <span class="calendar-agenda-meta">
          ${scheduled ? `<span class="badge">${escapeHTML(time)}</span>` : ""}
          ${due ? '<span class="badge calendar-due-badge">期限</span>' : ""}
          ${cat ? `<span class="badge category-badge" style="--cat-color:${safeColor(cat.color)}">${escapeHTML(cat.name)}</span>` : ""}
        </span>
      </button>
    </div>`;
  }

  function renderCalendar() {
    const [year, month] = calendarMonth.split("-").map(Number);
    $("#calendarMonthLabel").textContent = `${year}年${month}月`;
    const first = new Date(year, month - 1, 1);
    const offset = first.getDay();
    const days = new Date(year, month, 0).getDate();
    const cells = Math.ceil((offset + days) / 7) * 7;
    const todos = activeTodos();
    const html = [];
    for (let i = 0; i < cells; i++) {
      const day = i - offset + 1;
      if (day < 1 || day > days) {
        html.push('<div class="calendar-day calendar-outside" role="gridcell" aria-hidden="true"></div>');
        continue;
      }
      const date = `${calendarMonth}-${String(day).padStart(2, "0")}`;
      const entries = calendarEntries(date, todos);
      const classes = [
        "calendar-day",
        date === todayISO() ? "is-today" : "",
        date === calendarSelectedDate ? "is-selected" : ""
      ].filter(Boolean).join(" ");
      html.push(`<div class="${classes}" role="gridcell">
        <button class="calendar-day-button" type="button" data-calendar-date="${date}"
          aria-label="${escapeHTML(formatDateJa(date))}、Todo ${entries.length}件"
          aria-pressed="${date === calendarSelectedDate}">
          <span class="calendar-day-number">${day}</span>
          ${entries.slice(0, 2).map(calendarEventHTML).join("")}
          ${entries.length > 2 ? `<span class="calendar-more">ほか${entries.length - 2}件</span>` : ""}
        </button>
      </div>`);
    }
    $("#calendarGrid").innerHTML = html.join("");
    $("#calendarSelectedLabel").textContent = formatDateJa(calendarSelectedDate);
    const entries = calendarEntries(calendarSelectedDate, todos);
    $("#calendarAgendaList").innerHTML = entries.length
      ? entries.map(calendarAgendaHTML).join("")
      : '<p class="calendar-empty">この日のTodoはありません</p>';
    const undated = todos.filter(t => !t.executionDate && !t.dueDate)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    $("#calendarUndatedCount").textContent = `（${undated.length}件）`;
    $("#calendarUndatedList").innerHTML = undated.length
      ? undated.map(t => calendarAgendaHTML({ todo: t, scheduled: false, due: false })).join("")
      : '<p class="calendar-empty">日付未設定のTodoはありません</p>';
  }

  function moveCalendarMonth(delta) {
    const [year, month] = calendarMonth.split("-").map(Number);
    const date = localISODate(new Date(year, month - 1 + delta, 1));
    calendarMonth = date.slice(0, 7);
    calendarSelectedDate = date;
    renderCalendar();
  }

  function applyPriorityColors() {
    $$(".priority-dot").forEach(dot => {
      dot.style.background = safeColor(state.settings.priorityColors[dot.dataset.priority]);
    });
  }

  function renderMatrix() {
    $$(".matrix-dropzone").forEach(zone => {
      const imp = zone.dataset.importance;
      const urg = zone.dataset.urgency;
      const todos = activeTodos()
        .filter(t => t.importance === imp && t.urgency === urg)
        .sort((a,b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
      zone.innerHTML = todos.length
        ? todos.map(matrixCardHTML).join("")
        : `<div class="empty-note">Todoなし</div>`;
    });
    const usedCategoryIds = new Set(activeTodos().map(t => t.categoryId));
    $("#categoryLegend").innerHTML = state.settings.categories
      .filter(cat => usedCategoryIds.has(cat.id))
      .map(cat => `<span class="category-key" style="--cat-color:${safeColor(cat.color)}"><i aria-hidden="true"></i>${escapeHTML(cat.name)}</span>`).join("");
    attachMatrixInteractions();
  }

  function matrixCardHTML(todo) {
    const cat = categoryFor(todo.categoryId);
    const due = todo.dueDate ? `<span class="badge">期限 ${escapeHTML(formatMD(todo.dueDate))}</span>` : "";
    const exec = todo.executionDate ? `<span class="badge">実行 ${escapeHTML(formatMD(todo.executionDate))}</span>` : "";
    const catBadge = cat
      ? `<span class="badge category-badge" style="--cat-color:${safeColor(cat.color)}"><i aria-hidden="true"></i>${escapeHTML(cat.name)}</span>`
      : "";
    const subDone = todo.subtasks.filter(s => s.completed).length;
    const sub = todo.subtasks.length ? `<span class="badge">${subDone}/${todo.subtasks.length}</span>` : "";
    const subtaskList = todo.subtasks.length ? `<ul class="matrix-subtasks" aria-label="サブTodo">
      ${todo.subtasks.map(s => `<li class="${s.completed ? "is-complete" : ""}">
        <span class="matrix-subtask-mark" aria-hidden="true">${s.completed ? "✓" : ""}</span>
        <span>${escapeHTML(s.title)}</span>
      </li>`).join("")}
    </ul>` : "";
    return `
      <article class="todo-card" data-id="${todo.id}" style="--priority-color:${priorityColor(todo)}">
        <button class="complete-btn" type="button" aria-label="完了" data-complete="${todo.id}"></button>
        <button class="todo-main item-main" type="button" data-edit="${todo.id}">
          <div class="todo-title">${escapeHTML(todo.title)}</div>
          <div class="todo-meta">${catBadge}${due}${exec}${sub}</div>
          ${subtaskList}
        </button>
        <button class="drag-handle" type="button" aria-label="ドラッグして移動" data-drag="${todo.id}">⋮⋮</button>
      </article>
    `;
  }

  function attachMatrixInteractions() {
    $$("[data-complete]").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        completeTodo(btn.dataset.complete);
      });
    });
    $$("[data-edit]").forEach(btn => {
      btn.addEventListener("click", () => {
        if (Date.now() < suppressClickUntil) return;
        openTodoModal(btn.dataset.edit);
      });
    });
    initPointerDrag();
  }

  function renderSchedule() {
    $("#selectedDateLabel").textContent = formatDateJa(selectedDate);
    const weekKey = startOfWeek(todayISO());
    const nextWeekKey = addDays(weekKey, 7);
    $("#weekRangeLabel").textContent = weekRangeText(weekKey);
    $("#nextWeekRangeLabel").textContent = weekRangeText(nextWeekKey);

    const weekTodos = activeTodos()
      .filter(t => t.weekKey === weekKey)
      .sort((a,b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));

    $("#weekTodoList").innerHTML = weekTodos.length
      ? weekTodos.map(t => compactTodoHTML(t, "week")).join("")
      : `<div class="empty-note">今週のTodoはありません</div>`;

    const nextWeekTodos = activeTodos()
      .filter(t => t.weekKey === nextWeekKey)
      .sort((a,b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
    $("#nextWeekTodoList").innerHTML = nextWeekTodos.length
      ? nextWeekTodos.map(t => compactTodoHTML(t, "next-week")).join("")
      : `<div class="empty-note">来週のTodoはありません</div>`;

    const dayTodos = activeTodos()
      .filter(t => t.executionDate === selectedDate)
      .sort((a,b) => (a.startTime || "99:99").localeCompare(b.startTime || "99:99") || a.sortOrder - b.sortOrder);

    const unscheduled = dayTodos.filter(t => !t.startTime);
    $("#unscheduledList").innerHTML = unscheduled.length
      ? unscheduled.map(t => compactTodoHTML(t, "day")).join("")
      : `<div class="empty-note">時間未定のTodoはありません</div>`;

    renderTimeline(dayTodos.filter(t => t.startTime));

    const yearGoals = state.goals.filter(g => !g.deleted && g.type === "year" && g.period === currentYear());
    const monthGoals = state.goals.filter(g => !g.deleted && g.type === "month" && g.period === currentMonthKey());
    $("#yearGoalSummary").textContent = goalSummary(yearGoals);
    $("#monthGoalSummary").textContent = goalSummary(monthGoals);

    attachScheduleInteractions();
  }

  function compactTodoHTML(todo, context) {
    const cat = categoryFor(todo.categoryId);
    const meta = [];
    if (todo.executionDate && (context === "week" || context === "next-week")) meta.push(formatMD(todo.executionDate));
    if (todo.startTime) meta.push(todo.startTime);
    if (todo.dueDate) meta.push(`期限 ${formatMD(todo.dueDate)}`);
    if (cat) meta.push(cat.name);
    return `
      <div class="compact-item" style="--priority-color:${priorityColor(todo)}">
        <button class="complete-btn" type="button" data-complete="${todo.id}" aria-label="完了"></button>
        <button class="item-main" type="button" data-edit="${todo.id}">
          <div class="todo-title">${escapeHTML(todo.title)}</div>
          <div class="todo-meta">${meta.map(m => `<span class="badge">${escapeHTML(m)}</span>`).join("")}</div>
        </button>
        ${context === "week" && !todo.executionDate
          ? `<button class="quick-action" type="button" data-assign-today="${todo.id}">今日へ</button>`
          : `<span></span>`}
      </div>
    `;
  }

  function renderTimeline(todos) {
    const hourHeight = 72;
    const dayStart = 6 * 60;
    const dayEnd = 24 * 60;
    const events = todos.map(todo => {
      const start = toMinutes(todo.startTime);
      if (!Number.isFinite(start) || start >= dayEnd) return null;
      const savedEnd = todo.endTime ? toMinutes(todo.endTime) : NaN;
      const hasEnd = Number.isFinite(savedEnd) && savedEnd > start;
      const end = hasEnd ? savedEnd : start + 60;
      if (end <= dayStart) return null;
      return { todo, start: Math.max(start, dayStart), end: Math.min(end, dayEnd), hasEnd };
    }).filter(Boolean).sort((a, b) => a.start - b.start || a.end - b.end);

    // Give overlapping blocks separate horizontal lanes; reuse lanes after an event ends.
    let group = [];
    let active = [];
    let groupEnd = -1;
    let groupLanes = 0;
    const finishGroup = () => {
      group.forEach(event => { event.lanes = groupLanes; });
      group = [];
      active = [];
      groupLanes = 0;
      groupEnd = -1;
    };
    for (const event of events) {
      if (group.length && event.start >= groupEnd) finishGroup();
      active = active.filter(other => other.end > event.start);
      let lane = 0;
      while (active.some(other => other.lane === lane)) lane++;
      event.lane = lane;
      group.push(event);
      active.push(event);
      groupEnd = Math.max(groupEnd, event.end);
      groupLanes = Math.max(groupLanes, lane + 1);
    }
    if (group.length) finishGroup();

    const labels = [];
    for (let hour = 6; hour <= 24; hour++) {
      labels.push(`<span class="time-tick" style="top:${(hour - 6) * hourHeight}px">${String(hour).padStart(2, "0")}:00</span>`);
    }
    const minWidth = Math.max(0, ...events.map(event => event.lanes * 118));
    $("#timeline").innerHTML = `
      <div class="time-ruler">${labels.join("")}</div>
      <div class="time-canvas" style="min-width:${minWidth}px">
        ${events.map(event => timeBlockHTML(event, dayStart, hourHeight)).join("")}
      </div>
    `;
  }

  function timeBlockHTML(event, dayStart, hourHeight) {
    const { todo, start, end, lane, lanes, hasEnd } = event;
    const cat = categoryFor(todo.categoryId);
    const top = (start - dayStart) * hourHeight / 60;
    const height = (end - start) * hourHeight / 60;
    return `<article class="time-block"
      style="--priority-color:${priorityColor(todo)};top:${top}px;height:${height}px;
        left:calc(${lane} * 100% / ${lanes} + 3px);width:calc(100% / ${lanes} - 6px)">
        <button class="complete-btn" type="button" data-complete="${escapeHTML(todo.id)}" aria-label="${escapeHTML(todo.title)}を完了"></button>
        <button class="time-block-main" type="button" data-edit="${escapeHTML(todo.id)}">
          <div class="todo-title">${escapeHTML(todo.title)}</div>
          <div class="todo-meta">
            <span class="badge">${escapeHTML(todo.startTime)}${hasEnd ? `〜${escapeHTML(todo.endTime)}` : ""}</span>
            ${cat ? `<span class="badge category-badge" style="--cat-color:${safeColor(cat.color)}">${escapeHTML(cat.name)}</span>` : ""}
          </div>
          ${hasEnd && height >= 120 ? `<span class="time-block-end">${escapeHTML(todo.endTime)} 終了</span>` : ""}
        </button>
      </article>`;
  }

  function attachScheduleInteractions() {
    $$("[data-complete]").forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        completeTodo(btn.dataset.complete);
      };
    });
    $$("[data-edit]").forEach(btn => {
      btn.onclick = () => openTodoModal(btn.dataset.edit);
    });
    $$("[data-assign-today]").forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const todo = state.todos.find(t => t.id === btn.dataset.assignToday);
        if (!todo) return;
        todo.executionDate = selectedDate;
        todo.updatedAt = new Date().toISOString();
        saveState();
        renderAll();
        showToast("今日のTodoに割り当てました");
      };
    });
  }

  function goalSummary(goals) {
    if (!goals.length) return "未設定";
    const done = goals.filter(g => g.completed).length;
    const steps = goals.flatMap(g => g.steps || []);
    return steps.length
      ? `目標 ${done}/${goals.length}件・取組 ${steps.filter(s => s.completed).length}/${steps.length}件`
      : `目標 ${done}/${goals.length}件`;
  }

  function completeTodo(id) {
    const todo = state.todos.find(t => t.id === id);
    if (!todo) return;
    const before = JSON.parse(JSON.stringify(todo));
    todo.completed = true;
    todo.completedAt = new Date().toISOString();
    todo.updatedAt = todo.completedAt;
    saveState();
    renderAll();
    showUndoToast(`「${todo.title}」を完了しました`, () => {
      const current = state.todos.find(t => t.id === id);
      if (!current) return;
      Object.assign(current, before);
      saveState();
      renderAll();
    });
  }

  function softDeleteTodo(id) {
    const todo = state.todos.find(t => t.id === id);
    if (!todo) return;
    const before = JSON.parse(JSON.stringify(todo));
    todo.deleted = true;
    todo.updatedAt = new Date().toISOString();
    saveState();
    closeModal();
    renderAll();
    showUndoToast("Todoを削除しました", () => {
      const current = state.todos.find(t => t.id === id);
      if (!current) return;
      Object.assign(current, before);
      saveState();
      renderAll();
    });
  }

  function restoreCompleted(id) {
    const todo = state.todos.find(t => t.id === id);
    if (!todo) return;
    todo.completed = false;
    todo.completedAt = "";
    todo.updatedAt = new Date().toISOString();
    saveState();
    openCompletedModal();
    renderAll();
  }

  function purgeCompleted() {
    const count = state.todos.filter(t => !t.purged && (t.completed || t.deleted)).length;
    if (!count) return;
    if (!confirm("完了一覧・削除済みTodoをすべて完全削除しますか？")) return;
    const now = new Date().toISOString();
    state.todos.forEach(t => {
      if (t.completed || t.deleted) { t.purged = true; t.updatedAt = now; }
    });
    saveState();
    renderAll();
    openCompletedModal();
  }

  function openTodoModal(id = null, preset = {}) {
    editTodoId = id;
    const existing = id ? state.todos.find(t => t.id === id) : null;
    const todo = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: "",
      title: "",
      details: "",
      categoryId: "",
      dueDate: "",
      executionDate: preset.executionDate || "",
      startTime: "",
      endTime: "",
      importance: preset.importance || "high",
      urgency: preset.urgency || "high",
      weekKey: preset.weekKey || "",
      subtasks: [],
      sortOrder: nextSortOrder(preset.importance || "high", preset.urgency || "high")
    };

    const timeOptions = buildTimeOptions(todo.startTime, todo.endTime);
    const categoryOptions = [
      `<option value="">未設定</option>`,
      ...state.settings.categories.map(c => `<option value="${c.id}" ${todo.categoryId === c.id ? "selected" : ""}>${escapeHTML(c.name)}</option>`)
    ].join("");

    const html = `
      <div class="modal-backdrop" data-close-backdrop>
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h2>${existing ? "Todoを編集" : "Todoを追加"}</h2>
            <button class="icon-btn" type="button" data-close-modal>×</button>
          </div>
          <div class="modal-body">
            <form id="todoForm">
              <div class="form-grid">
                <div class="field full">
                  <label for="todoTitle">Todo名 *</label>
                  <input id="todoTitle" maxlength="120" required value="${escapeHTML(todo.title)}" />
                </div>

                <div class="field">
                  <label for="todoDueDate">期限</label>
                  <input id="todoDueDate" type="date" value="${escapeHTML(todo.dueDate)}" />
                </div>

                <div class="field">
                  <label for="todoExecutionDate">実行日</label>
                  <input id="todoExecutionDate" type="date" value="${escapeHTML(todo.executionDate)}" />
                </div>

                <div class="field">
                  <label for="todoStartTime">開始予定時刻（任意）</label>
                  <select id="todoStartTime">${timeOptions.start}</select>
                </div>

                <div class="field">
                  <label for="todoEndTime">終了予定時刻（任意）</label>
                  <select id="todoEndTime">${timeOptions.end}</select>
                </div>

                <div class="field">
                  <label for="todoImportance">重要度</label>
                  <select id="todoImportance">
                    <option value="high" ${todo.importance === "high" ? "selected" : ""}>高い</option>
                    <option value="low" ${todo.importance === "low" ? "selected" : ""}>低い</option>
                  </select>
                </div>

                <div class="field">
                  <label for="todoUrgency">緊急度</label>
                  <select id="todoUrgency">
                    <option value="high" ${todo.urgency === "high" ? "selected" : ""}>高い</option>
                    <option value="low" ${todo.urgency === "low" ? "selected" : ""}>低い</option>
                  </select>
                </div>

                <div class="field full">
                  <label for="todoCategory">カテゴリー</label>
                  <select id="todoCategory">${categoryOptions}</select>
                </div>

                <div class="field full">
                  <label for="todoDetails">詳細</label>
                  <textarea id="todoDetails" maxlength="3000">${escapeHTML(todo.details)}</textarea>
                </div>

                <div class="field full">
                  <label for="todoWeek">週の予定</label>
                  <select id="todoWeek">
                    <option value="" ${!todo.weekKey ? "selected" : ""}>指定しない</option>
                    <option value="${startOfWeek(todayISO())}" ${todo.weekKey === startOfWeek(todayISO()) ? "selected" : ""}>今週（${escapeHTML(weekRangeText(todayISO()))}）</option>
                    <option value="${addDays(startOfWeek(todayISO()), 7)}" ${todo.weekKey === addDays(startOfWeek(todayISO()), 7) ? "selected" : ""}>来週（${escapeHTML(weekRangeText(addDays(startOfWeek(todayISO()), 7)))}）</option>
                  </select>
                </div>

                <div class="field full">
                  <label>サブTodo</label>
                  <div id="subtaskRows" class="subtasks"></div>
                  <button id="addSubtaskBtn" class="secondary-btn" type="button">＋ サブTodo</button>
                </div>
              </div>

              <div class="modal-actions">
                <button class="primary-btn" type="submit">保存</button>
                ${existing ? `<button id="deleteTodoBtn" class="danger-btn" type="button">削除</button>` : ""}
              </div>
            </form>
          </div>
        </div>
      </div>
    `;
    $("#modalRoot").innerHTML = html;

    let workingSubtasks = todo.subtasks.map(s => ({...s}));
    const renderSubtasks = () => {
      $("#subtaskRows").innerHTML = workingSubtasks.length ? workingSubtasks.map((s, i) => `
        <div class="subtask-row" data-sub-index="${i}">
          <input type="checkbox" data-sub-check="${i}" ${s.completed ? "checked" : ""} aria-label="サブTodo完了" />
          <input type="text" data-sub-title="${i}" value="${escapeHTML(s.title)}" placeholder="サブTodo名" />
          <button class="icon-btn" type="button" data-sub-remove="${i}" aria-label="削除">×</button>
        </div>
      `).join("") : `<div class="empty-note">サブTodoはありません</div>`;

      $$("[data-sub-check]", $("#modalRoot")).forEach(el => el.onchange = () => {
        workingSubtasks[Number(el.dataset.subCheck)].completed = el.checked;
      });
      $$("[data-sub-title]", $("#modalRoot")).forEach(el => el.oninput = () => {
        workingSubtasks[Number(el.dataset.subTitle)].title = el.value;
      });
      $$("[data-sub-remove]", $("#modalRoot")).forEach(el => el.onclick = () => {
        workingSubtasks.splice(Number(el.dataset.subRemove), 1);
        renderSubtasks();
      });
    };
    renderSubtasks();

    $("#addSubtaskBtn").onclick = () => {
      workingSubtasks.push({ id: uid("sub"), title: "", completed: false });
      renderSubtasks();
    };

    bindModalClose();

    $("#todoForm").onsubmit = e => {
      e.preventDefault();
      const title = $("#todoTitle").value.trim();
      if (!title) return;

      const startTime = $("#todoStartTime").value;
      const endTime = $("#todoEndTime").value;
      if (startTime && endTime && toMinutes(endTime) <= toMinutes(startTime)) {
        alert("終了時刻は開始時刻より後にしてください。");
        return;
      }

      const now = new Date().toISOString();
      const data = {
        title,
        details: $("#todoDetails").value.trim(),
        categoryId: $("#todoCategory").value,
        dueDate: $("#todoDueDate").value,
        executionDate: $("#todoExecutionDate").value,
        startTime,
        endTime,
        importance: $("#todoImportance").value,
        urgency: $("#todoUrgency").value,
        weekKey: $("#todoWeek").value,
        subtasks: workingSubtasks
          .map(s => ({ id: s.id || uid("sub"), title: (s.title || "").trim(), completed: Boolean(s.completed) }))
          .filter(s => s.title),
        updatedAt: now
      };

      if (existing) {
        const current = state.todos.find(t => t.id === existing.id);
        if (!current) { alert("このTodoが見つかりません。画面を開き直してください。"); return; }
        const changedQuadrant = current.importance !== data.importance || current.urgency !== data.urgency;
        Object.assign(current, data);
        if (changedQuadrant) current.sortOrder = nextSortOrder(data.importance, data.urgency);
      } else {
        state.todos.push({
          id: uid("todo"),
          ...data,
          completed: false,
          completedAt: "",
          deleted: false,
          sortOrder: nextSortOrder(data.importance, data.urgency),
          createdAt: now
        });
      }

      saveState();
      closeModal();
      renderAll();
    };

    if (existing) {
      $("#deleteTodoBtn").onclick = () => softDeleteTodo(existing.id);
    }
  }

  function buildTimeOptions(selectedStart, selectedEnd) {
    const startOptions = [`<option value="">未設定</option>`];
    for (let h = 6; h <= 23; h++) {
      const value = `${String(h).padStart(2, "0")}:00`;
      startOptions.push(`<option value="${value}" ${selectedStart === value ? "selected" : ""}>${value}</option>`);
    }
    const endOptions = [`<option value="">未設定</option>`];
    for (let h = 7; h <= 24; h++) {
      const value = `${String(h).padStart(2, "0")}:00`;
      endOptions.push(`<option value="${value}" ${selectedEnd === value ? "selected" : ""}>${value}</option>`);
    }
    return { start: startOptions.join(""), end: endOptions.join("") };
  }

  function toMinutes(t) {
    const [h,m] = t.split(":").map(Number);
    return h * 60 + m;
  }

  function nextSortOrder(importance, urgency) {
    const items = activeTodos().filter(t => t.importance === importance && t.urgency === urgency);
    return items.length ? Math.max(...items.map(t => t.sortOrder || 0)) + 100 : 100;
  }

  function openCompletedModal() {
    const completed = state.todos
      .filter(t => t.completed && !t.deleted && !t.purged)
      .sort((a,b) => (b.completedAt || "").localeCompare(a.completedAt || ""));
    const deleted = state.todos
      .filter(t => t.deleted && !t.purged)
      .sort((a,b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));

    $("#modalRoot").innerHTML = `
      <div class="modal-backdrop" data-close-backdrop>
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h2>完了一覧</h2>
            <button class="icon-btn" type="button" data-close-modal>×</button>
          </div>
          <div class="modal-body">
            <div class="settings-group">
              <h3>完了したTodo</h3>
              ${completed.length ? completed.map(t => `
                <div class="completed-row">
                  <div>
                    <strong>${escapeHTML(t.title)}</strong>
                    <div class="todo-meta">${t.completedAt ? `<span class="badge">${new Date(t.completedAt).toLocaleString("ja-JP")}</span>` : ""}</div>
                  </div>
                  <button class="secondary-btn" type="button" data-restore="${t.id}">復元</button>
                  <span></span>
                </div>
              `).join("") : `<div class="empty-note">完了したTodoはありません</div>`}
            </div>

            <div class="settings-group">
              <h3>削除済み</h3>
              ${deleted.length ? deleted.map(t => `
                <div class="completed-row">
                  <div><strong>${escapeHTML(t.title)}</strong></div>
                  <button class="secondary-btn" type="button" data-restore-deleted="${t.id}">復元</button>
                  <span></span>
                </div>
              `).join("") : `<div class="empty-note">削除済みTodoはありません</div>`}
            </div>

            <button id="purgeCompletedBtn" class="danger-btn" type="button">完了・削除済みを一括削除</button>
          </div>
        </div>
      </div>
    `;
    bindModalClose();
    $$("[data-restore]").forEach(btn => btn.onclick = () => restoreCompleted(btn.dataset.restore));
    $$("[data-restore-deleted]").forEach(btn => btn.onclick = () => {
      const todo = state.todos.find(t => t.id === btn.dataset.restoreDeleted);
      if (!todo) return;
      todo.deleted = false;
      todo.updatedAt = new Date().toISOString();
      saveState();
      renderAll();
      openCompletedModal();
    });
    $("#purgeCompletedBtn").onclick = purgeCompleted;
  }

  function openSettingsModal() {
    $("#modalRoot").innerHTML = `
      <div class="modal-backdrop" data-close-backdrop>
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h2>設定</h2>
            <button class="icon-btn" type="button" data-close-modal>×</button>
          </div>
          <div class="modal-body">
            <div class="settings-group">
              <h3>端末間の同期</h3>
              <div id="syncSettings"></div>
            </div>

            <div class="settings-group">
              <h3>優先順位カラー</h3>
              ${priorityColorRow("high-high", "重要・緊急")}
              ${priorityColorRow("high-low", "重要・非緊急")}
              ${priorityColorRow("low-high", "非重要・緊急")}
              ${priorityColorRow("low-low", "非重要・非緊急")}
            </div>

            <div class="settings-group">
              <h3>カテゴリー</h3>
              <div id="categorySettings"></div>
              <div class="form-grid" style="margin-top:10px">
                <div class="field">
                  <label>カテゴリー名</label>
                  <input id="newCategoryName" placeholder="例：資格" />
                </div>
                <div class="field">
                  <label>色</label>
                  <input id="newCategoryColor" type="hidden" value="#667085" />
                  ${colorPickerHTML("new", "", "#667085", "新しいカテゴリー")}
                </div>
              </div>
              <button id="addCategoryBtn" class="secondary-btn" type="button">＋ カテゴリー追加</button>
            </div>

            <div class="settings-group">
              <h3>データ管理</h3>
              <div class="modal-actions">
                <button id="exportBtn" class="secondary-btn" type="button">データを書き出す</button>
                <label class="secondary-btn" style="display:inline-flex;align-items:center;cursor:pointer">
                  データを読み込む
                  <input id="importInput" type="file" accept="application/json,.json" class="hidden" />
                </label>
              </div>
              <p style="font-size:12px;color:var(--muted)">JSON形式でバックアップできます。</p>
              ${localStorage.getItem("sussu-before-sync-v7") ? `<button id="exportBeforeSyncBtn" class="secondary-btn" type="button">同期前の端末データを書き出す</button>` : ""}
            </div>

            <div class="settings-group">
              <h3>アプリの更新</h3>
              <button id="openUpdatePageBtn" class="secondary-btn" type="button">更新確認ページを開く</button>
            </div>

            <div class="settings-group">
              <h3>iPhoneホーム画面に追加</h3>
              <p style="font-size:13px;line-height:1.7;margin:0">
                Safariで開き、共有ボタン → 「ホーム画面に追加」を選択してください。
              </p>
            </div>
          </div>
        </div>
      </div>
    `;
    bindModalClose();
    renderCategorySettings();
    renderSyncSettings();

    // Delegation also handles category rows rebuilt after adding or removing one.
    $("#modalRoot").onclick = event => {
      const swatch = event.target.closest(".palette-swatch");
      if (!swatch) return;
      const picker = swatch.closest(".palette-picker");
      const color = swatch.dataset.color;
      const kind = picker.dataset.kind;
      const key = picker.dataset.key;
      if (kind === "priority") state.settings.priorityColors[key] = color;
      else if (kind === "category") {
        const cat = categoryFor(key);
        if (!cat) return;
        cat.color = color;
      } else $("#newCategoryColor").value = color;
      picker.querySelector(".palette-current").style.backgroundColor = color;
      picker.querySelector(".palette-current-label").textContent = COLOR_PALETTE.find(item => item[1] === color)[0];
      $$(".palette-swatch", picker).forEach(btn => btn.setAttribute("aria-pressed", String(btn === swatch)));
      picker.open = false;
      if (kind !== "new") { saveState(); renderAll(); }
    };

    $("#addCategoryBtn").onclick = () => {
      const name = $("#newCategoryName").value.trim();
      if (!name) return;
      state.settings.categories.push({
        id: uid("cat"),
        name,
        color: $("#newCategoryColor").value
      });
      saveState();
      $("#newCategoryName").value = "";
      renderCategorySettings();
      renderAll();
    };

    $("#exportBtn").onclick = exportData;
    $("#openUpdatePageBtn").onclick = () => { location.href = "./update.html"; };
    $("#importInput").onchange = importData;
    if ($("#exportBeforeSyncBtn")) $("#exportBeforeSyncBtn").onclick = () => {
      const blob = new Blob([localStorage.getItem("sussu-before-sync-v7")], {type:"application/json"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `sussu-before-sync-${todayISO()}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
  }

  function renderSyncSettings() {
    const host = $("#syncSettings");
    if (!host) return;
    const configured = Boolean(window.SUSSU_FIREBASE_CONFIG?.apiKey);
    host.innerHTML = `<p class="sync-status" id="syncStatus">${escapeHTML(syncStatusText)}</p>` +
      (!configured ? `<p class="sync-setup">Firebase の設定がまだ入っていません。付属の「同期設定の手順」を参照してください。設定するまでは、この端末に保存して使えます。</p>` :
      syncUser ? `<p>ログイン中：<strong>${escapeHTML(syncUser.email || "ユーザー")}</strong></p>
        <div class="sync-actions"><button class="secondary-btn" type="button" id="syncRetryBtn">同期を再試行</button>
        <button class="secondary-btn" type="button" id="syncSignOutBtn">ログアウト</button></div>` :
      `<form id="syncAuthForm" class="sync-auth-form">
        <label>メールアドレス<input id="syncEmail" type="email" autocomplete="email" required /></label>
        <label>パスワード<input id="syncPassword" type="password" autocomplete="current-password" minlength="6" required /></label>
        <div class="sync-actions"><button id="syncSignInBtn" class="primary-btn" type="submit">ログイン</button>
        <button id="syncSignUpBtn" class="secondary-btn" type="button">新規登録</button></div>
      </form>`);
    if (!configured || !syncController) return;
    if (syncUser) {
      $("#syncRetryBtn").onclick = flushSyncQueue;
      $("#syncSignOutBtn").onclick = async () => {
        if (syncHasPending() && !confirm("未同期の変更があります。ログアウトすると、この端末に保管されます。続行しますか？")) return;
        await syncController.signOut();
        // 共有PCの画面にはログアウト後の個人データを残さない。
        localStorage.removeItem("sussu-sync-owner-v7");
        state = cloneDefaultState();
        lastSavedState = JSON.parse(JSON.stringify(state));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        renderAll();
      };
      return;
    }
    const form = $("#syncAuthForm");
    async function submitAuth(create) {
      const email = $("#syncEmail").value.trim();
      const password = $("#syncPassword").value;
      if (!form.reportValidity()) return;
      try {
        setSyncStatus(create ? "アカウントを登録中" : "ログイン中");
        if (create) await syncController.signUp(email, password);
        else await syncController.signIn(email, password);
      } catch (error) {
        console.warn(error);
        setSyncStatus("ログインできません。メールアドレス・パスワードとFirebaseの設定を確認してください");
      }
    }
    form.onsubmit = event => { event.preventDefault(); submitAuth(false); };
    $("#syncSignUpBtn").onclick = () => submitAuth(true);
  }

  function priorityColorRow(key, label) {
    return `
      <div class="color-row">
        <span>${label}</span>
        ${colorPickerHTML("priority", key, state.settings.priorityColors[key], label)}
      </div>
    `;
  }

  function colorPickerHTML(kind, key, savedColor, label) {
    const color = safeColor(savedColor);
    const current = COLOR_PALETTE.find(item => item[1] === color);
    return `<details class="palette-picker" data-kind="${kind}" data-key="${escapeHTML(key)}">
      <summary aria-label="${escapeHTML(label)}の色を選択"><span class="palette-current" style="background-color:${color}"></span><span class="palette-current-label">${current ? current[0] : "現在の色"}</span><span aria-hidden="true">▾</span></summary>
      <div class="palette-grid" role="group" aria-label="${escapeHTML(label)}：16色から選択">
        ${COLOR_PALETTE.map(([name, value]) => `<button type="button" class="palette-swatch" style="background-color:${value}" data-color="${value}" aria-label="${name}" title="${name}" aria-pressed="${value === color}"></button>`).join("")}
      </div>
    </details>`;
  }

  function renderCategorySettings() {
    const host = $("#categorySettings");
    if (!host) return;
    host.innerHTML = state.settings.categories.map(c => `
      <div class="category-row">
        <input type="text" value="${escapeHTML(c.name)}" data-cat-name="${c.id}" aria-label="カテゴリー名" />
        ${colorPickerHTML("category", c.id, c.color, c.name)}
        <button class="danger-btn" type="button" data-cat-delete="${c.id}">削除</button>
      </div>
    `).join("");

    $$("[data-cat-name]", host).forEach(input => input.onchange = () => {
      const cat = categoryFor(input.dataset.catName);
      if (!cat) return;
      cat.name = input.value.trim() || cat.name;
      saveState();
      renderAll();
    });
    $$("[data-cat-delete]", host).forEach(btn => btn.onclick = () => {
      const id = btn.dataset.catDelete;
      const cat = categoryFor(id);
      if (!cat) return;
      if (!confirm(`カテゴリー「${cat.name}」を削除しますか？\n既存Todoのカテゴリー設定は解除されます。`)) return;
      state.todos.forEach(t => { if (t.categoryId === id) t.categoryId = ""; });
      state.settings.categories = state.settings.categories.filter(c => c.id !== id);
      saveState();
      renderCategorySettings();
      renderAll();
    });
  }

  function exportData() {
    const payload = JSON.stringify({
      exportedAt: new Date().toISOString(),
      app: "すっす",
      data: state
    }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sussu-backup-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("バックアップを書き出しました");
  }

  async function importData(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const candidate = parsed.data || parsed;
      if (!candidate || !Array.isArray(candidate.todos)) throw new Error("形式が不正です");
      if (!confirm(syncReady
        ? "バックアップを読み込みますか？ 現在のデータと同期先の全端末に反映され、バックアップにない項目は削除扱いになります。先に現在のデータを書き出してください。"
        : "現在のデータを読み込んだバックアップで置き換えますか？")) return;
      state = normalizeState(candidate);
      saveState();
      renderAll();
      closeModal();
      showToast("バックアップを読み込みました");
    } catch (err) {
      alert("バックアップを読み込めませんでした。JSONファイルを確認してください。");
    } finally {
      e.target.value = "";
    }
  }

  function openGoalsModal(type) {
    const period = type === "year" ? currentYear() : currentMonthKey();
    const title = type === "year"
      ? `${period}年の目標`
      : `${Number(period.slice(5,7))}月の目標`;
    const goals = state.goals.filter(g => !g.deleted && g.type === type && g.period === period);
    const openGoals = goals.filter(g => !g.completed);
    const completedGoals = goals.filter(g => g.completed);
    const goalRow = g => {
      const steps = (g.steps || []).slice().sort((a,b) => Number(a.completed) - Number(b.completed));
      const done = steps.filter(s => s.completed).length;
      return `<div class="goal-entry">
        <div class="goal-row">
          <label class="goal-complete-label">
            <input type="checkbox" data-complete-goal="${escapeHTML(g.id)}" ${g.completed ? "checked" : ""} />
            <strong>${escapeHTML(g.title)}</strong>
          </label>
          <button class="secondary-btn" type="button" data-edit-goal="${escapeHTML(g.id)}">編集</button>
        </div>
        ${steps.length ? `<div class="goal-progress" aria-label="進捗 ${done}/${steps.length}件"><div style="width:${Math.round(done / steps.length * 100)}%"></div></div>
          <small>進捗項目 ${done}/${steps.length}件</small>
          <div class="goal-step-list">${steps.map(s => `
            <label class="${s.completed ? "done" : ""}">
              <input type="checkbox" data-goal-step="${escapeHTML(g.id)}" data-step-id="${escapeHTML(s.id)}" ${s.completed ? "checked" : ""} />
              <span>${escapeHTML(s.title)}</span>
            </label>`).join("")}</div>` : `<small>進捗項目は未登録</small>`}
        <div class="todo-meta"><span class="badge">関連Todo ${(g.relatedTodoIds || []).length}件</span></div>
      </div>`;
    };

    $("#modalRoot").innerHTML = `
      <div class="modal-backdrop" data-close-backdrop>
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h2>${escapeHTML(title)}</h2>
            <button class="icon-btn" type="button" data-close-modal>×</button>
          </div>
          <div class="modal-body">
            <div class="goal-list">
              ${openGoals.length ? openGoals.map(goalRow).join("") : `<div class="empty-note">未完了の目標はありません</div>`}
            </div>
            <button id="addGoalBtn" class="primary-btn" type="button">＋ 目標を追加</button>
            ${completedGoals.length ? `<details class="goal-list goal-completed"><summary>完了した目標（${completedGoals.length}件）</summary>
              ${completedGoals.map(goalRow).join("")}</details>` : ""}
          </div>
        </div>
      </div>
    `;
    bindModalClose();
    $("#addGoalBtn").onclick = () => openGoalEditModal(type, period);
    $$("[data-edit-goal]").forEach(btn => btn.onclick = () => openGoalEditModal(type, period, btn.dataset.editGoal));
    $$("[data-complete-goal]").forEach(box => box.onchange = () => {
      const goal = state.goals.find(g => g.id === box.dataset.completeGoal);
      if (!goal) return;
      goal.completed = box.checked;
      goal.updatedAt = new Date().toISOString();
      saveState(); renderAll(); openGoalsModal(type);
    });
    $$("[data-goal-step]").forEach(box => box.onchange = () => {
      const goal = state.goals.find(g => g.id === box.dataset.goalStep);
      const step = goal && goal.steps.find(s => s.id === box.dataset.stepId);
      if (!step) return;
      step.completed = box.checked;
      goal.updatedAt = new Date().toISOString();
      saveState(); renderAll(); openGoalsModal(type);
    });
  }

  function openGoalEditModal(type, period, goalId = null) {
    const existing = goalId ? state.goals.find(g => g.id === goalId) : null;
    const goal = existing ? JSON.parse(JSON.stringify(existing)) : {
      id: "",
      type,
      period,
      title: "",
      details: "",
      dueDate: "",
      relatedTodoIds: [],
      steps: []
    };
    const todos = activeTodos();
    let workingSteps = (goal.steps || []).map(s => ({...s}));

    $("#modalRoot").innerHTML = `
      <div class="modal-backdrop" data-close-backdrop>
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h2>${existing ? "目標を編集" : "目標を追加"}</h2>
            <button class="icon-btn" type="button" data-close-modal>×</button>
          </div>
          <div class="modal-body">
            <form id="goalForm">
              <div class="field">
                <label>目標名 *</label>
                <input id="goalTitle" required maxlength="160" value="${escapeHTML(goal.title)}" />
              </div>
              <div class="field">
                <label>詳細</label>
                <textarea id="goalDetails">${escapeHTML(goal.details)}</textarea>
              </div>
              <div class="form-grid">
                <div class="field">
                  <label>期限</label>
                  <input id="goalDueDate" type="date" value="${escapeHTML(goal.dueDate)}" />
                </div>
              </div>
              <div class="field">
                <label>進捗項目</label>
                <p class="field-hint">チェックした項目は下へ移動します。達成状況は目標一覧に表示されます。</p>
                <div id="goalStepRows" class="goal-step-editor"></div>
                <button id="addGoalStepBtn" class="secondary-btn" type="button">＋ 項目を追加</button>
              </div>
              <div class="field">
                <label>関連Todo</label>
                <div class="goal-checklist">
                  ${todos.length ? todos.map(t => `
                    <label>
                      <input type="checkbox" data-goal-todo="${escapeHTML(t.id)}" ${(goal.relatedTodoIds || []).includes(t.id) ? "checked" : ""} />
                      <span>${escapeHTML(t.title)}</span>
                    </label>
                  `).join("") : `<div class="empty-note">関連付けられるTodoがありません</div>`}
                </div>
              </div>
              <div class="modal-actions">
                <button class="primary-btn" type="submit">保存</button>
                ${existing ? `<button id="deleteGoalBtn" class="danger-btn" type="button">削除</button>` : ""}
              </div>
            </form>
          </div>
        </div>
      </div>
    `;
    bindModalClose();
    function renderGoalSteps() {
      workingSteps.sort((a,b) => Number(a.completed) - Number(b.completed));
      $("#goalStepRows").innerHTML = workingSteps.length ? workingSteps.map((s,i) => `
        <div class="goal-step-edit-row">
          <input type="checkbox" data-step-check="${i}" ${s.completed ? "checked" : ""} aria-label="進捗項目を完了" />
          <input type="text" data-step-title="${i}" value="${escapeHTML(s.title)}" maxlength="160" placeholder="達成すること" aria-label="進捗項目" />
          <button type="button" class="icon-btn" data-step-remove="${i}" aria-label="項目を削除">×</button>
        </div>`).join("") : `<div class="empty-note">項目はまだありません</div>`;
      $$("[data-step-title]").forEach(input => input.oninput = () => { workingSteps[Number(input.dataset.stepTitle)].title = input.value; });
      $$("[data-step-check]").forEach(input => input.onchange = () => {
        workingSteps[Number(input.dataset.stepCheck)].completed = input.checked;
        renderGoalSteps();
      });
      $$("[data-step-remove]").forEach(btn => btn.onclick = () => {
        workingSteps.splice(Number(btn.dataset.stepRemove), 1); renderGoalSteps();
      });
    }
    renderGoalSteps();
    $("#addGoalStepBtn").onclick = () => {
      workingSteps.push({ id: uid("step"), title: "", completed: false });
      renderGoalSteps();
      const fields = $$("[data-step-title]");
      fields[fields.length - 1]?.focus();
    };

    $("#goalForm").onsubmit = e => {
      e.preventDefault();
      const data = {
        type,
        period,
        title: $("#goalTitle").value.trim(),
        details: $("#goalDetails").value.trim(),
        dueDate: $("#goalDueDate").value,
        relatedTodoIds: $$("[data-goal-todo]").filter(x => x.checked).map(x => x.dataset.goalTodo),
        steps: workingSteps.map(s => ({id:s.id, title:s.title.trim(), completed:s.completed})).filter(s => s.title)
      };
      if (!data.title) return;

      if (existing) {
        const current = state.goals.find(g => g.id === existing.id);
        if (!current) { alert("この目標が見つかりません。画面を開き直してください。"); return; }
        Object.assign(current, data, { updatedAt: new Date().toISOString() });
      }
      else state.goals.push({ id: uid("goal"), ...data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

      saveState();
      renderAll();
      openGoalsModal(type);
    };

    if (existing) {
      $("#deleteGoalBtn").onclick = () => {
        if (!confirm("この目標を削除しますか？")) return;
        const current = state.goals.find(g => g.id === existing.id);
        if (!current) return;
        current.deleted = true;
        current.updatedAt = new Date().toISOString();
        saveState();
        renderAll();
        openGoalsModal(type);
      };
    }
  }

  function bindModalClose() {
    $$("[data-close-modal]").forEach(btn => btn.onclick = closeModal);
    const backdrop = $("[data-close-backdrop]");
    if (backdrop) {
      backdrop.onclick = e => {
        if (e.target === backdrop) closeModal();
      };
    }
  }

  function closeModal() {
    $("#modalRoot").innerHTML = "";
    editTodoId = null;
  }

  function showToast(message) {
    clearTimeout(undoTimer);
    pendingUndo = null;
    const toast = $("#toast");
    toast.innerHTML = `<span>${escapeHTML(message)}</span>`;
    toast.classList.add("show");
    undoTimer = setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function showUndoToast(message, undoFn) {
    clearTimeout(undoTimer);
    pendingUndo = undoFn;
    const toast = $("#toast");
    toast.innerHTML = `<span>${escapeHTML(message)}</span><button type="button" id="undoToastBtn">元に戻す</button>`;
    toast.classList.add("show");
    $("#undoToastBtn").onclick = () => {
      if (pendingUndo) pendingUndo();
      pendingUndo = null;
      toast.classList.remove("show");
      clearTimeout(undoTimer);
    };
    undoTimer = setTimeout(() => {
      pendingUndo = null;
      toast.classList.remove("show");
    }, 5000);
  }

  function switchPage(pageId) {
    activePage = pageId;
    $$(".page").forEach(p => p.classList.toggle("active", p.id === pageId));
    $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.page === pageId));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function carryWeeksForward() {
    const current = startOfWeek(todayISO());
    const now = new Date().toISOString();
    const overdue = activeTodos().filter(t => /^\d{4}-\d{2}-\d{2}$/.test(t.weekKey) && t.weekKey < current);
    if (!overdue.length) return;
    overdue.forEach(t => { t.weekKey = current; t.updatedAt = now; });
    saveState();
    renderAll();
  }

  function scheduleWeekBoundary() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(0, 0, 0, 0);
    const daysUntilMonday = ((8 - now.getDay()) % 7) || 7;
    next.setDate(next.getDate() + daysUntilMonday);
    setTimeout(() => {
      carryWeeksForward();
      renderSchedule();
      scheduleWeekBoundary();
    }, Math.max(100, next.getTime() - now.getTime() + 100));
  }

  function checkYesterdayCarryover() {
    const yesterday = addDays(todayISO(), -1);
    const items = activeTodos().filter(t => t.executionDate === yesterday);
    if (!items.length) return;

    $("#modalRoot").innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true">
          <div class="modal-head">
            <h2>昨日の未完了Todo</h2>
          </div>
          <div class="modal-body">
            <p style="margin-top:0;color:var(--muted);font-size:13px">昨日の未完了Todoが${items.length}件あります。</p>
            <div class="goal-checklist">
              ${items.map(t => `
                <label>
                  <input type="checkbox" data-carry="${t.id}" checked />
                  <span>${escapeHTML(t.title)}</span>
                </label>
              `).join("")}
            </div>
            <div class="modal-actions">
              <button id="carryAllBtn" class="primary-btn" type="button">すべて今日へ移動</button>
              <button id="carrySelectedBtn" class="secondary-btn" type="button">選択して移動</button>
              <button id="carryNoneBtn" class="secondary-btn" type="button">そのまま残す</button>
            </div>
          </div>
        </div>
      </div>
    `;

    const move = ids => {
      state.todos.forEach(t => {
        if (ids.includes(t.id)) {
          t.executionDate = todayISO();
          t.updatedAt = new Date().toISOString();
        }
      });
      saveState();
      closeModal();
      renderAll();
    };
    $("#carryAllBtn").onclick = () => move(items.map(t => t.id));
    $("#carrySelectedBtn").onclick = () => move($$("[data-carry]").filter(x => x.checked).map(x => x.dataset.carry));
    $("#carryNoneBtn").onclick = closeModal;
  }

  // Touch/Pointer compatible matrix drag using only local code.
  let drag = null;

  function initPointerDrag() {
    $$("[data-drag]").forEach(handle => {
      handle.onpointerdown = e => {
        e.preventDefault();
        const card = handle.closest(".todo-card");
        if (!card) return;
        drag = {
          id: handle.dataset.drag,
          card,
          pointerId: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          started: false,
          timer: null,
          ghost: null,
          zone: null
        };
        const delay = e.pointerType === "mouse" ? 0 : 140;
        drag.timer = setTimeout(() => startDrag(e), delay);
        document.addEventListener("pointermove", onDragMove, { passive: false });
        document.addEventListener("pointerup", endDrag, { passive: false });
        document.addEventListener("pointercancel", cancelDrag, { passive: false });
      };
    });
  }

  function startDrag(e) {
    if (!drag || drag.started) return;
    drag.started = true;
    drag.card.classList.add("dragging");
    drag.ghost = drag.card.cloneNode(true);
    drag.ghost.classList.add("drag-ghost");
    drag.ghost.classList.remove("dragging");
    document.body.appendChild(drag.ghost);
    positionGhost(drag.x, drag.y);
    suppressClickUntil = Date.now() + 500;
  }

  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.started) {
      const dx = Math.abs(e.clientX - drag.x);
      const dy = Math.abs(e.clientY - drag.y);
      if (dx + dy > 16) clearTimeout(drag.timer);
      return;
    }
    e.preventDefault();
    positionGhost(e.clientX, e.clientY);
    $$(".matrix-dropzone").forEach(z => z.classList.remove("drag-target"));
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const zone = el && el.closest(".matrix-dropzone");
    if (zone) {
      zone.classList.add("drag-target");
      drag.zone = zone;
    } else {
      drag.zone = null;
    }
  }

  function positionGhost(x, y) {
    if (!drag || !drag.ghost) return;
    drag.ghost.style.left = `${Math.min(window.innerWidth - 270, Math.max(8, x + 12))}px`;
    drag.ghost.style.top = `${Math.min(window.innerHeight - 120, Math.max(8, y - 30))}px`;
  }

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.pointerId) return cleanupDrag();
    clearTimeout(drag.timer);
    if (drag.started && drag.zone) {
      performDrop(drag.id, drag.zone, e.clientY);
    }
    cleanupDrag();
  }

  function cancelDrag() {
    if (!drag) return;
    clearTimeout(drag.timer);
    cleanupDrag();
  }

  function cleanupDrag() {
    document.removeEventListener("pointermove", onDragMove);
    document.removeEventListener("pointerup", endDrag);
    document.removeEventListener("pointercancel", cancelDrag);
    $$(".matrix-dropzone").forEach(z => z.classList.remove("drag-target"));
    if (drag) {
      if (drag.card) drag.card.classList.remove("dragging");
      if (drag.ghost) drag.ghost.remove();
    }
    drag = null;
  }

  function performDrop(todoId, zone, y) {
    const todo = state.todos.find(t => t.id === todoId);
    if (!todo) return;
    const newImp = zone.dataset.importance;
    const newUrg = zone.dataset.urgency;

    const visibleCards = $$(".todo-card", zone).filter(c => c.dataset.id !== todoId);
    let insertIndex = visibleCards.length;
    for (let i = 0; i < visibleCards.length; i++) {
      const rect = visibleCards[i].getBoundingClientRect();
      if (y < rect.top + rect.height / 2) {
        insertIndex = i;
        break;
      }
    }

    todo.importance = newImp;
    todo.urgency = newUrg;
    todo.updatedAt = new Date().toISOString();

    const destination = activeTodos()
      .filter(t => t.id !== todoId && t.importance === newImp && t.urgency === newUrg)
      .sort((a,b) => a.sortOrder - b.sortOrder);

    destination.splice(insertIndex, 0, todo);
    destination.forEach((t, i) => t.sortOrder = (i + 1) * 100);

    saveState();
    renderAll();
  }

  function registerPWA() {
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(err => {
          console.warn("Service Worker registration failed", err);
        });
      });
    }
  }

  function initEvents() {
    $$(".tab").forEach(tab => {
      tab.onclick = () => switchPage(tab.dataset.page);
    });

    $("#addMatrixTodoBtn").onclick = () => openTodoModal(null, { importance: "high", urgency: "high" });
    $("#addWeekTodoBtn").onclick = () => openTodoModal(null, { weekKey: startOfWeek(todayISO()) });
    $("#addNextWeekTodoBtn").onclick = () => openTodoModal(null, { weekKey: addDays(startOfWeek(todayISO()), 7) });
    $("#addDayTodoBtn").onclick = () => openTodoModal(null, { executionDate: selectedDate });
    $("#addCalendarTodoBtn").onclick = () => openTodoModal(null, { executionDate: calendarSelectedDate });
    $("#calendarAddForDateBtn").onclick = () => openTodoModal(null, { executionDate: calendarSelectedDate });
    $("#prevMonthBtn").onclick = () => moveCalendarMonth(-1);
    $("#nextMonthBtn").onclick = () => moveCalendarMonth(1);
    $("#calendarTodayBtn").onclick = () => {
      calendarSelectedDate = todayISO();
      calendarMonth = calendarSelectedDate.slice(0, 7);
      renderCalendar();
    };
    $("#calendarPage").onclick = event => {
      const dateButton = event.target.closest("[data-calendar-date]");
      if (dateButton) {
        calendarSelectedDate = dateButton.dataset.calendarDate;
        renderCalendar();
        $(".calendar-agenda").scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const completeButton = event.target.closest("[data-calendar-complete]");
      if (completeButton) { completeTodo(completeButton.dataset.calendarComplete); return; }
      const editButton = event.target.closest("[data-calendar-edit]");
      if (editButton) openTodoModal(editButton.dataset.calendarEdit);
    };

    $("#prevDayBtn").onclick = () => {
      selectedDate = addDays(selectedDate, -1);
      renderSchedule();
    };
    $("#nextDayBtn").onclick = () => {
      selectedDate = addDays(selectedDate, 1);
      renderSchedule();
    };

    $("#completedBtn").onclick = openCompletedModal;
    $("#settingsBtn").onclick = openSettingsModal;
    $("#yearGoalsBtn").onclick = () => openGoalsModal("year");
    $("#monthGoalsBtn").onclick = () => openGoalsModal("month");
  }

  function seedSampleDataIfWanted() {
    // 初期状態は空のまま。必要ならここにサンプルTodoを追加できます。
  }

  function init() {
    seedSampleDataIfWanted();
    initEvents();
    renderAll();
    carryWeeksForward();
    scheduleWeekBoundary();
    let lastSeenDay = todayISO();
    setInterval(() => {
      if (lastSeenDay !== todayISO()) { lastSeenDay = todayISO(); carryWeeksForward(); renderSchedule(); }
    }, 30 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) { lastSeenDay = todayISO(); carryWeeksForward(); renderSchedule(); }
    });
    checkYesterdayCarryover();
    registerPWA();
    startSync();
  }

  init();
})();
