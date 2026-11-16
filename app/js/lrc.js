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
    /*
     * 去掉「同一时间戳上重复的同一行」。
     *
     * 原条件是 `x.t - prev.t > 0.3` —— 意思是「相邻两行文字相同、且间隔不到 0.3 秒」
     * 就删掉后一行。但副歌重复恰恰是最常见的正常歌词：
     *     [01:23.00]每一次心跳
     *     [01:26.50]每一次心跳
     * 间隔 3.5 秒，条件里第二个分支成立 → **保留**（这是对的）；
     * 真正该删的是同一时间戳被 LRC 文件写了两遍的情况：
     *     [01:23.00]每一次心跳
     *     [01:23.00]每一次心跳
     * 间隔 0 秒 → 删掉一条（这也是对的）。
     *
     * 问题出在阈值 0.3 太宽：有些歌词行间隔真的只有 0.2 秒
     *（念白、快歌、副歌里连着的短句），会被当成重复删掉，
     * 表现为「某几句歌词莫名消失、整首对不上」。
     *
     * 现在只看「时间戳是否相同」：间隔小于 0.05 秒才认为是同一条被写了两次。
     * 正常歌词即使再快也不会在同一瞬间重复，而真正的重复时间戳差为 0。
     */
    return out.filter((x, i) => i === 0
      || x.text !== out[i - 1].text
      || x.t - out[i - 1].t >= 0.05);
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
    /*
     * L-14：兜底条件以前要求 trans.length === orig.length（完全相等）。
     * 但原文和译文中相同的行会被各自去重，去掉的行数常常不同
     * （例如原文有两段相同副歌、译文只有一段），条件永远不成立，
     * 结果是整首译文一行都不显示，设置里的「翻译」开关看着像坏了。
     * 现在改成：以较短的一方为准做索引兜底，多出来的行保持无译文。
     */
    if (!matched) {
      const n = Math.min(orig.length, trans.length);
      for (let i = 0; i < n; i++) {
        const tr = trans[i].text;
        if (tr && tr !== out[i].text) out[i] = { ...out[i], tr };
      }
    }
    return out;
  }

  g.LRC = { parse, merge };
})(window);
