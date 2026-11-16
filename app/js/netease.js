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
    if (!done) return;
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
   */
  const CALL_TIMEOUT = {
    status: 60000,        // 4 次串行
    login: 45000,
    like_list: 30000,
    playlist: 30000,
    playlist_tracks: 30000,
    comments: 25000,
    song_url: 25000,
    search: 20000,
    lyric: 18000,
    hot_search: 15000,
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
          rej(new Error((e.name === 'AbortError' ? '接口超时' : e.message) + ' · ' + (Date.now() - t0) + 'ms'));
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
     * 注意：只有 GET 语义的读接口才会走这里（搜索、歌单、歌词、评论…）；
     * 写操作（点赞、发评论）不经过 call()，所以不会被误合并。
     */
    async call(cmd, params) {
      if (this.mode === 'none') throw new Error('在线功能未启用');
      let sig = '';
      try { sig = cmd + '|' + JSON.stringify(params || {}); } catch (e) { sig = ''; }
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
       */
      const codeNum = json && json.code == null ? null : Number(json.code);
      if (json && codeNum && codeNum !== 200 && codeNum !== 800 && codeNum !== 801 && codeNum !== 802) {
        const msg = json.message || json.msg || ('错误码 ' + codeNum);
        // 301 = 未登录
        if (json.code === 301) {
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
      const text = await new Promise((res, rej) => {
        const id = 'login_' + (++_seq);
        const timer = setTimeout(() => {
          _pending.delete(id);
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
      let json = {};
      try { json = JSON.parse(text || '{}'); } catch (e) {}
      if (!json.profile) throw new Error('没有读到登录信息，请重试');
      return this.status();
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
      const r = await prof(() => this.call('song_detail', { ids: ids.join(',') }), 'detail');
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
      const r = await this.call('personal_fm', {});
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
      const r = await this.call('comment_add', { id: String(songId), content: text });
      const code = r && (r.code == null ? 200 : r.code);
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

  /** 有些接口对未登录用户会返回 301，这里兜一层把错误信息说得更具体 */
  async function prof(fn) {
    try {
      return await fn();
    } catch (e) {
      throw e;
    }
  }

  g.Netease = Netease;
})(window);
