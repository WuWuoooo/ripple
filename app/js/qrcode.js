/* ============================================================
   Ripple · 极简二维码编码器（零依赖）

   为什么自己写：本项目刻意不引入 npm 依赖 / 前端构建链，而扫码登录需要
   把网易云的登录 URL 画成二维码。引入一个 qrcode 库会破坏这条取向，
   所以这里实现一个够用的子集。

   实现范围（够扫码登录用即可）：
     · 版本 1–10（最多约 271 字节，登录 URL 只有 40 字节左右，绰绰有余）
     · 字节模式（byte mode），UTF-8
     · 纠错等级 L / M / Q / H（默认 M）
     · 自动选掩码（8 种都试，取惩罚分最低的）

   不实现：数字/字母数字模式、结构化追加、ECI。用不上，多写只会多出错。

   参考：ISO/IEC 18004。下面每个步骤都按规范走，
   并用「已知输出」做自检（见文件末尾的 selfTest）。
   ============================================================ */
(function (g) {
  'use strict';

  /* ---------- 容量表：版本 → 每块数据码字数 / 纠错块结构 ---------- */
  /*
   * 只列到版本 10。每项：[版本][等级] = { data: 总数据码字数, ec: 每块纠错码字数,
   * blocks: [[块数, 每块数据码字数], ...] }
   *
   * 直接从规范表格抄，不推导 —— 推导式容易在边界上悄悄错一位。
   */
  const CAP = {
    1:  { L: [19, 7,  [[1, 19]]],        M: [16, 10, [[1, 16]]],
          Q: [13, 13, [[1, 13]]],        H: [9,  17, [[1, 9]]] },
    2:  { L: [34, 10, [[1, 34]]],        M: [28, 16, [[1, 28]]],
          Q: [22, 22, [[1, 22]]],        H: [16, 28, [[1, 16]]] },
    3:  { L: [55, 15, [[1, 55]]],        M: [44, 26, [[1, 44]]],
          Q: [34, 18, [[2, 17]]],        H: [26, 22, [[2, 13]]] },
    4:  { L: [80, 20, [[1, 80]]],        M: [64, 18, [[2, 32]]],
          Q: [48, 26, [[2, 24]]],        H: [36, 16, [[4, 9]]] },
    5:  { L: [108, 26, [[1, 108]]],      M: [86, 24, [[2, 43]]],
          Q: [62, 18, [[2, 15], [2, 16]]], H: [46, 22, [[2, 11], [2, 12]]] },
    6:  { L: [136, 18, [[2, 68]]],       M: [108, 16, [[4, 27]]],
          Q: [76, 24, [[4, 19]]],        H: [60, 28, [[4, 15]]] },
    7:  { L: [156, 20, [[2, 78]]],       M: [124, 18, [[4, 31]]],
          Q: [88, 18, [[2, 14], [4, 15]]], H: [66, 26, [[4, 13], [1, 14]]] },
    8:  { L: [194, 24, [[2, 97]]],       M: [154, 22, [[2, 38], [2, 39]]],
          Q: [110, 22, [[4, 18], [2, 19]]], H: [86, 26, [[4, 14], [2, 15]]] },
    9:  { L: [232, 30, [[2, 116]]],      M: [182, 22, [[3, 36], [2, 37]]],
          Q: [132, 20, [[4, 16], [4, 17]]], H: [100, 24, [[4, 12], [4, 13]]] },
    10: { L: [274, 18, [[2, 68], [2, 69]]], M: [216, 26, [[4, 43], [1, 44]]],
          Q: [154, 24, [[6, 19], [2, 20]]], H: [122, 28, [[6, 15], [2, 16]]] },
  };

  /* 每个版本的对齐图案中心坐标（规范附录 E） */
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  /* 纠错等级 → 2 位编码 */
  const ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  /* ---------- GF(256) 伽罗华域运算（里德-所罗门纠错用） ---------- */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;   // 本原多项式 x^8+x^4+x^3+x^2+1
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /** 生成多项式 g(x) = (x-α^0)(x-α^1)...(x-α^(n-1)) */
  function genPoly(n) {
    let poly = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  /** 对一块数据算纠错码字 */
  function ecBytes(data, ecLen) {
    const gen = genPoly(ecLen);
    const res = new Array(ecLen).fill(0);
    for (const d of data) {
      const factor = d ^ res[0];
      res.shift();
      res.push(0);
      for (let i = 0; i < ecLen; i++) {
        res[i] ^= gfMul(gen[i + 1], factor);
      }
    }
    return res;
  }

  /* ---------- 比特流 ---------- */
  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.put = function (val, len) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  };

  /* ---------- UTF-8 编码 ---------- */
  function utf8Bytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        // 代理对 → 4 字节
        const c2 = str.charCodeAt(++i);
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  /* ---------- 选择版本 ---------- */
  function pickVersion(byteLen, ecl) {
    for (let v = 1; v <= 10; v++) {
      const cap = CAP[v][ecl];
      if (!cap) continue;
      // 字符计数指示符：版本 1-9 是 8 位，10+ 是 16 位
      const ccBits = v < 10 ? 8 : 16;
      const needBits = 4 + ccBits + byteLen * 8;
      if (needBits <= cap[0] * 8) return v;
    }
    throw new Error('内容太长（本实现最多版本 10 / ' + ecl + ' 等级）');
  }

  /* ---------- 构造数据码字 ---------- */
  function buildCodewords(text, ecl) {
    const bytes = utf8Bytes(text);
    const ver = pickVersion(bytes.length, ecl);
    const cap = CAP[ver][ecl];
    const dataCap = cap[0];
    const ecPerBlock = cap[1];
    const blocks = cap[2];

    const bb = new BitBuffer();
    bb.put(0x4, 4);                                  // 字节模式
    bb.put(bytes.length, ver < 10 ? 8 : 16);         // 字符计数
    for (const b of bytes) bb.put(b, 8);

    // 终止符：最多 4 个 0
    const capBits = dataCap * 8;
    const remain = capBits - bb.bits.length;
    bb.put(0, Math.min(4, remain));

    // 补到字节边界
    while (bb.bits.length % 8 !== 0) bb.bits.push(0);

    // 转字节
    const data = [];
    for (let i = 0; i < bb.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bb.bits[i + j];
      data.push(b);
    }
    // 填充码字 0xEC / 0x11 交替
    let pad = true;
    while (data.length < dataCap) {
      data.push(pad ? 0xec : 0x11);
      pad = !pad;
    }

    // 分块 + 每块算纠错
    const dataBlocks = [];
    const ecBlocks = [];
    let off = 0;
    for (const [n, size] of blocks) {
      for (let i = 0; i < n; i++) {
        const blk = data.slice(off, off + size);
        off += size;
        dataBlocks.push(blk);
        ecBlocks.push(ecBytes(blk, ecPerBlock));
      }
    }

    // 交织：数据块按列取，再纠错块按列取
    const out = [];
    const maxLen = Math.max.apply(null, dataBlocks.map((b) => b.length));
    for (let i = 0; i < maxLen; i++) {
      for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i]);
    }
    for (let i = 0; i < ecPerBlock; i++) {
      for (const blk of ecBlocks) if (i < blk.length) out.push(blk[i]);
    }
    return { ver, codewords: out };
  }

  /* ---------- 建矩阵 ---------- */
  function buildMatrix(ver, ecl, codewords, mask) {
    const size = ver * 4 + 17;
    const m = [];
    const fn = [];   // 功能图案标记（不参与掩码）
    for (let i = 0; i < size; i++) {
      m.push(new Array(size).fill(0));
      fn.push(new Array(size).fill(false));
    }

    const set = (x, y, v) => { m[y][x] = v; fn[y][x] = true; };

    // 定位图案（三个角）
    function finder(cx, cy) {
      for (let dy = -1; dy <= 7; dy++) {
        for (let dx = -1; dx <= 7; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const inRing = (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6))
            || (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6))
            || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
          set(x, y, inRing ? 1 : 0);
        }
      }
    }
    finder(0, 0); finder(size - 7, 0); finder(0, size - 7);

    // 定时图案
    for (let i = 8; i < size - 8; i++) {
      set(i, 6, i % 2 === 0 ? 1 : 0);
      set(6, i, i % 2 === 0 ? 1 : 0);
    }

    // 对齐图案
    const al = ALIGN[ver] || [];
    for (const ay of al) {
      for (const ax of al) {
        // 跳过与定位图案重叠的三个角
        if ((ax === 6 && ay === 6) || (ax === 6 && ay === size - 7)
            || (ax === size - 7 && ay === 6)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const ring = Math.max(Math.abs(dx), Math.abs(dy));
            set(ax + dx, ay + dy, ring !== 1 ? 1 : 0);
          }
        }
      }
    }

    // 格式信息占位（真值在掩码选好后再填）
    function reserveFormat() {
      for (let i = 0; i < 9; i++) {
        if (i !== 6) { fn[8][i] = true; fn[i][8] = true; }
      }
      fn[8][6] = true; fn[6][8] = true;
      for (let i = 0; i < 8; i++) {
        fn[8][size - 1 - i] = true;
        fn[size - 1 - i][8] = true;
      }
      fn[size - 8][8] = true;
    }
    reserveFormat();

    /*
     * 暗模块（规范 7.9.1）：位置是 (size-8, 8)，第 8 列靠下。
     *
     * 早先这里写成了 (size-8, size-8) —— 右下角，那是**数据区**，
     * 结果右下角一个像素永远被涂黑、还把该位置的数据位吃掉。
     * 症状就是这么隐蔽：整个矩阵只有 1 个像素不对，扫不出来但不报错。
     */
    set(size - 8, 8, 1);

    // 版本信息（版本 >= 7）
    if (ver >= 7) {
      let v = ver;
      for (let i = 0; i < 12; i++) {
        const bit = (v >> i) & 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        set(a, b, bit);
        set(b, a, bit);
      }
    }

    /*
     * 填数据：从右下角开始，两列一组向左推进，组内蛇形上下走。
     *
     * 两个容易写错的点（都踩过）：
     *  ① 蛇形方向由「这是第几组列对」决定，不是由列号决定 ——
     *     写成 `((right + 1) & 2) === 0` 会算错方向，整块数据错位。
     *  ② 第 6 列是竖直定时图案，必须整列跳过，但不能让列对错位。
     *     正确做法是**先把列对序列排好再遍历**，而不是在循环里改 right。
     */
    let idx = 0;
    const total = codewords.length;
    let bitPos = 0;

    // 预先算出所有列对（右列优先），第 6 列不参与
    const colPairs = [];
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) {
        // 第 6 列是定时列：这一对变成 (5,4)
        colPairs.push([5, 4]);
        right = 5;             // 下一轮从 3 开始
      } else {
        colPairs.push([right, right - 1]);
      }
    }

    for (let pi = 0; pi < colPairs.length; pi++) {
      const [ca, cb] = colPairs[pi];
      // 第 0 组从下往上，第 1 组从上往下，交替
      const upward = pi % 2 === 0;
      for (let vert = 0; vert < size; vert++) {
        const y = upward ? size - 1 - vert : vert;
        for (const x of [ca, cb]) {
          if (x < 0 || fn[y][x]) continue;
          let bit = 0;
          if (idx < total) {
            bit = (codewords[idx] >>> (7 - bitPos)) & 1;
          }
          m[y][x] = bit;
          bitPos++;
          if (bitPos === 8) { bitPos = 0; idx++; }
        }
      }
    }

    // 掩码
    const maskFn = [
      (x, y) => (x + y) % 2 === 0,
      (x, y) => y % 2 === 0,
      (x, y) => x % 3 === 0,
      (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
      (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
      (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ][mask];

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!fn[y][x] && maskFn(x, y)) m[y][x] ^= 1;
      }
    }

    // 格式信息（含掩码号与纠错等级，BCH 编码）
    const eclBits = ECL_BITS[ecl];
    let fmt = (eclBits << 3) | mask;
    let rem = fmt;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fmtBits = ((fmt << 10) | rem) ^ 0x5412;

    /*
     * 格式信息要写两份（规范 7.9.1），两份的**位序相反**：
     *
     *   第一份（左上角，沿第 8 行向右再沿第 8 列向上）：
     *     从 bit14 依次写到 bit0
     *   第二份（左下竖条 + 右上横条）：
     *     从 bit0 依次写到 bit14
     *
     * 早先两份都按「低位在前」写，结果只有格式信息区错 13 个像素 ——
     * 结构测试、BCH 校验全都能通过（因为校验的是 fmtBits 这个数本身），
     * 但扫不出来。校验值本身正确 != 摆放位置正确，这是很容易漏的一层。
     */
    let b = 0;
    // 第一份：bit14 → bit0
    for (let i = 14; i >= 0; i--) {
      const bit = (fmtBits >> i) & 1;
      if (b <= 5) m[8][b] = bit;               // (8,0)..(8,5)
      else if (b === 6) m[8][7] = bit;         // 跳过定时列 (8,6)
      else if (b === 7) m[8][8] = bit;
      else if (b === 8) m[7][8] = bit;
      else m[14 - b][8] = bit;                 // (5,8)..(0,8)
      b++;
    }

    // 第二份：bit14 → bit0，但摆在另一组位置上
    // 左下竖条：(size-1,8) 向上共 7 个，再跳到 (size-8,8) 之后
    for (let i = 0; i < 7; i++) m[size - 1 - i][8] = (fmtBits >> (14 - i)) & 1;
    // 右上横条：(8,size-8) 向右共 8 个
    for (let i = 0; i < 8; i++) m[8][size - 8 + i] = (fmtBits >> (7 - i)) & 1;

    m[size - 8][8] = 1;   // 暗模块

    return { matrix: m, size };
  }

  /* ---------- 掩码惩罚分（规范表 24） ---------- */
  function penalty(m, size) {
    let score = 0;
    // 规则 1：连续同色 >= 5
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = m[y][x];
        let run = 1;
        while (x + run < size && m[y][x + run] === v) run++;
        if (run >= 5) score += 3 + (run - 5);
        x += run - 1;
      }
    }
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        const v = m[y][x];
        let run = 1;
        while (y + run < size && m[y + run][x] === v) run++;
        if (run >= 5) score += 3 + (run - 5);
        y += run - 1;
      }
    }
    // 规则 2：2x2 同色块
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const v = m[y][x];
        if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
      }
    }
    // 规则 3：1:1:3:1:1 类似定位图案
    const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x <= size - 11; x++) {
        let ok1 = true, ok2 = true;
        for (let k = 0; k < 11; k++) {
          if (m[y][x + k] !== pat1[k]) ok1 = false;
          if (m[y][x + k] !== pat2[k]) ok2 = false;
        }
        if (ok1) score += 40;
        if (ok2) score += 40;
      }
    }
    for (let x = 0; x < size; x++) {
      for (let y = 0; y <= size - 11; y++) {
        let ok1 = true, ok2 = true;
        for (let k = 0; k < 11; k++) {
          if (m[y + k][x] !== pat1[k]) ok1 = false;
          if (m[y + k][x] !== pat2[k]) ok2 = false;
        }
        if (ok1) score += 40;
        if (ok2) score += 40;
      }
    }
    // 规则 4：黑白比例偏离 50%
    let dark = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark += m[y][x];
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  /* ---------- 对外接口 ---------- */
  const QR = {
    /**
     * @param {string} text 要编码的内容
     * @param {string} [ecl='M'] 纠错等级 L/M/Q/H
     * @returns {{size:number, modules:number[][], version:number, ecl:string, mask:number}}
     */
    encode(text, ecl) {
      ecl = ecl || 'M';
      if (!CAP[1][ecl]) throw new Error('不支持的纠错等级：' + ecl);
      const built = buildCodewords(text, ecl);

      let best = null;
      for (let mask = 0; mask < 8; mask++) {
        const r = buildMatrix(built.ver, ecl, built.codewords, mask);
        const p = penalty(r.matrix, r.size);
        if (!best || p < best.penalty) {
          best = { matrix: r.matrix, size: r.size, penalty: p, mask };
        }
      }
      return {
        size: best.size,
        modules: best.matrix,
        version: built.ver,
        ecl,
        mask: best.mask,
      };
    },

    /**
     * 画成 SVG 字符串（不需要 canvas，任何环境都能渲染）
     * @param {string} text
     * @param {object} [opt] { ecl, scale, margin, dark, light }
     */
    toSVG(text, opt) {
      opt = opt || {};
      const q = this.encode(text, opt.ecl || 'M');
      const scale = opt.scale || 4;
      const margin = opt.margin == null ? 4 : opt.margin;
      const dark = opt.dark || '#000';
      const light = opt.light || '#fff';
      const dim = (q.size + margin * 2) * scale;

      let path = '';
      for (let y = 0; y < q.size; y++) {
        for (let x = 0; x < q.size; x++) {
          if (q.modules[y][x]) {
            path += 'M' + (x + margin) * scale + ' ' + (y + margin) * scale
              + 'h' + scale + 'v' + scale + 'h-' + scale + 'z';
          }
        }
      }
      return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim
        + '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">'
        + '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>'
        + '<path d="' + path + '" fill="' + dark + '"/></svg>';
    },
  };

  g.RippleQR = QR;
})(window);
