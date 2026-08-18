/*!
 * qr.js - 依存ライブラリなしの QR コード生成器
 * バイトモード / 誤り訂正レベル M / 型番 1〜10 に対応。
 * 会場に掲示する URL 程度（〜200文字弱）なら十分な容量があります。
 */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * ガロア体 GF(256) — リード・ソロモン符号の計算用
   * ------------------------------------------------------------------ */
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function initTables() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d; // 原始多項式 x^8 + x^4 + x^3 + x^2 + 1
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  // 誤り訂正符号語を n 個生成するための生成多項式
  function generatorPoly(n) {
    var g = [1];
    for (var i = 0; i < n; i++) {
      var next = new Array(g.length + 1).fill(0);
      for (var j = 0; j < g.length; j++) {
        next[j] ^= g[j];
        next[j + 1] ^= gfMul(g[j], EXP[i]);
      }
      g = next;
    }
    return g;
  }

  function rsEncode(data, ecLen) {
    var g = generatorPoly(ecLen);
    var buf = new Array(data.length + ecLen).fill(0);
    for (var i = 0; i < data.length; i++) buf[i] = data[i];
    for (var k = 0; k < data.length; k++) {
      var coef = buf[k];
      if (coef === 0) continue;
      for (var j = 0; j < g.length; j++) buf[k + j] ^= gfMul(g[j], coef);
    }
    return buf.slice(data.length);
  }

  /* ------------------------------------------------------------------ *
   * 型番ごとのブロック構成（誤り訂正レベル M 固定）
   * [ECバイト数/ブロック, グループ1ブロック数, グループ1データ数,
   *  グループ2ブロック数, グループ2データ数]
   * ------------------------------------------------------------------ */
  var BLOCKS_M = {
    1:  [10, 1, 16, 0, 0],
    2:  [16, 1, 28, 0, 0],
    3:  [26, 1, 44, 0, 0],
    4:  [18, 2, 32, 0, 0],
    5:  [24, 2, 43, 0, 0],
    6:  [16, 4, 27, 0, 0],
    7:  [18, 4, 31, 0, 0],
    8:  [22, 2, 38, 2, 39],
    9:  [22, 3, 36, 2, 37],
    10: [26, 4, 43, 1, 44]
  };

  // 位置合わせパターンの中心座標
  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  function dataCodewords(version) {
    var b = BLOCKS_M[version];
    return b[1] * b[2] + b[3] * b[4];
  }

  // その型番でバイトモードとして格納できる最大バイト数
  function byteCapacity(version) {
    var bits = dataCodewords(version) * 8;
    var cci = version <= 9 ? 8 : 16; // 文字数指示子のビット長
    return Math.floor((bits - 4 - cci) / 8);
  }

  function chooseVersion(byteLen) {
    for (var v = 1; v <= 10; v++) {
      if (byteLen <= byteCapacity(v)) return v;
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * ビット列の組み立て
   * ------------------------------------------------------------------ */
  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.put = function (value, length) {
    for (var i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };
  BitBuffer.prototype.toBytes = function () {
    var bytes = [];
    for (var i = 0; i < this.bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | (this.bits[i + j] || 0);
      bytes.push(b);
    }
    return bytes;
  };

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(str));
    var out = [];
    var encoded = unescape(encodeURIComponent(str));
    for (var i = 0; i < encoded.length; i++) out.push(encoded.charCodeAt(i));
    return out;
  }

  function buildCodewords(text, version) {
    var data = utf8Bytes(text);
    var total = dataCodewords(version);
    var cci = version <= 9 ? 8 : 16;

    var bb = new BitBuffer();
    bb.put(0b0100, 4);           // バイトモード
    bb.put(data.length, cci);    // 文字数
    for (var i = 0; i < data.length; i++) bb.put(data[i], 8);

    // 終端符号（最大4ビット）
    var remaining = total * 8 - bb.bits.length;
    bb.put(0, Math.min(4, remaining));
    // バイト境界まで 0 埋め
    while (bb.bits.length % 8 !== 0) bb.bits.push(0);

    var bytes = bb.toBytes();
    var pad = [0xec, 0x11];
    var p = 0;
    while (bytes.length < total) bytes.push(pad[p++ % 2]);

    // ブロック分割 → 誤り訂正 → インターリーブ
    var spec = BLOCKS_M[version];
    var ecLen = spec[0];
    var groups = [];
    var offset = 0;
    var g;
    for (g = 0; g < spec[1]; g++) { groups.push(bytes.slice(offset, offset + spec[2])); offset += spec[2]; }
    for (g = 0; g < spec[3]; g++) { groups.push(bytes.slice(offset, offset + spec[4])); offset += spec[4]; }

    var ecBlocks = groups.map(function (blk) { return rsEncode(blk, ecLen); });

    var maxData = Math.max.apply(null, groups.map(function (b) { return b.length; }));
    var result = [];
    var idx, blockIdx;
    for (idx = 0; idx < maxData; idx++) {
      for (blockIdx = 0; blockIdx < groups.length; blockIdx++) {
        if (idx < groups[blockIdx].length) result.push(groups[blockIdx][idx]);
      }
    }
    for (idx = 0; idx < ecLen; idx++) {
      for (blockIdx = 0; blockIdx < ecBlocks.length; blockIdx++) {
        result.push(ecBlocks[blockIdx][idx]);
      }
    }
    return result;
  }

  /* ------------------------------------------------------------------ *
   * BCH 符号（形式情報・型番情報）
   * ------------------------------------------------------------------ */
  function bch(value, generator, genBits) {
    var v = value << (genBits - 1);
    var genLen = 0;
    var t = generator;
    while (t) { genLen++; t >>>= 1; }
    while (true) {
      var len = 0, u = v;
      while (u) { len++; u >>>= 1; }
      if (len < genLen) break;
      v ^= generator << (len - genLen);
    }
    return v;
  }

  function formatBits(mask) {
    // 誤り訂正レベル M = 0b00
    var data = (0b00 << 3) | mask;
    var value = (data << 10) | bch(data, 0x537, 11);
    return value ^ 0x5412;
  }

  function versionBits(version) {
    return (version << 12) | bch(version, 0x1f25, 13);
  }

  /* ------------------------------------------------------------------ *
   * モジュール配置
   * ------------------------------------------------------------------ */
  function newMatrix(size) {
    var m = [];
    for (var r = 0; r < size; r++) m.push(new Array(size).fill(null));
    return m;
  }

  function placeFunctionPatterns(m, version) {
    var size = m.length;
    var r, c;

    function finder(row, col) {
      for (var dr = -1; dr <= 7; dr++) {
        for (var dc = -1; dc <= 7; dc++) {
          var rr = row + dr, cc = col + dc;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          var inRing = (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) &&
            (dr === 0 || dr === 6 || dc === 0 || dc === 6 ||
             (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
          m[rr][cc] = inRing ? 1 : 0;
        }
      }
    }
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);

    // タイミングパターン
    for (var i = 8; i < size - 8; i++) {
      var bit = i % 2 === 0 ? 1 : 0;
      m[6][i] = bit;
      m[i][6] = bit;
    }

    // 位置合わせパターン
    // 隅の3か所（位置検出パターンと重なる組み合わせ）だけ配置しない。
    // タイミングパターンとは重なってよく、その場合は上書きする（値は一致する）。
    var centers = ALIGN[version];
    var last = centers.length - 1;
    for (var a = 0; a < centers.length; a++) {
      for (var b = 0; b < centers.length; b++) {
        if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) continue;
        var cr = centers[a], cc2 = centers[b];
        for (var dr2 = -2; dr2 <= 2; dr2++) {
          for (var dc2 = -2; dc2 <= 2; dc2++) {
            var ring = Math.max(Math.abs(dr2), Math.abs(dc2));
            m[cr + dr2][cc2 + dc2] = (ring === 1) ? 0 : 1;
          }
        }
      }
    }

    // 常に暗にするモジュール
    m[size - 8][8] = 1;

    // 形式情報の予約領域（後で上書き）
    for (r = 0; r <= 8; r++) if (m[r][8] === null) m[r][8] = 0;
    for (c = 0; c <= 8; c++) if (m[8][c] === null) m[8][c] = 0;
    for (r = size - 8; r < size; r++) if (m[r][8] === null) m[r][8] = 0;
    for (c = size - 8; c < size; c++) if (m[8][c] === null) m[8][c] = 0;

    // 型番情報の予約領域（型番7以上）
    if (version >= 7) {
      for (var k = 0; k < 18; k++) {
        var rr2 = Math.floor(k / 3);
        var cc3 = size - 11 + (k % 3);
        m[rr2][cc3] = 0;
        m[cc3][rr2] = 0;
      }
    }
  }

  function reservedMask(version, size) {
    var probe = newMatrix(size);
    placeFunctionPatterns(probe, version);
    return probe.map(function (row) { return row.map(function (v) { return v !== null; }); });
  }

  function placeData(m, reserved, codewords) {
    var size = m.length;
    var bitIndex = 0;
    var totalBits = codewords.length * 8;
    var upward = true;

    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // 縦のタイミングパターン列はスキップ
      for (var step = 0; step < size; step++) {
        var row = upward ? size - 1 - step : step;
        for (var k = 0; k < 2; k++) {
          var col = right - k;
          if (reserved[row][col]) continue;
          var bit = 0;
          if (bitIndex < totalBits) {
            bit = (codewords[bitIndex >> 3] >>> (7 - (bitIndex & 7))) & 1;
          }
          m[row][col] = bit;
          bitIndex++;
        }
      }
      upward = !upward;
    }
  }

  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
    function (r, c) { return ((((r * c) % 2) + ((r * c) % 3)) % 2) === 0; },
    function (r, c) { return ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0; }
  ];

  function applyMask(matrix, reserved, maskIndex) {
    var size = matrix.length;
    var out = matrix.map(function (row) { return row.slice(); });
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (reserved[r][c]) continue;
        if (MASKS[maskIndex](r, c)) out[r][c] ^= 1;
      }
    }
    return out;
  }

  function writeFormat(m, maskIndex) {
    var size = m.length;
    var bits = formatBits(maskIndex);
    for (var i = 0; i < 15; i++) {
      var bit = (bits >>> i) & 1;
      // 左上
      if (i < 6) m[i][8] = bit;
      else if (i === 6) m[7][8] = bit;
      else if (i === 7) m[8][8] = bit;
      else if (i === 8) m[8][7] = bit;
      else m[8][14 - i] = bit;
      // 右上・左下
      if (i < 8) m[8][size - 1 - i] = bit;
      else m[size - 15 + i][8] = bit;
    }
    m[size - 8][8] = 1;
  }

  function writeVersion(m, version) {
    if (version < 7) return;
    var size = m.length;
    var bits = versionBits(version);
    for (var i = 0; i < 18; i++) {
      var bit = (bits >>> i) & 1;
      var r = Math.floor(i / 3);
      var c = size - 11 + (i % 3);
      m[r][c] = bit;
      m[c][r] = bit;
    }
  }

  /* ------------------------------------------------------------------ *
   * マスク評価（規格の4つの減点ルール）
   * ------------------------------------------------------------------ */
  function penalty(m) {
    var size = m.length;
    var score = 0;
    var r, c, i;

    // ルール1: 同色の連続
    function runPenalty(getter) {
      var total = 0;
      for (var a = 0; a < size; a++) {
        var run = 1;
        for (var b = 1; b < size; b++) {
          if (getter(a, b) === getter(a, b - 1)) {
            run++;
          } else {
            if (run >= 5) total += 3 + (run - 5);
            run = 1;
          }
        }
        if (run >= 5) total += 3 + (run - 5);
      }
      return total;
    }
    score += runPenalty(function (a, b) { return m[a][b]; });
    score += runPenalty(function (a, b) { return m[b][a]; });

    // ルール2: 2x2 の同色ブロック
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    // ルール3: 1:1:3:1:1 の紛らわしいパターン
    var patA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var patB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function matches(line, start, pat) {
      for (var k = 0; k < pat.length; k++) if (line[start + k] !== pat[k]) return false;
      return true;
    }
    for (r = 0; r < size; r++) {
      var rowArr = m[r];
      var colArr = [];
      for (i = 0; i < size; i++) colArr.push(m[i][r]);
      for (c = 0; c + 11 <= size; c++) {
        if (matches(rowArr, c, patA) || matches(rowArr, c, patB)) score += 40;
        if (matches(colArr, c, patA) || matches(colArr, c, patB)) score += 40;
      }
    }

    // ルール4: 明暗の比率の偏り
    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) dark += m[r][c];
    var ratio = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(ratio - 50) / 5) * 10;

    return score;
  }

  /* ------------------------------------------------------------------ *
   * 公開 API
   * ------------------------------------------------------------------ */
  function encode(text) {
    var byteLen = utf8Bytes(text).length;
    var version = chooseVersion(byteLen);
    if (!version) {
      throw new Error('QRコードに入れるには文字数が多すぎます（' + byteLen + 'バイト / 上限 ' + byteCapacity(10) + 'バイト）');
    }
    var size = version * 4 + 17;
    var codewords = buildCodewords(text, version);
    var reserved = reservedMask(version, size);

    var base = newMatrix(size);
    placeFunctionPatterns(base, version);
    placeData(base, reserved, codewords);

    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var candidate = applyMask(base, reserved, mask);
      writeFormat(candidate, mask);
      writeVersion(candidate, version);
      var s = penalty(candidate);
      if (s < bestScore) { bestScore = s; best = candidate; }
    }
    return { size: size, version: version, modules: best };
  }

  /** QR コードを SVG 文字列として返す */
  function toSvg(text, options) {
    var opts = options || {};
    var quiet = opts.quiet === undefined ? 4 : opts.quiet;
    var dark = opts.dark || '#0f172a';
    var light = opts.light || '#ffffff';
    var qr = encode(text);
    var dim = qr.size + quiet * 2;

    var path = [];
    for (var r = 0; r < qr.size; r++) {
      for (var c = 0; c < qr.size; c++) {
        if (qr.modules[r][c]) path.push('M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z');
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" ' +
      'shape-rendering="crispEdges" role="img" aria-label="QRコード">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>' +
      '<path d="' + path.join('') + '" fill="' + dark + '"/></svg>';
  }

  global.QRCode = { encode: encode, toSvg: toSvg, byteCapacity: byteCapacity };
})(window);
