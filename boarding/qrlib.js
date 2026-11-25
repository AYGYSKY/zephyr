var QR = (function () {
  // 纠错等级：格式信息里的两位
  const EC_ORD = { L: 1, M: 0, Q: 3, H: 2 };

  // 每块纠错码字数 / 块数（版本 1–10）
  // [版本][等级] = [每块EC码字数, 组1块数, 组1数据码字, 组2块数, 组2数据码字]
  const RS_TABLE = {
    1: { L: [7, 1, 19, 0, 0], M: [10, 1, 16, 0, 0], Q: [13, 1, 13, 0, 0], H: [17, 1, 9, 0, 0] },
    2: { L: [10, 1, 34, 0, 0], M: [16, 1, 28, 0, 0], Q: [22, 1, 22, 0, 0], H: [28, 1, 16, 0, 0] },
    3: { L: [15, 1, 55, 0, 0], M: [26, 1, 44, 0, 0], Q: [18, 2, 17, 0, 0], H: [22, 2, 13, 0, 0] },
    4: { L: [20, 1, 80, 0, 0], M: [18, 2, 32, 0, 0], Q: [26, 2, 24, 0, 0], H: [16, 4, 9, 0, 0] },
    5: { L: [26, 1, 108, 0, 0], M: [24, 2, 43, 0, 0], Q: [18, 2, 15, 2, 16], H: [22, 2, 11, 2, 12] },
    6: { L: [18, 2, 68, 0, 0], M: [16, 4, 27, 0, 0], Q: [24, 4, 19, 0, 0], H: [28, 4, 15, 0, 0] },
    7: { L: [20, 2, 78, 0, 0], M: [18, 4, 31, 0, 0], Q: [18, 2, 14, 4, 15], H: [26, 4, 13, 1, 14] },
    8: { L: [24, 2, 97, 0, 0], M: [22, 2, 38, 2, 39], Q: [22, 4, 18, 2, 19], H: [26, 4, 14, 2, 15] },
    9: { L: [30, 2, 116, 0, 0], M: [22, 3, 36, 2, 37], Q: [20, 4, 16, 4, 17], H: [24, 4, 12, 4, 13] },
    10: { L: [18, 2, 68, 2, 69], M: [26, 4, 43, 1, 44], Q: [24, 6, 19, 2, 20], H: [28, 6, 15, 2, 16] },
  };

  // 对齐图形中心坐标
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  // ---- GF(256) ----
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  function rsGenPoly(n) {
    let p = [1];
    for (let i = 0; i < n; i++) {
      const q = [1, EXP[i]];
      const r = new Array(p.length + 1).fill(0);
      for (let a = 0; a < p.length; a++)
        for (let b = 0; b < q.length; b++) r[a + b] ^= gmul(p[a], q[b]);
      p = r;
    }
    return p;
  }

  function rsEncode(data, ecLen) {
    const gen = rsGenPoly(ecLen);
    const res = new Array(ecLen).fill(0);
    for (const d of data) {
      const factor = d ^ res[0];
      res.shift(); res.push(0);
      for (let i = 0; i < ecLen; i++) res[i] ^= gmul(gen[i + 1], factor);
    }
    return res;
  }

  // ---- UTF-8 ----
  function utf8(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff) {
        const c2 = s.charCodeAt(++i);
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function dataCount(ver, ec) {
    const t = RS_TABLE[ver][ec];
    return t[1] * t[2] + t[3] * t[4];
  }

  function pickVersion(len, ec) {
    for (let v = 1; v <= 10; v++) {
      const cap = dataCount(v, ec) * 8;
      const cciBits = v <= 9 ? 8 : 16;
      if (4 + cciBits + len * 8 <= cap) return v;
    }
    throw new Error("内容太长");
  }

  // ---- 位流 ----
  function buildCodewords(bytes, ver, ec) {
    const cap = dataCount(ver, ec);
    const bits = [];
    const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };

    push(4, 4);                                  // byte mode
    push(bytes.length, ver <= 9 ? 8 : 16);       // 字符数
    for (const b of bytes) push(b, 8);

    const capBits = cap * 8;
    if (bits.length > capBits) throw new Error("溢出");
    for (let i = 0; i < 4 && bits.length < capBits; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    const cw = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let k = 0; k < 8; k++) v = (v << 1) | bits[i + k];
      cw.push(v);
    }
    const pad = [0xec, 0x11];
    let pi = 0;
    while (cw.length < cap) cw.push(pad[pi++ % 2]);
    return cw;
  }

  function interleave(cw, ver, ec) {
    const t = RS_TABLE[ver][ec];
    const ecLen = t[0];
    const blocks = [];
    let o = 0;
    for (let g = 0; g < 2; g++) {
      const cnt = g === 0 ? t[1] : t[3];
      const dlen = g === 0 ? t[2] : t[4];
      for (let i = 0; i < cnt; i++) {
        const d = cw.slice(o, o + dlen); o += dlen;
        blocks.push({ d: d, e: rsEncode(d, ecLen) });
      }
    }
    const maxD = Math.max(...blocks.map(b => b.d.length));
    const out = [];
    for (let i = 0; i < maxD; i++)
      for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
    for (let i = 0; i < ecLen; i++)
      for (const b of blocks) out.push(b.e[i]);
    return out;
  }

  // ---- 矩阵 ----
  function blank(size) {
    return Array.from({ length: size }, () => new Array(size).fill(null));
  }

  function placeFinder(m, r, c) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        let v = 0;
        if (inRing) {
          const edge = dr === 0 || dr === 6 || dc === 0 || dc === 6;
          const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          v = (edge || core) ? 1 : 0;
        }
        m[rr][cc] = v;
      }
    }
  }

  function placeAlign(m, r, c) {
    for (let dr = -2; dr <= 2; dr++)
      for (let dc = -2; dc <= 2; dc++) {
        const v = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0;
        m[r + dr][c + dc] = v;
      }
  }

  function placeTiming(m) {
    const n = m.length;
    for (let i = 8; i < n - 8; i++) {
      if (m[6][i] === null) m[6][i] = (i % 2 === 0) ? 1 : 0;
      if (m[i][6] === null) m[i][6] = (i % 2 === 0) ? 1 : 0;
    }
  }

  function bch15(v) {
    let d = v << 10;
    for (let i = 14; i >= 10; i--) if ((d >> i) & 1) d ^= 0x537 << (i - 10);
    return ((v << 10) | d) ^ 0x5412;
  }

  function placeFormat(m, ec, mask) {
    const n = m.length;
    const bits = bch15((EC_ORD[ec] << 3) | mask);
    // 第一份（左上，含左上竖列）：高位在前
    // 第二份（右上 + 左下）：低位在前 —— 两份是同一个 15 位串的正反序
    for (let i = 0; i < 15; i++) {
      const bHi = (bits >> (14 - i)) & 1;
      const bLo = (bits >> i) & 1;
      if (i < 6) m[8][i] = bHi;
      else if (i === 6) m[8][7] = bHi;
      else if (i === 7) m[8][8] = bHi;
      else if (i === 8) m[7][8] = bHi;
      else m[14 - i][8] = bHi;

      if (i < 8) m[8][n - 1 - i] = bLo;
      else m[n - 15 + i][8] = bLo;
    }
    m[n - 8][8] = 1;   // 固定的暗模块
  }

  function placeVersion(m, ver) {
    if (ver < 7) return;
    const n = m.length;
    let d = ver << 12;
    for (let i = 17; i >= 12; i--) if ((d >> i) & 1) d ^= 0x1f25 << (i - 12);
    const bits = (ver << 12) | d;
    for (let i = 0; i < 18; i++) {
      const b = (bits >> i) & 1;
      const a = Math.floor(i / 3), bb = i % 3;
      m[n - 11 + bb][a] = b;
      m[a][n - 11 + bb] = b;
    }
  }

  function reserve(m, ver) {
    const n = m.length;
    placeFinder(m, 0, 0);
    placeFinder(m, 0, n - 7);
    placeFinder(m, n - 7, 0);
    for (const c of ALIGN[ver]) {
      for (const r of ALIGN[ver]) {
        if (m[r][c] !== null) continue;
        if ((r < 8 && c < 8) || (r < 8 && c > n - 9) || (r > n - 9 && c < 8)) continue;
        placeAlign(m, r, c);
      }
    }
    placeTiming(m);
    // 格式信息区先占位
    for (let i = 0; i < 9; i++) { if (m[8][i] === null) m[8][i] = 0; if (m[i][8] === null) m[i][8] = 0; }
    for (let i = 0; i < 8; i++) { if (m[8][n - 1 - i] === null) m[8][n - 1 - i] = 0; if (m[n - 1 - i][8] === null) m[n - 1 - i][8] = 0; }
    m[n - 8][8] = 1;
    placeVersion(m, ver);
  }

  function isFunction(m, r, c) {
    const n = m.length;
    if (r === 6 || c === 6) return true;
    if (r < 9 && c < 9) return true;
    if (r < 9 && c >= n - 8) return true;
    if (r >= n - 8 && c < 9) return true;
    return false;
  }

  function fillData(m, cw) {
    const n = m.length;
    let bitIdx = 0;
    let up = true;
    for (let col = n - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let k = 0; k < n; k++) {
        const row = up ? n - 1 - k : k;
        for (let d = 0; d < 2; d++) {
          const c = col - d;
          if (m[row][c] !== null) continue;
          let bit = 0;
          if (bitIdx < cw.length * 8) {
            bit = (cw[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
          }
          bitIdx++;
          m[row][c] = bit;
        }
      }
      up = !up;
    }
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ];

  function applyMask(m, mask, skeleton) {
    const n = m.length;
    const out = m.map(row => row.slice());
    for (let r = 0; r < n; r++)
      for (let c = 0; c < n; c++)
        if (skeleton[r][c] === null && MASKS[mask](r, c)) out[r][c] ^= 1;
    return out;
  }

  function penalty(m) {
    const n = m.length;
    let p = 0;
    // 规则 1：连续同色 5+
    for (let r = 0; r < n; r++) {
      let run = 1;
      for (let c = 1; c < n; c++) {
        if (m[r][c] === m[r][c - 1]) run++;
        else { if (run >= 5) p += run - 2; run = 1; }
      }
      if (run >= 5) p += run - 2;
    }
    for (let c = 0; c < n; c++) {
      let run = 1;
      for (let r = 1; r < n; r++) {
        if (m[r][c] === m[r - 1][c]) run++;
        else { if (run >= 5) p += run - 2; run = 1; }
      }
      if (run >= 5) p += run - 2;
    }
    // 规则 2：2×2 同色块
    for (let r = 0; r < n - 1; r++)
      for (let c = 0; c < n - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
      }
    // 规则 3：类探测图形
    const pat = [1, 0, 1, 1, 1, 0, 1];
    for (let r = 0; r < n; r++)
      for (let c = 0; c <= n - 7; c++) {
        let ok = true;
        for (let k = 0; k < 7; k++) if (m[r][c + k] !== pat[k]) { ok = false; break; }
        if (ok) {
          const before = c >= 4 ? [m[r][c - 4], m[r][c - 3], m[r][c - 2], m[r][c - 1]] : null;
          const after = c + 11 <= n ? [m[r][c + 7], m[r][c + 8], m[r][c + 9], m[r][c + 10]] : null;
          if (before && before.every(x => x === 0)) p += 40;
          if (after && after.every(x => x === 0)) p += 40;
        }
      }
    for (let c = 0; c < n; c++)
      for (let r = 0; r <= n - 7; r++) {
        let ok = true;
        for (let k = 0; k < 7; k++) if (m[r + k][c] !== pat[k]) { ok = false; break; }
        if (ok) {
          const before = r >= 4 ? [m[r - 4][c], m[r - 3][c], m[r - 2][c], m[r - 1][c]] : null;
          const after = r + 11 <= n ? [m[r + 7][c], m[r + 8][c], m[r + 9][c], m[r + 10][c]] : null;
          if (before && before.every(x => x === 0)) p += 40;
          if (after && after.every(x => x === 0)) p += 40;
        }
      }
    // 规则 4：黑白比例
    let dark = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) dark += m[r][c];
    const pct = (dark * 100) / (n * n);
    p += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return p;
  }

  function matrix(text, ecName, forceMask) {
    const ec = ecName || "M";
    const bytes = utf8(text);
    const ver = pickVersion(bytes.length, ec);
    const cw = buildCodewords(bytes, ver, ec);
    const full = interleave(cw, ver, ec);

    const size = 17 + 4 * ver;
    const base = blank(size);
    reserve(base, ver);
    // 快照：功能区已填值，数据区仍是 null —— 掩码只翻转 null 处
    const skeleton = base.map(row => row.slice());
    fillData(base, full);

    let best = null, bestP = Infinity;
    for (let mk = 0; mk < 8; mk++) {
      if (forceMask != null && mk !== forceMask) continue;
      const cand = applyMask(base, mk, skeleton);
      placeFormat(cand, ec, mk);
      const p = penalty(cand);
      if (p < bestP) { bestP = p; best = cand; }
    }
    return { size: size, grid: best, version: ver, mask: bestP };
  }

  return { matrix: matrix };
})();
