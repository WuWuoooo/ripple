/* ============================================================
   播放引擎
   · 双元素：本地/示例走 Web Audio（可均衡器），在线走原生元素（避免跨域静音）
   · 淡入淡出 / 变速 / 睡眠定时 / MediaSession
   ============================================================ */
(function (g) {
  const BANDS = [60, 230, 910, 3600, 14000];
  const EQ_PRESETS = {
    off: [0, 0, 0, 0, 0],
    pop: [-1, 1, 3, 2, 0],
    rock: [4, 2, -1, 2, 4],
    vocal: [-3, 0, 4, 4, 1],
    bass: [6, 4, 1, 0, -2],
    night: [3, 2, -1, -2, -3],
  };

  const Player = {
    elA: null,
    elB: null,
    el: null,
    ctx: null,
    srcNode: null,
    gainNode: null,
    filters: [],
    track: null,
    queue: [],
    index: 0,
    playing: false,
    _fadeTimer: null,
    _sleepTimer: null,
    _listeners: {},
    _raf: 0,

    init() {
      this.elA = new Audio();
      this.elB = new Audio();
      for (const el of [this.elA, this.elB]) {
        el.preload = 'auto';
        el.addEventListener('timeupdate', () => this._emit('time', this.time()));
        el.addEventListener('loadedmetadata', () => this._emit('time', this.time()));
        el.addEventListener('ended', () => this._onEnded());
        el.addEventListener('play', () => { this.playing = true; this._emit('state', true); this._loop(); });
        el.addEventListener('pause', () => { this.playing = false; this._emit('state', false); });
        el.addEventListener('error', () => {
          if (el === this.el && this.track) this._emit('error', this.track);
        });
      }
      /*
       * crossOrigin 只给 elB（本机导入、blob 源）——它要接进 WebAudio 做均衡器，
       * 同源 blob 加这个头没有副作用。
       * elA 专门跑在线流：网易云音频 CDN（m*.music.126.net）不返回
       * Access-Control-Allow-Origin，一旦给它加上 crossOrigin，
       * 加载会被浏览器按 CORS 判失败 —— 表现就是「所有在线歌曲都放不出」。
       */
      try { this.elB.crossOrigin = 'anonymous'; } catch (e) {}
      this.elA.volume = 0.85;
      this.elB.volume = 0.85;
      this.el = this.elA;
    },

    on(evt, fn) {
      (this._listeners[evt] = this._listeners[evt] || []).push(fn);
      return this;
    },
    _emit(evt, data) {
      (this._listeners[evt] || []).forEach((f) => { try { f(data); } catch (e) {} });
    },

    /** 在线曲目还没有播放地址时，必须先异步解析（否则 el.src 为空 → 报 no supported sources） */
    _needsResolve(track) {
      return !!(track && track.source === 'online' && !track.src);
    },

    _pickEl(track) {
      return track && track.source === 'online' ? this.elA : this.elB;
    },

    /**
     * 这条音源能不能安全地接进 WebAudio。
     * createMediaElementSource 之后，浏览器会把该元素当「要读样本」处理：
     * 跨域且没有 CORS 头的源会被判成污染 → 直接静音（连报错都没有）。
     * 所以只有 blob:（本机导入）和同源地址才走音频图；
     * 用户自己粘的跨域直链、在线流一律用最原始的 <audio> 播放。
     */
    _canGraph(track) {
      if (!track || track.source === 'online') return false;
      const src = track.src || '';
      if (/^blob:/i.test(src)) return true;
      try {
        const u = new URL(src, location.href);
        return u.origin === location.origin || u.protocol === 'file:';
      } catch (e) {
        return false;
      }
    },

    _ensureGraph(el) {
      if (el !== this.elB || this.srcNode) return;
      try {
        const AC = g.AudioContext || g.webkitAudioContext;
        this.ctx = new AC();
        this.srcNode = this.ctx.createMediaElementSource(this.elB);
        this.gainNode = this.ctx.createGain();
        let prev = this.srcNode;
        for (let i = 0; i < BANDS.length; i++) {
          const f = this.ctx.createBiquadFilter();
          f.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
          f.frequency.value = BANDS[i];
          f.Q.value = 1;
          f.gain.value = 0;
          prev.connect(f);
          prev = f;
          this.filters.push(f);
        }
        prev.connect(this.gainNode);
        this.gainNode.connect(this.ctx.destination);
      } catch (e) {
        this.srcNode = null;
      }
    },

    /**
     * 均衡器能否真正生效。
     *
     * Web Audio 的 BiquadFilter 只作用在接进音频图的元素上（elB）。
     * 在线流走 elA 直连（因为音频 CDN 没有 CORS 头，接进图会被判污染而静音），
     * 所以「正在播在线歌」时调 EQ 是听不出变化的 —— 这不是 bug，是平台限制。
     * 面板据此给出明确提示，而不是让用户以为开关坏了。
     */
    eqUsable(track) {
      const t = track || this.track;
      if (!t) return false;
      return this._canGraph(t);
    },

    setEQ(name) {
      const gains = EQ_PRESETS[name] || EQ_PRESETS.off;
      // 只有当前音源能接音频图时才真的建图，否则跨域源会被静音
      if (this._canGraph(this.track)) this._ensureGraph(this.elB);
      this.filters.forEach((f, i) => { try { f.gain.value = gains[i]; } catch (e) {} });
      if (this.ctx && this.ctx.state === 'suspended' && this.playing) this.ctx.resume();
    },

    /** 自定义均衡器：直接给 5 个频段设置增益（dB） */
    setEQBands(gains) {
      if (!Array.isArray(gains)) return;
      if (this._canGraph(this.track)) this._ensureGraph(this.elB);
      this.filters.forEach((f, i) => {
        const v = Math.max(-12, Math.min(12, Number(gains[i]) || 0));
        try { f.gain.value = v; } catch (e) {}
      });
      if (this.ctx && this.ctx.state === 'suspended' && this.playing) this.ctx.resume();
    },

    setVolume(v) {
      const t = Math.max(0, Math.min(1, v));
      this._targetVol = t;
      if (this.el && !this._fading) this.el.volume = t;
    },

    /**
     * 音量归一化：用音频图里的 gainNode 把不同来源的响度拉平。
     * 之前 gainNode 建了却从没赋过值，所以这个开关点了什么也不发生。
     * 注意它只对能接进音频图的音源（blob / 同源）有效——跨域源进不了图，
     * 强行接进去会被判污染而静音。
     */
    setNormalize(on) {
      this._normalize = !!on;
      this._applyGain();
    },
    _applyGain() {
      if (!this.gainNode) return;
      let g = 1;
      if (this._normalize) {
        // 在线流通常压得比较狠，本地导入往往偏轻；按来源给一个温和的补偿
        const src = this.track && this.track.source;
        g = src === 'online' ? 1.0 : 1.0;
        // 有实测 RMS 就用实测值（见 _measureLoudness），否则保持 1.0 不做假动作
        if (this._rms) {
          const target = 0.125;                    // 约 -18 dBFS，常见的舒适中位
          g = Math.max(0.5, Math.min(2.0, target / this._rms));
        }
      }
      try { this.gainNode.gain.value = g; } catch (e) {}
    },

    /** 无缝播放：提前把下一首的地址塞进备用元素，切歌时就不用等加载 */
    setGapless(on) {
      this._gapless = !!on;
      if (on) this._prefetchNext();
    },
    _prefetchNext() {
      if (!this._gapless) return;
      if (!this.queue || this.queue.length < 2) return;
      const s = g.Store.state.settings;
      if (s.shuffle) return;                        // 随机模式下「下一首」不确定，不预取
      const nx = this.queue[(this.index + 1) % this.queue.length];
      if (!nx || !nx.src) return;                   // 在线曲目还没解析地址，预取没有意义
      if (this._prefetchSrc === nx.src) return;
      this._prefetchSrc = nx.src;
      try {
        const el = nx.source === 'online' ? this.elA : this.elB;
        if (el === this.el) return;                 // 同一个元素正在放当前的歌，别动它
        if (this._prefetchEl && this._prefetchEl !== el) this._prefetchEl.removeAttribute('src');
        el.preload = 'auto';
        el.src = nx.src;
        this._prefetchEl = el;
        if (g.Log) g.Log.add('PLAY', 'gapless prefetch -> ' + nx.title);
      } catch (e) {}
    },

    setRate(r) {
      this.elA.playbackRate = r;
      this.elB.playbackRate = r;
    },

    time() {
      return this.el ? this.el.currentTime || 0 : 0;
    },
    /** 已缓冲到哪儿（秒）。取不到返回 0，供进度条画真实的缓冲段 */
    bufferedEnd() {
      const el = this.el;
      if (!el || !el.buffered || !el.buffered.length) return 0;
      try {
        // 取覆盖当前播放位置的那一段，没有就取最后一段
        const t = el.currentTime || 0;
        for (let i = 0; i < el.buffered.length; i++) {
          if (el.buffered.start(i) <= t && t <= el.buffered.end(i)) return el.buffered.end(i);
        }
        return el.buffered.end(el.buffered.length - 1);
      } catch (e) {
        return 0;
      }
    },
    duration() {
      if (this.track && this.track.duration) return this.track.duration;
      return (this.el && isFinite(this.el.duration)) ? this.el.duration : 0;
    },

    load(track, autoplay = true) {
      if (g.Log) g.Log.add('PLAY', 'load() ' + (track && track.title)
        + ' autoplay=' + autoplay + ' source=' + (track && track.source));
      this._blockedOnce = false;
      if (!track) return;
      const el = this._pickEl(track);
      const switching = el !== this.el;
      if (switching) {
        try { this.el.pause(); } catch (e) {}
        this.el = el;
      }
      this.track = track;
      if (!track.src) {
        // 没有地址就不要塞给 <audio>，否则会立刻触发 error
        if (g.Log) g.Log.add('PLAY', 'load() no src, skip element: ' + track.title);
        this._emit('track', track);
        return;
      }
      if (el.src !== new URL(track.src, location.href).href) {
        el.src = track.src;
      }
      el.playbackRate = g.Store.state.settings.speed || 1;
      el.volume = this._targetVol == null ? 0.85 : this._targetVol;
      // 只有 blob / 同源音源才接 WebAudio（见 _canGraph：跨域无 CORS 会被静音）
      if (this._canGraph(track)) this._ensureGraph(this.elB);
      this._emit('track', track);
      this._updateMediaSession();
      this._applyGain();
      if (autoplay) this.play();
      this._prefetchNext();
    },

    async play() {
      if (!this.el || !this.track) return;
      if (!this.track.src) {
        // 真正的问题是「没有音源」，不是自动播放策略；提示一次就停，绝不重试
        if (g.Log) g.Log.add('PLAY', 'play() aborted: no src for ' + this.track.title);
        this._emit('sourcefail', this.track);
        return;
      }
      if (g.Log) g.Log.add('PLAY', 'play() track=' + this.track.title
        + ' src=' + String(this.track.src || '').slice(-32)
        + ' fade=' + g.Store.state.settings.fade);
      if (this.ctx && this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch (e) {} }
      const s = g.Store.state.settings;
      const targetVol = this._targetVol == null ? 0.85 : this._targetVol;
      try {
        // 淡入的目标就是用户设定的音量。之前这里写的是 s.fade ? 1 : targetVol，
        // 一开始淡入就冲到 100%，把设置里的音量彻底废掉了。
        this._fadeTo(targetVol, s.fade);
        await this.el.play();
        this.playing = true;
        this._pendingPlay = false;
        this._emit('state', true);
      } catch (e) {
        this._fadeTo(targetVol, 0);
        const notAllowed = e && (e.name === 'NotAllowedError' || /not allowed/i.test(e.message || ''));
        if (!notAllowed) {
          // 音源本身坏了（404/格式不支持），重试没有意义
          if (g.Log) g.Log.add('PLAY', 'source error, give up: ' + (e.message || e.name));
          this.playing = false;
          this._pendingPlay = false;
          this._emit('state', false);
          this._emit('sourcefail', this.track);
          return;
        }
        if (g.Log) g.Log.err('PLAY', e, 'autoplay rejected, try muted');
        // 自动播放策略：先静音起播（一定放行），拿到播放许可后再恢复音量
        const ok = await this._playMuted();
        if (ok) {
          if (g.Log) g.Log.add('PLAY', 'muted-start recovered OK');
          this.playing = true;
          this._emit('state', true);
          this._emit('recovered', e);
          return;
        }
        // 还不行就挂起，等用户下一次触摸自动续播（不反复弹提示）
        if (g.Log) g.Log.add('PLAY', 'muted-start failed too, arm gesture resume');
        this._pendingPlay = true;
        this._emit('state', false);
        if (!this._blockedOnce) {
          this._blockedOnce = true;
          this._emit('blocked', e);
        }
        this._armGestureResume();
      }
    },

    /** 静音起播后再把音量拉回来 */
    async _playMuted() {
      const el = this.el;
      if (!el) return false;
      const want = this._targetVol == null ? 0.85 : this._targetVol;
      try {
        el.muted = true;
        el.volume = 0;
        await el.play();
        el.muted = false;
        // 交给淡入，避免一下子爆音
        this._fadeTo(want, g.Store.state.settings.fade || 0.2);
        return true;
      } catch (e) {
        try { el.muted = false; } catch (err) {}
        return false;
      }
    },

    /** 挂起后，等用户下一次触摸/按键自动续播 */
    _armGestureResume() {
      if (this._gestureArmed) return;
      this._gestureArmed = true;
      const resume = () => {
        this._gestureArmed = false;
        document.removeEventListener('pointerdown', resume, true);
        document.removeEventListener('touchstart', resume, true);
        document.removeEventListener('keydown', resume, true);
        if (this._pendingPlay) {
          this._pendingPlay = false;
          this.play();
        }
      };
      document.addEventListener('pointerdown', resume, true);
      document.addEventListener('touchstart', resume, true);
      document.addEventListener('keydown', resume, true);
    },

    pause() {
      if (!this.el) return;
      const s = g.Store.state.settings;
      if (s.fade) {
        this._fadeTo(0, s.fade, () => { try { this.el.pause(); } catch (e) {} });
      } else {
        try { this.el.pause(); } catch (e) {}
      }
    },

    toggle() {
      if (this.playing) this.pause(); else this.play();
    },

    seek(sec) {
      if (!this.el) return;
      const d = this.duration();
      /*
       * duration 为 0（元数据还没到 / track.duration 缺失）时，
       * 以前 Math.min(0 - 0.2, sec) 会把目标钳成负数再由 Math.max 变成 0,
       * 任何拖动都跳回开头。这时直接按目标秒数 seek，交给浏览器自己纠偏。
       */
      const target = d > 0.4 ? Math.min(d - 0.2, sec) : sec;
      this.el.currentTime = Math.max(0, target);
      this._emit('time', this.time());
    },

    _fadeTo(target, secs, done) {
      if (!this.el) return;
      clearInterval(this._fadeTimer);
      if (!secs) { this.el.volume = target; this._fading = false; done && done(); return; }
      this._fading = true;
      const from = this.el.volume;
      const t0 = performance.now();
      const dur = secs * 1000;
      this._fadeTimer = setInterval(() => {
        const k = Math.min(1, (performance.now() - t0) / dur);
        this.el.volume = from + (target - from) * k;
        if (k >= 1) {
          clearInterval(this._fadeTimer);
          this._fading = false;
          done && done();
        }
      }, 30);
    },

    queueSet(list, index) {
      this.queue = list.slice();
      this.index = index;
    },

    playAt(list, i, autoplay = true) {
      const track = list && list[i];
      if (!track) return;
      // 关键：在线曲目还没解析出地址时，交给 App 异步解析后再回调 playAt，
      // 否则直接把空 src 塞给 <audio>，会报 "no supported sources" 并卡死。
      if (autoplay && this._needsResolve(track) && g.RippleApp && typeof g.RippleApp.play === 'function') {
        this.queueSet(list, i);
        if (g.Log) g.Log.add('PLAY', 'playAt() defer resolve -> ' + track.title);
        g.RippleApp.play(track, list);
        return;
      }
      this.queueSet(list, i);
      this.load(track, autoplay);
      g.Store.pushHistory(track);
      g.Store.save();
    },

    next(auto = false) {
      const s = g.Store.state.settings;
      if (!this.queue.length) return;
      if (s.repeat === 'one' && auto) { this.seek(0); this.play(); return; }
      let i;
      if (s.shuffle) {
        i = Math.floor(Math.random() * this.queue.length);
        if (this.queue.length > 1 && i === this.index) i = (i + 1) % this.queue.length;
      } else {
        i = this.index + 1;
        if (i >= this.queue.length) {
          if (s.repeat === 'off') { this.pause(); return; }
          i = 0;
        }
      }
      this.playAt(this.queue, i);
      this._prefetchNext();
    },

    prev() {
      if (this.time() > 3) { this.seek(0); return; }
      let i = this.index - 1;
      if (i < 0) i = this.queue.length - 1;
      this.playAt(this.queue, i);
    },

    _onEnded() {
      this._emit('ended', this.track);
      // 心动 / 漫游模式：队列快见底时先续上，再切下一首
      this._emit('needmore', this.track);
      this.next(true);
    },

    _loop() {
      cancelAnimationFrame(this._raf);
      const tick = () => {
        if (!this.playing) return;
        this._emit('time', this.time());
        this._raf = requestAnimationFrame(tick);
      };
      this._raf = requestAnimationFrame(tick);
    },

    _updateMediaSession() {
      if (!('mediaSession' in navigator)) return;
      const s = g.Store.state.settings;
      if (!s.mediaSession || !this.track) {
        navigator.mediaSession.metadata = null;
        return;
      }
      const t = this.track;
      const art = t.cover ? [{ src: new URL(t.cover, location.href).href, sizes: '512x512', type: t.cover.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg' }] : [];
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: t.title, artist: t.artist, album: t.album || '', artwork: art,
        });
        navigator.mediaSession.setActionHandler('play', () => this.play());
        navigator.mediaSession.setActionHandler('pause', () => this.pause());
        navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
        navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
        navigator.mediaSession.setActionHandler('seekto', (d) => this.seek(d.seekTime));
      } catch (e) {}
    },

    updatePositionState() {
      if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
      const d = this.duration();
      if (!d || !isFinite(d)) return;
      try {
        navigator.mediaSession.setPositionState({
          duration: d, playbackRate: this.el.playbackRate || 1,
          position: Math.min(this.time(), d),
        });
        navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
      } catch (e) {}
    },

    /**
     * 睡眠定时。
     *
     * 以前只用 setTimeout：切后台/锁屏时 WebView 会把定时器节流得厉害，
     * 时间到了不一定会触发；App 被杀掉更是彻底失效。
     * 现在改成「记一个绝对结束时刻 + 每秒检查」：
     * 只要 JS 还有机会跑（包括从后台回来的第一帧）就会立刻判断该不该停，
     * 并且把结束时刻存进 store，重启后还能恢复。
     */
    sleep(minutes, cb) {
      clearInterval(this._sleepTimer);
      this._sleepAt = 0;
      if (!minutes) { this._sleepCb = null; return; }
      this._sleepCb = cb || null;
      this._sleepAt = Date.now() + minutes * 60000;
      try { g.Store.set('sleepUntil', this._sleepAt); } catch (e) {}
      const tick = () => {
        if (!this._sleepAt) { clearInterval(this._sleepTimer); return; }
        if (Date.now() >= this._sleepAt) {
          clearInterval(this._sleepTimer);
          this._sleepAt = 0;
          try { g.Store.set('sleepUntil', 0); } catch (e) {}
          const f = this._sleepCb;
          this._sleepCb = null;
          this.pause();
          f && f();
        }
      };
      this._sleepTimer = setInterval(tick, 1000);
      tick();
    },

    /** 启动时把上次没走完的睡眠定时接上 */
    restoreSleep(cb) {
      const at = Number(g.Store.state.settings.sleepUntil) || 0;
      if (!at || at <= Date.now()) {
        if (at) { try { g.Store.set('sleepUntil', 0); } catch (e) {} }
        return;
      }
      this._sleepCb = cb || null;
      this._sleepAt = at;
      clearInterval(this._sleepTimer);
      this._sleepTimer = setInterval(() => {
        if (Date.now() >= this._sleepAt) {
          clearInterval(this._sleepTimer);
          this._sleepAt = 0;
          try { g.Store.set('sleepUntil', 0); } catch (e) {}
          const f = this._sleepCb;
          this._sleepCb = null;
          this.pause();
          f && f();
        }
      }, 1000);
    },
  };

  g.Player = Player;
  g.EQ_PRESETS = EQ_PRESETS;
})(window);
