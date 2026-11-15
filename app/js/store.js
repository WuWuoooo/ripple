/* ============================================================
   状态 / 本地库 / 设置持久化
   ============================================================ */
(function (g) {
  const KEY = 'ripple.state.v1';
  const DB_NAME = 'ripple-db';
  const DB_STORE = 'files';

  const DEFAULTS = {
    theme: 'dark',
    dynamicColor: true,
    glassBlur: 26,
    animSpeed: 1,
    compactList: false,
    quality: 'exhigh',
    eq: 'off',
    eqCustom: [0, 0, 0, 0, 0],   // 自定义均衡器的 5 段增益（dB）
    fade: 0.4,
    gapless: true,
    normalize: false,
    speed: 1,
    showLyric: true,
    showTrans: true,
    lyricSize: 14,
    lyricOffset: 0,
    mediaSession: true,
    notifyQuiet: true,
    apiBase: '',
    syncLikes: true,
    volume: 0.85,
    shuffle: false,
    repeat: 'all',
    playMode: 'list',
    lastIndex: 0,
    lastTrackId: '',
    lastPosition: 0,
    lastQueue: [],
    /* ---------- 状态栏歌词 ---------- */
    sbLyric: false,           // 开关
    sbLocked: true,           // 锁定：不可拖动、不可改
    sbColor: '#FFFFFF',       // 颜色
    sbSize: 12,               // 字号 sp
    sbAlpha: 0.92,            // 不透明度
    sbX: -1,                  // 位置（px，-1 = 默认）
    sbY: -1,
    sbBold: true,
    sbShadow: true,
    sbFill: false,            // 跟随播放进度填充
    sbFillColor: '#7DE3D0',   // 填充色

    sleepMin: 0,          // 睡眠定时（分钟）；以前 DEFAULTS 里根本没有这一项
    sleepUntil: 0,        // 睡眠定时的绝对结束时刻，重启后据此恢复
  };

  /* ---------------- 示例曲库（已移除） ----------------
     1.2.4 起不再内置示例歌曲：曲库只包含「本机导入」和网易云在线内容。
     保留空数组是为了兼容旧代码里对 DEMO 的引用。
     ---------------------------------------------------- */
  const DEMO = [];

  const Store = {
    state: null,
    localTracks: [],
    _db: null,

    /* ---------- 持久化 ---------- */
    load() {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { saved = {}; }
      /*
       * localStorage 可能被写坏（手工改、版本升级、配额写一半）。
       * 以前这里直接用 saved.history，一旦它变成非数组，
       * 后面 h.slice() / for...of 就会抛错 → boot 整个失败、界面白屏。
       * 这里逐项兜底成数组。
       */
      const arr = (v) => (Array.isArray(v) ? v : []);
      this.state = {
        settings: Object.assign({}, DEFAULTS, (saved.settings && typeof saved.settings === 'object') ? saved.settings : {}),
        liked: arr(saved.liked).filter((x) => typeof x === 'string'),
        history: arr(saved.history).filter((x) => x && x.id),
        playedSec: Number(saved.playedSec) > 0 ? Number(saved.playedSec) : 0,
        imports: arr(saved.imports),
        onlineCache: arr(saved.onlineCache).filter((x) => x && x.id),
      };
      return this.state;
    },
    save() {
      const s = this.state;
      try {
        localStorage.setItem(KEY, JSON.stringify({
          settings: s.settings, liked: s.liked, history: s.history.slice(0, 200),
          playedSec: s.playedSec, imports: s.imports, onlineCache: (s.onlineCache || []).slice(0, 60),
        }));
      } catch (e) {}
    },
    set(key, val) {
      this.state.settings[key] = val;
      this.save();
    },

    /* ---------- IndexedDB ---------- */
    async db() {
      if (this._db) return this._db;
      // file:// 下（Android 外壳）部分内核禁用 IndexedDB，这里快速失败，
      // 让导入走「仅本次会话可用」的降级路径，而不是整段抛错。
      if (typeof indexedDB === 'undefined' || !indexedDB) throw new Error('IndexedDB 不可用');
      this._db = await new Promise((res, rej) => {
        let r;
        try { r = indexedDB.open(DB_NAME, 1); }
        catch (e) { rej(e); return; }
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return this._db;
    },
    async dbPut(rec) {
      const db = await this.db();
      return new Promise((res, rej) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(rec);
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    },
    async dbAll() {
      const db = await this.db();
      return new Promise((res, rej) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const q = tx.objectStore(DB_STORE).getAll();
        q.onsuccess = () => res(q.result || []);
        q.onerror = () => rej(q.error);
      });
    },
    async dbClear() {
      const db = await this.db();
      return new Promise((res, rej) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).clear();
        tx.oncomplete = res;
        tx.onerror = () => rej(tx.error);
      });
    },

    /* ---------- 曲库 ---------- */
    /**
     * 完整曲库 = 本机导入 + 播放过的在线曲目。
     *
     * 以前这里只返回 DEMO + 本地导入，而在线曲目只存在 onlineCache 里，
     * 结果：曲库页的「在线」筛选永远 0 首、没有本地文件时曲库永远是空的、
     * 播放页在空曲库下打开毫无反应、队列 sheet 也是空列表。
     * 现在把在线缓存一起并进来（它们都排在本地之后，不抢本地文件的位置）。
     */
    all() {
      const local = DEMO.concat(this.localTracks);
      const seen = new Set(local.map((t) => t.id));
      const online = this.cached().filter((t) => !seen.has(t.id));
      return local.concat(online);
    },
    /** 曾经播放过的在线曲目（无直链，播放时重新解析） */
    cached() {
      // 老版本存下的缓存没有 source 字段，这里补齐，避免恢复时判不出是在线曲目
      return (this.state.onlineCache || []).map((t) => (
        t.source === 'online' ? t : Object.assign({}, t, { source: 'online' })
      ));
    },
    byId(id) {
      return this.all().find((t) => t.id === id);
    },
    async restoreLocal() {
      try {
        const recs = await this.dbAll();
        this.localTracks = recs.map((r) => ({
          id: r.id, source: 'local', title: r.title, artist: r.artist, album: r.album,
          duration: r.duration || 0, cover: '', src: URL.createObjectURL(r.blob),
          format: (r.type || '').split('/')[1]?.toUpperCase() || 'AUDIO',
          sampleRate: '', size: r.size, addedAt: r.addedAt, _blob: r.blob,
        }));
      } catch (e) { this.localTracks = []; }
      return this.localTracks;
    },
    async addFiles(files) {
      const added = [];
      /*
       * 候选先筛出来，再并发探测时长。
       * 之前是 for + await 串行：每个无法解析元数据的文件都要等满 4 秒超时，
       * 导入 20 个不认识的格式就要 80 秒，期间界面只有一句「正在导入…」。
       */
      const cands = [];
      for (const f of files) {
        if (!/^audio\//.test(f.type) && !/\.(mp3|flac|m4a|wav|ogg|aac|opus)$/i.test(f.name)) continue;
        const id = 'loc_' + f.name + '_' + f.size + '_' + (f.lastModified || 0);
        if (this.localTracks.some((t) => t.id === id)) continue;
        const base = f.name.replace(/\.[^.]+$/, '');
        const dash = base.split(' - ');
        cands.push({
          f, id, base,
          title: dash.length > 1 ? dash[1].trim() : base,
          artist: dash.length > 1 ? dash[0].trim() : '本地文件',
        });
      }
      const durs = await Promise.all(cands.map((c) => this._probe(c.f)));
      for (let k = 0; k < cands.length; k++) {
        const c = cands[k];
        const f = c.f, id = c.id, dur = durs[k];
        const rec = {
          id, title: c.title, artist: c.artist, album: '本地导入', duration: dur, size: f.size,
          type: f.type, blob: f, addedAt: Date.now(),
        };
        try { await this.dbPut(rec); }
        catch (e) { this._volatile = true; }
        const track = {
          id, source: 'local', title: c.title, artist: c.artist, album: '本地导入', duration: dur,
          cover: '', src: URL.createObjectURL(f),
          format: (f.type.split('/')[1] || 'audio').toUpperCase(), sampleRate: '',
          size: f.size, addedAt: rec.addedAt, _blob: f,
        };
        this.localTracks.unshift(track);
        if (!this.state.imports.includes(id)) this.state.imports.push(id);
        added.push(track);
      }
      this.save();
      return added;
    },
    _probe(file) {
      return new Promise((res) => {
        const a = new Audio();
        const u = URL.createObjectURL(file);
        let done = false;
        const finish = (v) => { if (!done) { done = true; URL.revokeObjectURL(u); res(v); } };
        a.preload = 'metadata';
        a.onloadedmetadata = () => finish(isFinite(a.duration) ? Math.round(a.duration) : 0);
        a.onerror = () => finish(0);
        setTimeout(() => finish(0), 1500);
        a.src = u;
      });
    },
    async clearLocal() {
      await this.dbClear();
      /* 每个本地曲目的 src 都是 URL.createObjectURL(blob)，
         不 revoke 的话 blob 会一直挂在内存里（导入多张大专辑后很明显）。 */
      this.localTracks.forEach((t) => {
        try { if (t.src && /^blob:/.test(t.src)) URL.revokeObjectURL(t.src); } catch (e) {}
      });
      this.localTracks = [];
      this.state.imports = [];
      this.save();
    },

    /* ---------- 喜欢 / 记录 ---------- */
    isLiked(id) { return this.state.liked.includes(id); },
    toggleLike(id) {
      const a = this.state.liked;
      const i = a.indexOf(id);
      if (i >= 0) a.splice(i, 1); else a.push(id);
      this.save();
      return i < 0;
    },
    pushHistory(track) {
      const h = this.state.history;
      const last = h[0];
      if (!last || last.id !== track.id || Date.now() - last.at > 60000) {
        h.unshift({ id: track.id, title: track.title, artist: track.artist, at: Date.now() });
        if (h.length > 200) h.length = 200;
      }
    },
    addPlayed(sec) {
      this.state.playedSec += sec;
    },
    recent(n = 6) {
      const seen = new Set();
      const out = [];
      for (const h of this.state.history) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        const t = this.byId(h.id);
        if (t) out.push(t);
        if (out.length >= n) break;
      }
      return out;
    },
  };

  g.Store = Store;
  g.DEMO = DEMO;
  g.DEFAULTS = DEFAULTS;
})(window);
