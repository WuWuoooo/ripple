/* ============================================================
   Ripple · 歌词卡拉OK填充计算
   ============================================================
   把「当前播放时刻」换算成「当前这一句唱了多少、该填多宽」。

   为什么单独成模块，而不是塞进 app.js：
     app.js 有一万三千行，且直接摸 DOM，没法在 Node 里单测；
     而这段换算全是纯函数（给定时间轴和时刻，算出比例），
     恰恰是最该被测试钉住的部分 —— 边界、换句、句内插值、
     长句尾音、offset 偏移，任何一条算错，观感就是「颜色和声音对不上」。
     所以这里只做数学，不碰 DOM、不读 Store。
   ============================================================ */
(function (g) {
  /**
   * 某一行唱到哪了（0..1）。
   *
   * 时间轴结构：lines 是按 t 升序的数组，第 i 句的「演唱区间」是
   * [lines[i].t, lines[i+1].t)。最后一句没有下一句，用 fallbackDur 兜住
   * —— 这是最容易出错的一处：
   *
   *   · 用「整首时长」兜底 → 最后一句往往只有几秒词，却摊到几十秒，
   *     表现为「歌都唱完了，最后一句才染了 10%」，而且永远染不满；
   *   · 用 0 兜底 → 最后一句进度恒为 1，一开口就整句变亮，
   *     失去「唱到哪」的含义。
   *
   * 所以最后一句单独取一个「这一句自己的时长」估计：优先用前几句的
   * 中位间隔（歌词排版通常均匀），再夹到 [1.2s, 8s] —— 低于 1.2s 会让
   * 尾句一闪而过，高于 8s 会让尾句长时间停在半亮。
   *
   * @param {Array<{t:number}>} lines 歌词行（按 t 升序，至少要有一行）
   * @param {number} idx 当前句下标（可为 -1 或越界，越界时返回 0）
   * @param {number} now 当前播放时刻（秒，已含用户设置的歌词偏移）
   * @param {number} [fallbackDur] 整首时长，仅用于「只有一句歌词」的极端情况
   * @returns {number} 0..1
   */
  function lineProgress(lines, idx, now, fallbackDur) {
    if (!lines || !lines.length) return 0;
    if (typeof idx !== 'number' || idx < 0 || idx >= lines.length) return 0;
    const start = Number(lines[idx] && lines[idx].t);
    if (!Number.isFinite(start)) return 0;

    const t = Number(now);
    if (!Number.isFinite(t)) return 0;
    if (t <= start) return 0;                 // 还没唱到这一句（含恰好等于）

    const next = lines[idx + 1];
    let end;
    if (next && Number.isFinite(Number(next.t)) && Number(next.t) > start) {
      end = Number(next.t);
      /*
       * ⚠️ 关键：下一句离得远的时候，不能把「到下一句的时间」当成「这一句的演唱时长」。
       *
       * 这是 1.3.3 修掉的那个「歌词进度偏慢、到后面越差越多」的真正原因：
       * LRC 的时间戳是「下一句**开始唱**的时刻」，而它和「上一句**唱完**的时刻」
       * 之间可能隔着很长一段前奏 / 间奏 / 纯乐器段。比如：
       *     [00:10.00]第一句
       *     [00:25.00]（15 秒间奏，没人唱）
       *     [00:25.00]第二句
       * 第一句实际可能 3 秒就唱完了，而我们按 15 秒去铺渐变 ——
       * 颜色以 1/5 的速度慢慢爬，用户看到的就是「染色比唱的慢很多」。
       * 更糟的是这种偏差**每句都会发生一次**，观众的感觉就是「越到后面越对不上」。
       *
       * 修法：拿「下一句时间」和「估计的本句时长」取较小值。
       * 估计值来自相邻间隔的中位数（见 estimateLineDur），代表「唱一句通常要多久」。
       * 留 1.6 倍余量，给「这一句确实比平均长一些」的正常情况留空间，
       * 但不允许被十几秒的间奏无限拉伸。
       */
      /*
       * 在「字数估计」和「到下一句的间隔」之间取一个折中，而不是简单取小。
       *
       * 为什么不能只用字数：中文咬字速度在不同歌里差别很大 ——
       *   快歌（说唱、儿歌）可能 7 字 1 秒就说完了；
       *   慢歌（抒情、念白）同样 7 个字能拖 4 秒。
       * 只用字数会让慢歌**染得比唱得快**（刚唱一半颜色已经到头），
       * 和只用间隔让快歌**染得比唱得慢**是同一类错误的两个方向。
       *
       * 折中办法：取 (字数估计, 到下一句的间隔) 的中点，
       * 这样两个方向各错一半，都不会太离谱；
       * 再夹一层上下限（不小于字数估计的 0.8 倍、不超过间隔本身），
       * 保证不会因为某一句特别长/特别短而失真。
       */
      const est = estimateLineDur(lines, idx, fallbackDur);
      const rawGap = end - start;
      let want;
      if (rawGap > 0 && Number.isFinite(rawGap)) {
        /*
         * 间隔要先「限幅」再参与折中。
         *
         * 不设上限的话，长间奏（比如 20 秒）会把中点拽到 10 秒 ——
         * 那等于又退回了「按间隔铺」的老毛病。上限取 est * 2：
         * 一句歌词再慢，也很少会唱到估计时长的两倍以上；
         * 超过这个数多出来的时间，几乎一定是间奏而不是在唱。
         */
        const gap = Math.min(rawGap, est * 2);
        want = Math.min(rawGap, Math.max(est * 0.8, (est + gap) / 2));
      } else {
        want = est;
      }
      end = start + want;
    } else {
      end = start + estimateLineDur(lines, idx, fallbackDur);
    }
    if (!(end > start)) return t > start ? 1 : 0;

    const p = (t - start) / (end - start);
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  /**
   * 这一句「实际会染多久」—— 秒，从 lines[idx].t 算到染色结束。
   *
   * ⚠️ 这个函数是 1.3.3 第五轮修「状态栏一直满格」的关键。
   *
   * 为什么要单独导出一个函数：
   *   lineProgress() 内部把「到下一句的间隔」和「字数估计」做了折中，
   *   得到真正的 end 点；但这个 end **没有暴露出去**。
   *   而原生浮层需要知道「这一句总共多久」才能按时间外推 ——
   *   于是之前只能推 estimateLineDur（纯字数估计）。
   *
   *   两者在英文歌里差得很远：
   *     一句 35 个英文字符 → 字数估计 7.6s
   *     但真实句间隔只有 3.2s，lineProgress 的 end 是 3.2s 附近
   *   结果原生按 7.6s 慢慢爬，唱完这一句时进度才 42%；
   *   接下来间奏里原生继续爬，等它爬到 1，网页早换到下一句了 ——
   *   用户看到的就是**颜色一直停在满格、看不到从左往右推进**（真机日志 p1=1136）。
   *
   *   所以这里把 lineProgress 用的同一套计算抽出来复用，
   *   保证「网页认为的染色时长」和「原生外推用的时长」严格一致。
   *
   * @param {Array<{t:number,text?:string}>} lines
   * @param {number} idx 当前句下标
   * @param {number} [fallbackDur] 整首时长（极端兜底）
   * @returns {number} 秒；下标非法或数据不全时返回 0（调用方据此退回旧行为）
   */
  function lineSpan(lines, idx, fallbackDur) {
    if (!lines || !lines.length) return 0;
    if (typeof idx !== 'number' || idx < 0 || idx >= lines.length) return 0;
    const start = Number(lines[idx] && lines[idx].t);
    if (!Number.isFinite(start)) return 0;

    const next = lines[idx + 1];
    if (next && Number.isFinite(Number(next.t)) && Number(next.t) > start) {
      const end = Number(next.t);
      const est = estimateLineDur(lines, idx, fallbackDur);
      const rawGap = end - start;
      if (rawGap > 0 && Number.isFinite(rawGap)) {
        const gap = Math.min(rawGap, est * 2);
        const want = Math.min(rawGap, Math.max(est * 0.8, (est + gap) / 2));
        return want > 0 ? want : 0;
      }
      return est;
    }
    return estimateLineDur(lines, idx, fallbackDur);
  }

  /**
   * 估计「这一句唱完需要多久」。
   *
   * ⚠️ 这个函数是 1.3.3 修掉「歌词染色比声音慢、越到后面差越多」的关键。
   *
   * 为什么不能直接用「到下一句的时间差」：
   *   LRC 的时间戳是「下一句**开始唱**的时刻」，它和「这一句**唱完**的时刻」
   *   之间可能隔着前奏 / 间奏 / 纯乐器段。按间隔铺渐变，颜色就会以远低于
   *   实际的速度爬 —— 一句本该 3 秒唱完的词，被摊到 15 秒里，
   *   用户看到的正是「染色明显偏慢」。而间奏越往后越密，所以**越到后面越明显**。
   *
   * 用**字数**估时长的理由：
   *   中文歌词的咬字速度相当稳定（流行歌约 4~5 字/秒），比「句间隔」这个
   *   混了间奏的量可靠得多。而且它是**逐句独立**的估计，不会把一句的误差
   *   累积到下一句 —— 这正好对应用户说的「越差越多」。
   *
   * 兜底链路（前一条拿不到就用下一条）：
   *   1. 字数估计（最可靠，反映「唱」这件事本身）
   *   2. 相邻间隔的中位数（没有文字时用；中位数不被长间奏拽偏）
   *   3. 整首时长的 1/12（只有一行歌词的极端情况）
   *
   * @param {Array<{t:number,text?:string}>} lines 歌词行
   * @param {number} idx 当前句下标
   * @param {number} [fallbackDur] 整首时长，仅用于最后的兜底
   * @returns {number} 秒，已夹到 [1.0, 9]
   */
  function estimateLineDur(lines, idx, fallbackDur) {
    /*
     * ① 字数估计。
     * 只数「会发声的字符」：中文字、日文假名、韩文、英文字母数字都算，
     * 空格和标点不算（它们不占演唱时长，标点处往往是停顿）。
     *
     * CHARS_PER_SEC = 4.6 是流行歌的实测均值；慢歌偏低、快歌偏高，
     * 所以最终的区间放宽到 [1.0s, 9s]，让长短句都能容纳。
     */
    const line = lines[idx];
    const text = line && typeof line.text === 'string' ? line.text : '';
    if (text) {
      // 去掉空格 / 常见中英文标点，剩下的才是真正唱出来的字
      const sung = text.replace(/[\s，。、！？；：""''（）《》…—·,.!?;:"'()\[\]]/g, '');
      if (sung.length) {
        const est = sung.length / 4.6;
        return Math.max(1.0, Math.min(9, est));
      }
    }

    /* ② 相邻间隔的中位数（用中位数而不是平均数：不被长间奏拽偏） */
    const gaps = [];
    // 只取当前句附近的一段做样本：整首歌的间隔分布可能前后差很多
    const from = Math.max(0, idx - 12);
    const to = Math.min(lines.length - 1, idx + 6);
    for (let i = from; i < to; i++) {
      const a = Number(lines[i] && lines[i].t);
      const b = Number(lines[i + 1] && lines[i + 1].t);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const d = b - a;
      // 超过 15 秒的多半是间奏，不代表「唱一句要多久」，排除掉
      if (d > 0 && d <= 15) gaps.push(d);
    }
    if (gaps.length) {
      gaps.sort((x, y) => x - y);
      const m = gaps.length >> 1;
      const est = gaps.length % 2 ? gaps[m] : (gaps[m - 1] + gaps[m]) / 2;
      return Math.max(1.0, Math.min(9, est));
    }

    /* ③ 兜底：整首时长的 1/12（「一首歌大约 12 句」的粗估） */
    const d = Number(fallbackDur);
    const est = Number.isFinite(d) && d > 0 ? d / 12 : 3;
    return Math.max(1.0, Math.min(9, est));
  }

  /**
   * 一屏三行里，哪几行算「已唱完 / 正在唱 / 还没唱」。
   *
   * 收起态的播放页只有三行（前一句 / 当前 / 下一句），它们不像展开态
   * 那样有整篇上下文。这里给出每行的归一化语气，让 CSS 只负责上色：
   *   'done'  —— 已经唱完（整行用已播放色）
   *   'now'   —— 正在唱（按 lineProgress 染色）
   *   'todo'  —— 还没到（保持原样）
   *
   * 判据就是 rel 的正负号，不要去比绝对下标 ——
   * 第一版写成「abs < c 就是 done、否则是 now」，结果 rel=+1 时
   * abs = c+1 既不小于 c 也不越界，落进了 now 分支，
   * 表现为「下一句和当前句同时按进度染色」，两行一起动。
   *
   * @param {number} cur 当前句下标
   * @param {number} rel 相对当前句的偏移（-1 = 上一句，0 = 当前，1 = 下一句）
   * @param {number} count 总行数
   * @returns {'done'|'now'|'todo'}
   */
  function toneFor(cur, rel, count) {
    const n = Number(count) || 0;
    const c = Number(cur);
    const r = Number(rel) || 0;
    if (!Number.isFinite(c) || c < 0) return 'todo';    // 第一句之前
    const abs = c + r;
    if (abs < 0 || abs >= n) return 'todo';             // 越界（末尾的「下一句」）
    if (r < 0) return 'done';
    if (r > 0) return 'todo';
    return 'now';
  }

  g.LyricFill = { lineProgress, estimateLineDur, lineSpan, toneFor };
})(window);
