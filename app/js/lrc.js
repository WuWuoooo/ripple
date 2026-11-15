/* LRC 解析 */
(function (g) {
  const TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

  function parse(text) {
    if (!text) return [];
    const out = [];
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      if (!raw) continue;
      TAG.lastIndex = 0;
      const stamps = [];
      let m;
      while ((m = TAG.exec(raw))) {
        const min = parseInt(m[1], 10);
        const sec = parseInt(m[2], 10);
        const frac = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0;
        stamps.push(min * 60 + sec + frac);
      }
      if (!stamps.length) continue;
      const body = raw.replace(TAG, '').trim();
      if (!body) continue;
      for (const t of stamps) out.push({ t, text: body });
    }
    out.sort((a, b) => a.t - b.t);
    // 去掉相邻重复
    return out.filter((x, i) => i === 0 || x.text !== out[i - 1].text || x.t - out[i - 1].t > 0.3);
  }

  /**
   * 合并原文与译文。
   *
   * 以前用 Math.round(t * 10)（100ms 取整）做键 —— 原文 1.04 和译文 1.06
   * 会被算成 10 和 11，整行译文就丢了。网易云的译文时间戳常常差几十毫秒。
   * 现在按时间排序后做「最近邻」匹配，容差 300ms；时间戳完全对不上时
   * （有些歌词只有译文没有逐行时间），退化成按行号对齐。
   */
  function merge(orig, trans) {
    if (!trans || !trans.length) return orig;
    const TOL = 0.3;
    const used = new Set();
    const out = orig.map((l) => {
      let best = -1, bestD = Infinity;
      for (let i = 0; i < trans.length; i++) {
        if (used.has(i)) continue;
        const d = Math.abs(trans[i].t - l.t);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0 && bestD <= TOL) {
        used.add(best);
        const tr = trans[best].text;
        return tr && tr !== l.text ? { ...l, tr } : { ...l };
      }
      return { ...l };
    });
    // 完全匹配不上（时间轴不一致）时按行号兜底，总比一行译文都不显示好
    const matched = out.filter((x) => x.tr).length;
    if (!matched && trans.length === orig.length) {
      return orig.map((l, i) => {
        const tr = trans[i].text;
        return tr && tr !== l.text ? { ...l, tr } : { ...l };
      });
    }
    return out;
  }

  g.LRC = { parse, merge };
})(window);
