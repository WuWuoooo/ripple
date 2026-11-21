/* ============================================================
   网易云客户端（真接口）
   · APK 内：window.RippleNative.netease(cmd, params, cbId)
     —— Java 侧做 weapi 加密 + 带登录 cookie，和 Enji 走同一套协议
   · 浏览器内：POST 到本地 server.js 的 /ncm/<cmd>
     —— server.js 同样实现 weapi，行为一致
   老接口（/api/search/get 明文）已不再使用。
   ============================================================ */
(function (g) {
  const LEVELS = ['standard', 'higher', 'exhigh', 'lossless', 'hires'];
  const _pending = new Map();
  /* 审查 3.1：在飞请求去重表（key = 命令+参数签名，value = Promise） */
  const _inflight = new Map();
  let _seq = 0;

  /* ---- 原生回调入口（Java → JS） ---- */
  g.__rippleNativeResult = function (id, text) {
    const done = _pending.get(id);
    if (!done) {
      /*
       * 无主回调：JS 侧已经超时（pending 被删）之后，Java 才把结果送回来。
       * 这类迟到结果的典型场景就是扫码登录 —— 用户在 180 秒末尾扫码成功，
       * Java 侧正常写完 cookie 并回调，而这里直接 return，用户看到的
       * 最后一条信息是「登录超时」。以前这里连日志都没有，排查时完全
       * 看不出「其实成功了，只是没人接」。
       * 记一条日志而不是抛错：回调入口在原生桥的调用栈里，抛错会污染
       * Java 侧的返回流程，而这个事实只需要可查。
       */
      try {
        if (g.Log) g.Log.add('API', '收到无主回调（可能已超时）: ' + id);
      } catch (e) {}
      return;
    }
    _pending.delete(id);
    done(text);
  };

  /*
   * H-8：超时按命令给，不能一刀切 22 秒。
   *
   * 背景：Java 侧 connect 12s + read 18s，单次请求最坏 30 秒；
   * 而 `status` 在原生里是 **4 次串行请求**（profile / vip / level / like）。
   * 于是网络稍差时 `status` 必然撞上 22 秒的 JS 超时，
   * refreshAccount() 又把错误吞掉 → 账号卡片误显示「未登录网易云」，
   * 用户明明登录着却看到没登录。
   *
   * 现在按命令的可预期耗时给预算：串行越多给得越宽。
   * 单请求的（song_url / search 等）反而可以收紧，让失败更快反馈。
   *
   * 覆盖范围要跟着「失败代价」走，不能只挑几个写死：走默认 22 秒的命令一旦
   * 比默认值慢，用户就会看到一次假的「请求超时」，而这类失败又常常被上层
   * 吞掉（静默变成空列表 / 空面板），现场只留下「点开什么都没发生」。
   * 所以凡是耗时明显不同于单请求的命令都单独列出来，理由写在行尾。
   */
  const CALL_TIMEOUT = {
    status: 60000,        // 4 次串行
    login: 45000,
    playlist: 30000,      // 歌单详情连 tracks 一起取，体积大
    playlist_tracks: 30000,
    heart_mode: 30000,    // 服务端要按口味现算一遍推荐，比普通读慢
    comments: 25000,
    song_url: 25000,
    song_detail: 22000,
    search: 20000,
    lyric: 18000,
    hot_search: 15000,
    comment_add: 15000,   // 写操作：失败要尽快反馈，别让「正在发表…」一直转
  };
  const DEFAULT_TIMEOUT = 22000;
  function timeoutOf(cmd) {
    return CALL_TIMEOUT[cmd] || DEFAULT_TIMEOUT;
  }

  function nativeCall(cmd, params) {
    const N = g.RippleNative;
    return new Promise((res, rej) => {
      const id = 'n' + (++_seq);
      const timer = setTimeout(() => {
        _pending.delete(id);
        rej(new Error('请求超时（' + cmd + '）'));
      }, timeoutOf(cmd));
      _pending.set(id, (text) => { clearTimeout(timer); res(text); });
      try {
        N.netease(cmd, JSON.stringify(params || {}), id);
      } catch (e) {
        clearTimeout(timer);
        _pending.delete(id);
        rej(e);
      }
    });
  }

  /*
   * server.js 的 /ncm/ 需要 X-Ripple-Token（同源托管时由服务端注入 index.html）。
   * 拿不到 token 时不带这个头 —— 老版本服务端不认识它，照样能用；
   * 新版本服务端会返回 401，这里再给出可读的提示。
   */
  function proxyCall(cmd, params) {
    return new Promise((res, rej) => {
      const t0 = Date.now();
      const headers = { 'Content-Type': 'application/json' };
      const tk = g.RIPPLE_TOKEN;
      if (tk) headers['X-Ripple-Token'] = tk;
      /* 浏览器模式下接口偶尔挂住会让 UI 一直停在「搜索中…」，加个超时 */
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      /* H-8：与原生侧同一套预算，避免两边不一致导致「一边超时一边还在跑」 */
      const timer = ac ? setTimeout(() => ac.abort(), timeoutOf(cmd)) : 0;
      fetch((Netease.base || '') + '/ncm/' + cmd, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(params || {}),
        signal: ac ? ac.signal : undefined,
      })
        .then((r) => {
          clearTimeout(timer);
          if (r.ok) return r.text();
          if (r.status === 401) throw new Error('接口需要令牌（请用最新 server.js 打开本页）');
          throw new Error('HTTP ' + r.status);
        })
        .then((t) => { clearTimeout(timer); res(t); })
        .catch((e) => {
          clearTimeout(timer);
          /*
           * 离线与「服务端不可达」要能区分开。
           *
           * 浏览器模式下 fetch 失败一律是 TypeError: Failed to fetch ——
           * 断网、server.js 没起、地址填错，三者提示完全一样，用户只能瞎猜。
           * navigator.onLine === false 时直接说是离线：这不是「接口坏了」，
           * 提示的措辞要把用户往「检查网络」而不是「重装 server.js」上带。
           * 注意 onLine 只有明确的 false 才可信（true 也可能实际上不通），
           * 所以只用于离线这一支，其余仍按原样报错。
           */
          const offline = g.navigator && g.navigator.onLine === false;
          const reason = e && e.name === 'AbortError' ? '接口超时' : (offline ? '当前处于离线状态' : e.message);
          rej(new Error(reason + ' · ' + (Date.now() - t0) + 'ms'));
        });
    });
  }

  function cover(url, size) {
    if (!url) return '';
    let u = url.replace(/^http:/, 'https:');
    if (u.includes('126.net')) {
      u = u.split('?')[0] + '?param=' + (size || 500) + 'y' + (size || 500);
    }
    return u;
  }

  const Netease = {
    base: '',
    _profile: null,

    get nativeOn() {
      const N = g.RippleNative;
      return !!(N && typeof N.netease === 'function');
    },
    get mode() {
      if (this.nativeOn) return 'native';
      if (this.base) return 'proxy';
      // 浏览器里由 server.js 托管时，同源 /ncm/* 就是代理（不用手填地址）
      if (/^https?:$/.test(location.protocol)) return 'proxy';
      return 'none';
    },
    get ready() {
      return this.mode !== 'none';
    },
    get loggedIn() {
      return !!(this._profile && this._profile.userId);
    },
    get profile() {
      return this._profile;
    },

    setBase(b) {
      this.base = (b || '').trim().replace(/\/+$/, '');
    },

    level(i) {
      return LEVELS[Math.max(0, Math.min(4, i || 0))] || 'exhigh';
    },

    /** 唯一的请求出口：命令名 + 对象参数 → JSON */
    /**
     * 发一条命令。
     *
     * 审查 3.1：以前没有任何 in-flight 去重 —— `_pending` 只是 id→Promise 的
     * 一一映射，同一命令并发 5 次就真的打 5 次请求。
     * 用户连点同一首歌、或者列表快速滚动触发的重复加载，都会成倍放大请求量
     * （网易云对频率敏感，成倍请求容易触发风控）。
     *
     * 现在按「命令 + 参数签名」缓存**在飞**的 Promise：
     * 相同请求在它返回之前再发起，直接复用同一个 Promise，不重复打网络。
     * 请求结束后立刻从缓存里删掉 —— 这是去重，不是缓存，下次调用仍会真的请求。
     *
     * ⚠️ 注释以前写"写操作（点赞、发评论）不经过 call()" —— 那是**错的**，
     * 它们在实现里确实走 call()。去重套在写操作上会带来真实问题：
     * 用户手抖连点两次「赞」，第二次直接复用第一次的 Promise，
     * 看起来正确；但如果两次是「赞 → 取消赞」，签名不同不会合并，
     * 而同一秒内的两次「赞」本来就该只发一次 —— 所以合并其实是对的。
     * 真正需要区分的是「必须逐次送达」的写（如发评论），这里用
     * opts.noDedupe 显式跳过，注释同步改成与实现一致。
     */
    async call(cmd, params, opts) {
      if (this.mode === 'none') throw new Error('在线功能未启用');
      const noDedupe = !!(opts && opts.noDedupe);
      let sig = '';
      if (!noDedupe) {
        try { sig = cmd + '|' + JSON.stringify(params || {}); } catch (e) { sig = ''; }
      }
      if (sig && _inflight.has(sig)) return _inflight.get(sig);
      const task = this._callOnce(cmd, params);
      if (sig) {
        _inflight.set(sig, task);
        /* finally 里删掉：无论成功失败，下一次调用都应重新请求 */
        task.catch(() => {}).then(() => { _inflight.delete(sig); });
      }
      return task;
    },

    async _callOnce(cmd, params) {
      const text = this.mode === 'native'
        ? await nativeCall(cmd, params)
        : await proxyCall(cmd, params);
      if (!text) throw new Error('空响应');
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        if (/^\s*</.test(text)) throw new Error('接口返回了 HTML（可能被风控拦截）');
        throw new Error('返回内容不是 JSON');
      }
      /*
       * 审查 3.3：code 可能是字符串（"301"），严格 !== 会漏判，
       * 于是 301 被当成成功，全 App 继续认为「已登录」。
       * 这里统一转成数字再比。
       *
       * M-02：光有上面的归一化还不够 —— 旧条件是
       *   `if (json && codeNum && codeNum !== 200 && ...)`
       * json 为 null 时整句直接为假 → return null，上层 r.profile / r.data
       * 才炸成 TypeError "Cannot read properties of null"，日志里看不出
       * 是接口出了问题；上游回 {"code":0} 时 codeNum=0 也是假值，
       * 一样被当成功放行。
       * 现在先确认「是对象」、再确认「code 是可识别的成功码」，
       * 两件不同的事分开判，异常响应在源头就变成一句能读懂的错。
       * 上游 weapi 的响应一律带 code，缺失/非数字只可能是风控页、
       * 代理改写或响应被截断，按失败处理比静默放行安全。
       */
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        if (g.Log) {
          try { g.Log.err('API', new Error('响应格式异常'), cmd + ' 非 JSON 对象: ' + String(text).slice(0, 120)); } catch (e) {}
        }
        throw new Error('接口响应格式异常（' + cmd + '）');
      }
      const codeNum = json.code == null ? NaN : Number(json.code);
      /* 200 = 正常；800/801/802 是扫码登录的过程态（过期/待扫/待确认），都不是错误 */
      const codeOk = codeNum === 200 || codeNum === 800 || codeNum === 801 || codeNum === 802;
      if (!codeOk) {
        const msg = json.message || json.msg
          || (Number.isFinite(codeNum) ? '错误码 ' + codeNum : '接口未返回 code（' + cmd + '）');
        /*
         * 301 = 未登录。这里必须用上面归一化过的 codeNum，不能再用
         * json.code —— 上游返回字符串 "301" 时严格比较会漏判，
         * 抛出去的就是普通 Error('错误码 301')，没有 needLogin 标记，
         * 上层 e.needLogin 分支不生效，用户看到「错误码 301」
         * 而不是「需要登录网易云账号」。
         */
        if (codeNum === 301) {
          const err = new Error('需要登录网易云账号');
          err.needLogin = true;
          throw err;
        }
        throw new Error(msg);
      }
      return json;
    },

    /* ================= 账号 ================= */

    async status() {
      const r = await this.call('status', {});
      const p = r.profile;
      const extra = r._extra || {};
      const vip = extra.vip && extra.vip.data ? extra.vip.data : null;
      this._profile = p
        ? {
            userId: p.userId,
            nickname: p.nickname,
            avatar: cover(p.avatarUrl, 200),
            background: cover(p.backgroundUrl, 800),
            signature: p.signature || '',
            level: (extra.level && extra.level.data && extra.level.data.level) || 0,
            vip: !!(vip && vip.redVipLevel > 0),
            vipLevel: (vip && vip.redVipLevel) || 0,
            vipIcon: vip && vip.redVipLevelIcon ? String(vip.redVipLevelIcon).replace(/^http:/, 'https:') : '',
            vipUntil: (vip && vip.associator && vip.associator.expireTime) || 0,
            likeIds: (extra.like && extra.like.ids) || [],
          }
        : null;
      return this._profile;
    },

    /**
     * 打开官方登录页
     * @param mode 'phone' 手机号登录 | 'qr' 扫码登录
     */
    async login(mode) {
      const N = g.RippleNative;
      if (!N || typeof N.login !== 'function') throw new Error('当前环境不支持账号登录');
      let timedOut = false;
      let text;
      try {
        text = await new Promise((res, rej) => {
          const id = 'login_' + (++_seq);
          const timer = setTimeout(() => {
            _pending.delete(id);
            timedOut = true;
            /*
             * 超时不能只清自己的 pending 表：原生登录页还开着、Java 侧还会
             * 继续轮询 cookie 并在成功时回调，而 JS 这边的接收方已经被删掉，
             * 回调落到 __rippleNativeResult 的「无主回调」分支被吞掉 ——
             * 用户明明扫码成功了，界面上最后一条消息却是「登录超时」。
             * 先把登录页收掉（loginCancel → HttpBridge.loginClose），
             * 让原生侧也停下来，代价是用户可能需要重开一次登录；
             * 但「真正的已登录」还会由下面的 status() 探测兜住（见 catch）。
             */
            try { this.loginCancel(); } catch (e) {}
            rej(new Error('登录超时（3 分钟）'));
          }, 180000);
          _pending.set(id, (t) => { clearTimeout(timer); res(t); });
          try {
            N.login(mode || 'phone', id);
          } catch (e) {
            clearTimeout(timer);
            _pending.delete(id);
            rej(e);
          }
        });
      } catch (e) {
        /*
         * 超时路径的自愈：loginCancel 与 Java 侧的「登录成功」是两条独立的时间线，
         * 存在「cookie 已经写好、回调刚好错过超时」的窗口。这里补一次 status()
         * 探测 —— 已经登录就当作成功返回，而不是把一次真实的成功报成失败。
         * 只在超时路径探测：其他错误（登录页打不开等）说明 cookie 根本没写，
         * 多发一次 status 只会白打 4 个请求。
         */
        if (timedOut) {
          try {
            const p = await this.status();
            if (p && p.userId) {
              try {
                if (g.Log) g.Log.add('ACCOUNT', '登录回调虽已超时，但账号实际已登录，按成功处理');
              } catch (_) {}
              return this._profile;
            }
          } catch (_) {}
        }
        throw e;
      }
      let json = {};
      try { json = JSON.parse(text || '{}'); } catch (e) {}
      if (!json.profile) throw new Error('没有读到登录信息，请重试');
      /*
       * 登录成功与否只看这个回调（profile 已经在手，cookie 也已写入）。
       *
       * 以前这里是 `return this.status()` —— status 内部 4 次串行请求，
       * 最长 60 秒。它一旦失败/超时，doLogin 就进 catch 弹「登录未完成」，
       * 但账号其实**已经登录成功**了，用户会反复重试，越试越乱。
       *
       * 现在：先把 profile 直接用上（账号卡片立刻正确），
       * status 只用来补 VIP/等级这类附加信息，失败就算了。
       */
      this._profile = {
        userId: json.profile.userId,
        nickname: json.profile.nickname,
        avatar: cover(json.profile.avatarUrl, 200),
        background: cover(json.profile.backgroundUrl, 800),
        signature: json.profile.signature || '',
        level: 0, vip: false, vipLevel: 0, vipIcon: '', vipUntil: 0, likeIds: [],
      };
      /* 后台补全资料，失败不影响"登录成功"这个结论 */
      this.status().then((p) => {
        if (p) this._profile = p;
      }).catch((e) => {
        try { if (g.Log) g.Log.add('ACCOUNT', 'status 补全失败（不影响登录）: ' + e.message); } catch (_) {}
      });
      return this._profile;
    },

    loginCancel() {
      const N = g.RippleNative;
      if (N && typeof N.loginClose === 'function') N.loginClose();
    },

    async logout() {
      try { await this.call('logout', {}); } catch (e) {}
      this._profile = null;
    },

    /* ================= 音乐数据 ================= */

    mapSong(s) {
      const ar = s.ar || s.artists || [];
      const al = s.al || s.album || {};
      const dt = s.dt || s.duration || 0;
      const priv = s.privilege || {};
      const fee = s.fee;
      const maxBr = priv.maxbr || 0;
      return {
        id: 'ne_' + s.id,
        source: 'online',
        neId: s.id,
        title: s.name || '未知曲目',
        artist: ar.map((a) => a.name).filter(Boolean).join(' / ') || '未知艺人',
        album: al.name || '',
        duration: Math.round(dt / 1000),
        cover: cover(al.picUrl || '', 500),
        format: maxBr >= 999000 ? 'Hi-Res' : maxBr >= 320000 ? 'MP3' : 'AAC',
        maxBr: maxBr,
        fee: fee,
        vip: fee === 1 || fee === 4,
        privilege: priv,
      };
    },

    mapPlaylist(p) {
      return {
        id: 'pl_' + p.id,
        plId: p.id,
        title: p.name,
        sub: (p.trackCount || p.playCount || 0) + ' 首',
        cover: cover(p.coverImgUrl || p.picUrl, 600),
        kind: p.subscribed ? '收藏' : '歌单',
        playCount: p.playCount,
        tracks: null,
      };
    },

    async searchSongs(kw, limit = 30, offset = 0) {
      const r = await this.call('search', { keywords: kw, type: 1, limit, offset });
      const songs = (r.result && r.result.songs) || [];
      return { total: (r.result && r.result.songCount) || songs.length, list: songs.map((s) => this.mapSong(s)) };
    },

    async searchPlaylists(kw, limit = 20, offset = 0) {
      const r = await this.call('search', { keywords: kw, type: 1000, limit, offset });
      const pls = (r.result && r.result.playlists) || [];
      return { total: (r.result && r.result.playlistCount) || pls.length, list: pls.map((p) => this.mapPlaylist(p)) };
    },

    async songDetail(ids) {
      if (!ids || !ids.length) return [];
      const r = await this.call('song_detail', { ids: ids.join(',') });
      return (r.songs || []).map((s) => this.mapSong(s));
    },

    /** 取播放地址；取不到就抛错（会员/版权限制时明确告知，不做绕过） */
    async songUrl(id, levelIndex) {
      const level = this.level(levelIndex);
      const r = await this.call('song_url', { id: String(id), level });
      const d = (r.data || [])[0];
      if (!d || !d.url) {
        throw new Error(d && d.freeTrialInfo
          ? '只能试听片段（需要会员）'
          : '无版权、需要会员或地区不可用');
      }
      const trial = !!d.freeTrialInfo;
      return {
        url: String(d.url).replace(/^http:/, 'https:'),
        br: d.br,
        size: d.size,
        type: d.type || 'mp3',
        level: d.level || level,
        trial: trial,
      };
    },

    async lyric(id) {
      const r = await this.call('lyric', { id: String(id) });
      return {
        lrc: (r.lrc && r.lrc.lyric) || '',
        tlrc: (r.tlyric && r.tlyric.lyric) || '',
        roma: (r.romalrc && r.romalrc.lyric) || '',
      };
    },

    async playlist(id) {
      const r = await this.call('playlist', { id: String(id) });
      const pl = r.playlist;
      if (!pl) throw new Error(r.message || '歌单读取失败');
      return {
        id: 'pl_' + pl.id,
        plId: pl.id,
        title: pl.name,
        sub: (pl.tracks ? pl.tracks.length : pl.trackCount) + ' 首',
        cover: cover(pl.coverImgUrl, 600),
        desc: (pl.description || '').slice(0, 200),
        creator: (pl.creator && pl.creator.nickname) || '',
        tracks: (pl.tracks || []).map((s) => this.mapSong(s)),
      };
    },

    async playlistTracks(id, limit = 200) {
      const r = await this.call('playlist_tracks', { id: String(id), limit });
      return (r.songs || []).map((s) => this.mapSong(s));
    },

    async toplist() {
      const r = await this.call('toplist', {});
      return (r.list || []).slice(0, 8).map((x) => ({
        id: 'pl_' + x.id,
        plId: x.id,
        title: x.name,
        sub: x.updateFrequency || '',
        cover: cover(x.coverImgUrl, 400),
        kind: '榜单',
      }));
    },

    async dailyRecommend() {
      const r = await this.call('recommend', {});
      // 登录：v3/discovery/recommend/songs → data.dailySongs
      // 未登录：personalized/newsong → result[{song}]
      const daily = (r.data && r.data.dailySongs) || null;
      if (daily) return daily.map((s) => this.mapSong(s));
      const news = r.result || [];
      return news.map((x) => this.mapSong(x.song || x)).filter((t) => t.neId);
    },

    async personalizedPlaylists(limit = 10) {
      const r = await this.call('personalized', { limit });
      return (r.result || []).map((p) => this.mapPlaylist(p));
    },

    async likelist() {
      const uid = this._profile ? this._profile.userId : '';
      const r = await this.call('likelist', { uid: String(uid || '') });
      return r.ids || [];
    },

    async like(id, on) {
      const uid = this._profile ? this._profile.userId : '';
      if (!uid) { const e = new Error('需要登录网易云账号'); e.needLogin = true; throw e; }
      return this.call('like', { id: String(id), uid: String(uid), like: !!on });
    },

    async userPlaylists(limit = 100) {
      const uid = this._profile ? this._profile.userId : '';
      if (!uid) return [];
      const r = await this.call('user_playlist', { uid: String(uid), limit });
      return (r.playlist || []).map((p) => this.mapPlaylist(p));
    },

    async hotSearch() {
      try {
        const r = await this.call('hot_search', {});
        return (r.data || []).slice(0, 10).map((x) => x.searchWord).filter(Boolean);
      } catch (e) {
        /*
         * 审查 3.3：以前完全不报错、静默返回空数组 ——
         * 用户永远看不到「热门搜索」，也没人知道是接口挂了还是本来就没有。
         * 现在记一条日志（页面顶部不弹 toast，因为热搜是次要内容，
         * 弹窗反而更打扰），界面上会显示「热搜暂时取不到」。
         */
        Log.err('NCM', e, 'hotSearch');
        return [];
      }
    },

    /** 心动模式：以当前歌曲 + 歌单为种子，生成同口味的队列（需登录） */
    async heartMode(songId, playlistId, count = 20) {
      const r = await this.call('heart_mode', {
        songId: String(songId),
        playlistId: String(playlistId || 0),
        startMusicId: String(songId),
        count,
      });
      const list = r.data || [];
      return list.map((x) => this.mapSong(x.songInfo || x.song || x)).filter((t) => t.neId);
    },

    /** 无限漫游：拿相似歌曲不断续队列（未登录也能用） */
    async roamSongs(songId, limit = 20, offset = 0) {
      const r = await this.call('simi_song', { songId: String(songId), limit, offset });
      return (r.songs || []).map((s) => this.mapSong(s));
    },

    /** 私人 FM：兜底无限流 */
    async personalFm() {
      /*
       * noDedupe：私人 FM 是**刷新型读** —— 每次调用都该返回新的一批歌。
       * 它的参数恒为 {}，去重签名永远相同，于是快速连点两次「下一首」时
       * 第二次直接复用第一次还在飞的 Promise，两批完全一样的歌进了队列
       * （上一版刚给漫游队列加了去重，这里又把重复从源头送进来）。
       * 去重的语义只对「同一请求重复发起应当得到同一答案」的读成立，
       * 比如 search / song_url；刷新型读必须显式跳过。
       */
      const r = await this.call('personal_fm', {}, { noDedupe: true });
      return (r.data || []).map((s) => this.mapSong(s));
    },

    /** 歌曲评论（热评 + 最新） */
    async comments(songId, limit = 20, offset = 0) {
      const r = await this.call('comments', { id: String(songId), limit, offset });
      const map = (c) => ({
        id: c.commentId,
        user: (c.user && c.user.nickname) || '匿名',
        avatar: cover((c.user && c.user.avatarUrl) || '', 80),
        content: c.content || '',
        liked: c.likedCount || 0,
        time: c.time || 0,
      });
      return {
        total: r.total || 0,
        hot: (r.hotComments || []).map(map),
        list: (r.comments || []).map(map),
      };
    },

    /**
     * 第 16 条：发表评论。
     * 未登录时网易云会回 301/250，这里统一抛一个 needLogin 错误，
     * 让上层提示「先登录」而不是弹一句莫名的接口错误。
     */
    async addComment(songId, content) {
      const text = String(content || '').trim();
      if (!text) throw new Error('评论不能为空');
      if (text.length > 140) throw new Error('评论最多 140 字');
      /*
       * noDedupe：发评论是"必须逐次送达"的写操作。
       * 而且 _callOnce 对非 200/800/801/802 已经先抛错了，
       * 所以下面那段 `if (code !== 200)` 其实是**死代码** ——
       * 250/301 的"需要登录后才能评论"文案永远不执行，
       * 用户看到的是 call() 抛出来的通用错误。这里显式处理那个异常。
       */
      let r;
      try {
        r = await this.call('comment_add', { id: String(songId), content: text }, { noDedupe: true });
      } catch (e) {
        /* 未登录时上游回 301/250，语气说清楚点 */
        if (e && (e.needLogin || /301|250|401/.test(String(e.message)))) {
          const err = new Error('需要登录后才能评论');
          err.needLogin = true;
          throw err;
        }
        throw e;
      }
      const code = r && (r.code == null ? 200 : Number(r.code));
      if (code !== 200) {
        const e = new Error((r && r.message) || (code === 301 || code === 250 ? '需要登录后才能评论' : '发表失败'));
        if (code === 301 || code === 250 || code === 401) e.needLogin = true;
        throw e;
      }
      return r;
    },

    /** 设置页「测试连接」 */
    async test() {
      const t0 = performance.now();
      const r = await this.searchSongs('周杰伦', 1);
      return { ok: r.list.length > 0, ms: Math.round(performance.now() - t0), name: r.list[0] ? r.list[0].title : '' };
    },
  };

  g.Netease = Netease;
})(window);
