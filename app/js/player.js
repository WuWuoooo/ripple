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
    analyser: null,       // 归一化用的采样分析节点（串在 gain 之后）
    _rms: 0,              // 实测 RMS（归一化用；0 = 还没测到）
    _rmsBuf: null,
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
      /*
       * B-4：elC 专供「从链接添加」的第三方音频直链。
       * 这类地址不返回 Access-Control-Allow-Origin，而 elB 带 crossOrigin='anonymous'
       * （为了接 WebAudio 做均衡器），于是媒体加载会被按 CORS 判失败 ——
       * 表现是「点了只报音源已失效」，其实根本不是失效。
       * elC 不设 crossOrigin，也不接 WebAudio（均衡器对它自动不生效）。
       */
      this.elC = new Audio();
      for (const el of [this.elA, this.elB, this.elC]) {
        el.preload = 'auto';
        /*
         * ⚠️ 所有回调都必须校验「事件来自当前元素」。
         *
         * 三个 <audio> 里始终只有一个是 this.el，另外两个可能在预取/被切走。
         * 以前 waiting/stalled/playing/canplay 写了 `if (el !== this.el) return`，
         * 而 timeupdate / loadedmetadata / ended / play / pause **没写** ——
         * 于是：
         *   · 预取元素播完触发 ended → _onEnded → next(true)，
         *     把用户正在听的歌切走
         *   · 被切走的元素 pause 事件把 UI 状态闪成"暂停"
         *   · timeupdate 用错元素的进度刷新进度条
         * 同一文件两套写法，明显是漏了。
         */
        el.addEventListener('timeupdate', () => { if (el !== this.el) return; this._emit('time', this.time()); });
        el.addEventListener('loadedmetadata', () => { if (el !== this.el) return; this._emit('time', this.time()); });
        el.addEventListener('ended', () => { if (el !== this.el) return; this._onEnded(); });
        el.addEventListener('play', () => {
          if (el !== this.el) return;
          this.playing = true; this._emit('state', true); this._loop();
        });
        el.addEventListener('pause', () => {
          if (el !== this.el) return;
          this.playing = false; this._emit('state', false);
        });
        el.addEventListener('error', () => {
          if (el === this.el && this.track) this._emit('error', this.track);
        });
        /*
         * 审查 3.2：waiting / stalled 以前完全没监听 ——
         * 用户看到进度条卡住，分不清是在缓冲还是死了。
         * 现在统一成一个 buffering 事件，UI 拿它做「缓冲中」的提示。
         */
        el.addEventListener('waiting', () => {
          if (el !== this.el) return;
          this.buffering = true;
          this._emit('buffering', true);
        });
        el.addEventListener('stalled', () => {
          if (el !== this.el) return;
          this.buffering = true;
          this._emit('buffering', true);
        });
        ['playing', 'canplay', 'canplaythrough'].forEach((ev) => {
          el.addEventListener(ev, () => {
            if (el !== this.el) return;
            if (!this.buffering) return;
            this.buffering = false;
            this._emit('buffering', false);
          });
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
      this.elC.volume = 0.85;
      this.el = this.elA;
      this.buffering = false;
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
      /*
       * 判定顺序很关键：remoteUrl（跨域直链）必须**先于** source==='online'。
       *
       * 「从链接添加」的曲目是用户自己加进来的本地曲目（source:'local'），
       * 音频在第三方直链上、不返回 CORS 头，所以首播时走 elC（不带 crossOrigin）。
       * 以前这条判定排在 source==='online' 之后，一旦某条记录被还原成
       * source:'online'（历史上的 restoreLocal 就是这么写的），首发走 elC、
       * 重启恢复后走 elA —— 同一首歌的播放元素路由自相矛盾，
       * 第三方直链不返 CORS 头时 elA 会静音或判音源失效。
       * 现在无论 source 是什么，只要带 remoteUrl 就一定走 elC，
       * 保证「首次播放」和「重启恢复」走同一个元素。
       */
      if (track && (track.remoteUrl || track.crossOrigin === false)) return this.elC;
      if (track && track.source === 'online') return this.elA;
      return this.elB;
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
      /* 建图失败过一次就别再试：同一个元素第二次 createMediaElementSource
         必然抛 InvalidStateError，重试只会制造噪音日志和反复失败的假象。 */
      if (this._graphBroken) return;
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
        /*
         * 审查 3.3：归一化必须在**增益之前**取样。
         * 以前图是 filters → gain → analyser → 输出，测到的是被增益放大后的信号，
         * 于是实际增益变成 √(target/rms) 而不是 target/rms —— 响度拉不平，
         * 还会出现「音量呼吸」一样的来回摆。
         * 现在改成 filters → analyser → gain → 输出，分析器仍串在链路里，
         * 只是取样点挪到了增益之前。
         * 万一内核不支持 createAnalyser，就退回直连——归一化失效但不影响播放。
         */
        try {
          this.analyser = this.ctx.createAnalyser();
          this.analyser.fftSize = 2048;
          this._rmsBuf = (typeof this.analyser.getFloatTimeDomainData === 'function')
            ? new Float32Array(this.analyser.fftSize)
            : new Uint8Array(this.analyser.fftSize);
          prev.connect(this.analyser);        // 增益之前取样
          this.analyser.connect(this.gainNode);
          this.gainNode.connect(this.ctx.destination);
        } catch (e2) {
          this.analyser = null;
          this._rmsBuf = null;
          prev.connect(this.gainNode);
          this.gainNode.connect(this.ctx.destination);
        }
      } catch (e) {
        /*
         * 半成功是最糟的状态：createMediaElementSource(elB) 一旦成功，
         * elB 的输出就已经被**接管**了 —— 它不再自动连到扬声器。
         * 此时如果后续建节点/连接抛错，只在 catch 里把 srcNode 置空，
         * 真实后果是：elB 永久无声，而 EQ/归一化 UI 还显示"已启用"。
         * 更糟的是下次 _ensureGraph 见 srcNode 为空，又会 new AudioContext +
         * 再次 createMediaElementSource(elB)，此时 Chrome 抛 InvalidStateError
         * （一个元素只能被接管一次），catch 后继续无声 —— 死循环。
         *
         * 正确收尾：关掉 ctx，并把元素直连回 destination 恢复出声；
         * 如果连直连都做不到，就记下"不可恢复"标记，让 UI 说真话，
         * 而不是反复重建、反复失败。
         */
        try {
          if (this.srcNode && this.ctx) this.srcNode.connect(this.ctx.destination);
        } catch (e2) {}
        try { if (this.ctx && this.ctx.state !== 'closed') this.ctx.close(); } catch (e2) {}
        this.srcNode = null;
        this.ctx = null;
        this.gainNode = null;
        this.analyser = null;
        this._rmsBuf = null;
        this.filters = [];
        /* 记住"这个进程内已经建图失败过"，不要再无限重试 */
        this._graphBroken = true;
        try { if (g.Log) g.Log.err('EQ', e, '音频图建立失败，已回退直连（均衡器不可用）'); } catch (e2) {}
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

    /** B-6：把当前设置里的 EQ 重新下发到滤波器（建图之后必须补一次） */
    _reapplyEQ() {
      try {
        const s = g.Store.state.settings;
        if (s.eq === 'custom' && Array.isArray(s.eqCustom)) this.applyBandsToFilters(s.eqCustom);
        else this.applyBandsToFilters(EQ_PRESETS[s.eq] || EQ_PRESETS.off);
      } catch (e) {}
    },

    applyBandsToFilters(gains) {
      this.filters.forEach((f, i) => { try { f.gain.value = gains[i] || 0; } catch (e) {} });
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
     *
     * 这里的增益**来自实测**：AnalyserNode 每 0.5 秒取一段时域样本算 RMS，
     * 再做指数平滑，最后把 target/RMS 钳在 0.5~2.0 之间应用到 gainNode。
     * 之前 gainNode 建了却从没赋过值（`_rms` 只有读没有写），开关点了什么也不发生。
     *
     * 边界（诚实说明，不是 bug）：只有能接进音频图的音源才有效果。
     * 在线流走 elA 直连（CDN 无 CORS 头，接进图会被判污染而静音），
     * 所以播在线歌曲时归一化不生效 —— 界面用 normalizeUsable() 明确标注。
     */
    setNormalize(on) {
      this._normalize = !!on;
      if (!this._normalize) this._rms = 0;
      this._applyGain();
    },
    /** 归一化对当前音源是否真的有效（和 eqUsable 同一套判据） */
    normalizeUsable(track) {
      return this._canGraph(track || this.track);
    },
    /** 从时域样本实测 RMS（0..1 的均方根），平滑后写进 this._rms */
    _measureLoudness() {
      const an = this.analyser;
      if (!an || !this._rmsBuf) return;
      const buf = this._rmsBuf;
      try {
        if (typeof an.getFloatTimeDomainData === 'function' && buf instanceof Float32Array) {
          an.getFloatTimeDomainData(buf);
        } else if (typeof an.getByteTimeDomainData === 'function' && buf instanceof Uint8Array) {
          an.getByteTimeDomainData(buf);
        } else {
          return;
        }
      } catch (e) {
        return;
      }
      let sum = 0;
      let n = buf.length;
      const byte = buf instanceof Uint8Array;
      for (let i = 0; i < n; i++) {
        // 字节样本以 128 为中心（0..255），先归一化到 -1..1
        const v = byte ? (buf[i] - 128) / 128 : buf[i];
        sum += v * v;
      }
      const rms = Math.sqrt(sum / (n || 1));
      if (!isFinite(rms) || rms <= 0) return;              // 静音/未开播，别把增益推到最大
      // 指数平滑：单帧采样抖动很大，平滑后才不会出现「呼吸式」音量起伏
      this._rms = this._rms ? this._rms * 0.75 + rms * 0.25 : rms;
      this._applyGain();
    },
    _applyGain() {
      if (!this.gainNode) return;
      let g = 1;
      if (this._normalize && this._rms && this.analyser) {
        const target = 0.125;                              // 约 -18 dBFS，常见的舒适中位
        g = Math.max(0.5, Math.min(2.0, target / this._rms));
      }
      this._appliedGain = g;
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
      try {
        const el = this._pickEl(nx);   // 和 load() 用同一套路由（含 B-4 的 elC）
        if (el === this.el) return;                 // 同一个元素正在放当前的歌，别动它
        /*
         * B-3：清空上一个预取元素之前，必须确认它不是「正在播放的那一个」。
         * 旧代码只保护了要写入的 el，没保护要被清空的 _prefetchEl：
         * 队列 [在线 O1, 本地 L2, 在线 O3] 切到 L2 时，_prefetchEl 仍然是 elB，
         * 而 elB 此刻正在播 L2 —— removeAttribute('src') 直接把正在听的歌切断。
         * 修法：遇到「受害者在播」就跳过清空这一步（不腾位置也不影响写入目标元素），
         * 预取照常进行 —— 只删掉那一句破坏性的调用，而不是放弃整个预取。
         */
        if (this._prefetchEl && this._prefetchEl !== el && this._prefetchEl !== this.el) {
          this._prefetchEl.removeAttribute('src');
        }
        this._prefetchSrc = nx.src;
        el.preload = 'auto';
        el.src = nx.src;
        this._prefetchEl = el;
        if (g.Log) g.Log.add('PLAY', 'gapless prefetch -> ' + nx.title);
      } catch (e) {}
    },

    /**
     * 设置播放速度。
     *
     * 以前只写 elA / elB 两个元素，漏了**当前正在播放的 el**
     * —— 而 _pickEl() 可能会路由到 elC（跨域直链那一个）。
     * 于是设置面板里拖速度，界面上数字变了，正在放的这首却毫无变化，
     * 要切一首歌才生效（因为 load() 会重新读 settings.speed）。
     */
    setRate(r) {
      const v = Number(r) || 1;
      this.elA.playbackRate = v;
      this.elB.playbackRate = v;
      if (this.elC) this.elC.playbackRate = v;
      /* 当前在播的那个元素单独再写一次：它可能是 elC，也可能与上面重复，写两次无害 */
      if (this.el) {
        try { this.el.playbackRate = v; } catch (e) {}
      }
      /* 同步进设置，保证「切歌后仍然保持这个速度」（load() 读的就是它） */
      try {
        if (g.Store && g.Store.state && g.Store.state.settings) {
          g.Store.state.settings.speed = v;
        }
      } catch (e) {}
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
      /*
       * 第二参数同时接受布尔和 `{autoplay}` 对象。
       *
       * 原因：冷启动恢复上次曲目时传的是 `Player.load(t, {autoplay:false})`，
       * 而对象恒为真 —— `if (autoplay)` 必然起播。冷启动没有用户手势，
       * WebView 拒播后落到 _playMuted，表现为「进度条在走但没有声音」，
       * 正是那种「看起来坏了」的体验。调用点在 app.js 里、且这层签名
       * 已经不止一处历史用法，所以在这里收口归一化，而不是指望每个
       * 调用点都记得传布尔。新增调用请直接传 true/false。
       */
      if (autoplay && typeof autoplay === 'object') autoplay = autoplay.autoplay !== false;
      if (g.Log) g.Log.add('PLAY', 'load() ' + (track && track.title)
        + ' autoplay=' + autoplay + ' source=' + (track && track.source));
      this._blockedOnce = false;
      if (!track) return;
      /*
       * 先校验地址再改任何状态。
       *
       * 旧顺序是：this.track = track → new URL(track.src) → el.src = ...
       * 用户从「我的 → 从链接添加」粘贴一个 `http://` 这类非法串时，
       * new URL() 抛 TypeError，而此时 this.track 已经换成了新歌、
       * el.src 还是旧 blob、_emit('track') 也没执行 ——
       * 内部状态说"在播新歌"，实际还在放上一首，点哪都没反应。
       * 现在把校验提到最前面，非法就发 error 事件并原地不动。
       */
      let resolved = '';
      try {
        resolved = new URL(track.src || '', location.href).href;
      } catch (e) {
        if (g.Log) g.Log.err('PLAY', e, 'load() 非法音源地址: ' + (track && track.src));
        this._emit('error', track);
        return;
      }
      const el = this._pickEl(track);
      const switching = el !== this.el;
      if (switching) {
        /* B-5：切歌前把在飞的淡入淡出停掉，否则它会继续往新元素写音量 */
        clearInterval(this._fadeTimer);
        this._fading = false;
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
      if (el.src !== resolved) {
        el.src = track.src;
      }
      el.playbackRate = g.Store.state.settings.speed || 1;
      el.volume = this._targetVol == null ? 0.85 : this._targetVol;
      // 只有 blob / 同源音源才接 WebAudio（见 _canGraph：跨域无 CORS 会被静音）
      if (this._canGraph(track)) {
        this._ensureGraph(this.elB);
        /* B-6：建图时每个滤波器增益都是 0，而 EQ 从不在 track 变化时重新下发，
           所以「启动后播放的第一首本地歌」永远听不到用户选的预设，
           设置页却显示已启用。这里建图之后立刻补一次。 */
        this._reapplyEQ();
      }
      this._emit('track', track);
      this._updateMediaSession();
      // 换歌后旧歌的 RMS 不再有效，清掉重新实测（第一帧测量前保持 1.0 不做假动作）
      this._rms = 0;
      this._rmsAt = 0;
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
      /*
       * 有限性校验：MediaSession 的 seekto 回调可能不带 seekTime
       * （或带 NaN），而 `currentTime = NaN` 会抛
       * TypeError: The provided double value is non-finite。
       * 这属于"未处理异常路径"，一旦抛出来整个回调就断了。
       */
      const n = Number(sec);
      if (!isFinite(n)) return;
      const d = this.duration();
      /*
       * duration 为 0（元数据还没到 / track.duration 缺失）时，
       * 以前 Math.min(0 - 0.2, sec) 会把目标钳成负数再由 Math.max 变成 0,
       * 任何拖动都跳回开头。这时直接按目标秒数 seek，交给浏览器自己纠偏。
       */
      const target = d > 0.4 ? Math.min(d - 0.2, n) : n;
      const next = Math.max(0, target);
      if (!isFinite(next)) return;
      this.el.currentTime = next;
      this._emit('time', this.time());
    },

    /*
     * B-5：淡入淡出必须锁定「发起时的那一个元素」。
     * 原来的实现全程读 this.el，而 this.el 会在 load() 里被换成另一个元素：
     *   · 暂停后 0.4s 内点下一首 → 淡出回调 pause() 的是刚切过去的新歌
     *   · 淡入期间切歌 → 旧曲线继续往新元素写音量 → 新歌先没声音再突然跳正常
     * 现在锁住 el，并在发现 el 已经不是当前元素时直接放弃。
     */
    _fadeTo(target, secs, done) {
      const el = this.el;
      if (!el) return;
      clearInterval(this._fadeTimer);
      if (!secs) { el.volume = target; this._fading = false; done && done(); return; }
      this._fading = true;
      const from = el.volume;
      const t0 = performance.now();
      const dur = secs * 1000;
      /*
       * 目标值是"活"的，不是常量。
       *
       * 以前 target 在调用那一刻就被固定住了，而 setVolume() 在淡入淡出期间
       * 只更新 this._targetVol、不写元素（等曲线走完再接管）。于是：
       *   音量 0 起播 → 淡入曲线目标 = 0.85 →
       *   60ms 时用户把滑块拖到 0.3 → 只改了 _targetVol →
       *   500ms 曲线走完写回 0.85，滑块却停在 30%
       * 用户看到的是"拖了没反应/松手后音量跳回去"。
       *
       * 现在每帧都读 this._targetVol：如果用户在曲线期间改过音量，
       * 曲线就直接朝新目标走（并从当前位置续算），不再把它吃掉。
       * _fadeTarget 记的是"发起时的目标"，用来判断有没有被改过。
       */
      this._fadeTarget = target;
      let cur = target;
      let from2 = from;      // 当前这一段的起点音量
      let t0b = t0;          // 当前这一段的起点时刻
      const tick = () => {
        if (el !== this.el) {              // 已经切歌：这条曲线作废
          clearInterval(this._fadeTimer);
          this._fading = false;
          return;
        }
        /* 期间用户改了音量：换成新目标，并把曲线起点重置到"当前音量" */
        const live = (this._targetVol == null) ? cur : this._targetVol;
        if (Math.abs(live - cur) > 1e-4) {
          cur = live;
          from2 = el.volume;
          t0b = performance.now();
        }
        const k = Math.min(1, (performance.now() - t0b) / dur);
        el.volume = Math.max(0, Math.min(1, from2 + (cur - from2) * k));
        if (k >= 1) {
          clearInterval(this._fadeTimer);
          this._fading = false;
          done && done();
        }
      };
      this._fadeTimer = setInterval(tick, 30);
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
      /*
       * 第 17 条：漫游模式「播到列表末尾自动续加」。
       * 以前只在 _onEnded（一首歌自然播完）时才 emit needmore，
       * 所以手动点下一首、或直接播到最后一首时不会续队列；
       * 而且续队列是异步的，等它回来时 next() 早就按旧队列到头、pause 了。
       * 这里改成「每次切歌都通知一次」——App 那边只在漫游/心动且剩余 <= 3 首时才动，
       * 于是进入最后一首的瞬间就会开始续，等下歌时队列已经变长了。
       */
      this._emit('needmore', track);
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
      // L-20：空队列时 index 会算成 -1，playAt(queue, -1) 静默无操作 —— 死按钮
      if (!this.queue || !this.queue.length) return;
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
        /*
         * 重要：这里以前每个动画帧（≈60 次/秒）都 emit('time')，
         * 而 'time' 的监听者会写进度条宽度、旋钮位置、两个时间文本，
         * 再跑一遍歌词二分/线性扫描 —— 秒级精度根本不需要 60Hz，
         * 白白制造了每秒几百次样式写入与重排，是「只有 30 帧」的主要嫌疑之一。
         * 现在限到 10Hz（100ms），进度条依然顺滑，DOM 写入少了 6 倍。
         */
        const now = performance.now();
        if (now - (this._timeAt || 0) >= 100) {
          this._timeAt = now;
          this._emit('time', this.time());
        }
        // 归一化：每 500ms 实测一次 RMS 并更新增益（同一帧循环里限频，不另开定时器）
        if (this._normalize && this.analyser) {
          if (now - (this._rmsAt || 0) > 500) { this._rmsAt = now; this._measureLoudness(); }
        }
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
      /*
       * 以前 duration 没就绪（0 / NaN）时直接 return ——
       * 而锁屏和通知栏的进度条只在 setPositionState 被调用后才显示，
       * 于是一首还在加载元数据的歌会在通知栏上**永远停在 0**，
       * 用户以为播放卡住了。
       *
       * 现在没拿到 duration 时用一个「至少 1 秒」的占位，把 position 也钳住，
       * 让系统能画出「刚开始播」的样子；duration 一就绪就自动恢复正常值。
       */
      if (!d || !isFinite(d) || d <= 0) {
        try {
          const pos = Math.max(0, this.time());
          navigator.mediaSession.setPositionState({
            duration: Math.max(pos + 1, 1),
            playbackRate: this.el.playbackRate || 1,
            position: Math.min(pos, Math.max(pos + 1, 1)),
          });
          navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
        } catch (e) {}
        return;
      }
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
      if (!minutes) {
        /*
         * F-2：取消睡眠定时必须把持久化的结束时刻一起清掉。
         * 旧代码在这里直接 return，Store 里的 sleepUntil 仍是旧值，
         * 下次启动 restoreSleep() 读到它就又把定时器复活了 ——
         * 界面显示「关闭」，到点却照样暂停。
         */
        this._sleepCb = null;
        try { g.Store.set('sleepUntil', 0); } catch (e) {}
        try { g.Store.set('sleepMin', 0); } catch (e) {}
        return;
      }
      this._sleepCb = cb || null;
      this._sleepAt = Date.now() + minutes * 60000;
      /*
       * 两个字段一起落盘：sleepUntil 给 restoreSleep 用，sleepMin 给界面显示用。
       * 只写 sleepUntil 时，重启后定时器其实还在跑，但设置页那行显示"关闭"——
       * UI 与运行状态对不上（E-27 的另一半）。
       */
      try { g.Store.set('sleepUntil', this._sleepAt); } catch (e) {}
      try { g.Store.set('sleepMin', minutes); } catch (e) {}
      const tick = () => {
        if (!this._sleepAt) { clearInterval(this._sleepTimer); return; }
        if (Date.now() >= this._sleepAt) {
          clearInterval(this._sleepTimer);
          this._sleepAt = 0;
          /*
           * 触发后必须把 sleepMin 归零，否则设置页一直显示
           * 「60 分钟后暂停」，而定时器早就结束了。
           */
          try { g.Store.set('sleepUntil', 0); } catch (e) {}
          try { g.Store.set('sleepMin', 0); } catch (e) {}
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
        /* 已经过期/不存在：两个字段都清干净，别留一个说开一个说关 */
        if (at) { try { g.Store.set('sleepUntil', 0); } catch (e) {} }
        if (Number(g.Store.state.settings.sleepMin)) {
          try { g.Store.set('sleepMin', 0); } catch (e) {}
        }
        return;
      }
      this._sleepCb = cb || null;
      this._sleepAt = at;
      /*
       * 剩余时间换算回"分钟"，让设置页显示的数字是真实的剩余量，
       * 而不是启动前那个 60。
       */
      try {
        const left = Math.max(1, Math.round((at - Date.now()) / 60000));
        g.Store.set('sleepMin', left);
      } catch (e) {}
      clearInterval(this._sleepTimer);
      this._sleepTimer = setInterval(() => {
        if (Date.now() >= this._sleepAt) {
          clearInterval(this._sleepTimer);
          this._sleepAt = 0;
          try { g.Store.set('sleepUntil', 0); } catch (e) {}
          try { g.Store.set('sleepMin', 0); } catch (e) {}
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
