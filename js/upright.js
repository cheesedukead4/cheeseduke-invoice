/* 發票照片「轉正」（使用者 2026-11-18：「若有發票不是正的，你匯入後要先轉正」）
 * 兩件事：①轉向——照片整個橫著、倒著拍（90／180／270 度）；②擺正——照片有點歪（±15 度內）。做完再交給 QR code／文字辨識，存進發票的附件也是轉正後的。
 * 手機拍的照片如果有 EXIF 方向資訊，瀏覽器本來就會自己轉正；這裡處理的是「實際拿橫的、拿倒的、放歪的」。
 *
 * 做法（不需要另外下載模型）：
 *   轉向：先用「文字行的方向」判斷是橫的還是直的（把照片變成黑白，看每一列與每一行的墨水量變化：橫排的字，列與列之間忽高忽低）；
 *         橫的 → 候選 0／180 度，直的 → 候選 90／270 度；分不出來 → 四個都試。再用文字辨識（OCR）在縮小的照片上各試一次，「讀得出來的字最多」的方向就是正的。
 *         正的照片（絕大多數）只要試一次、讀得出夠多的字就不再試別的方向，所以不會多花多少時間。
 *   擺正：在轉向之後，用墨水的投影找「字行最整齊」的角度（-15～+15 度），歪超過約 1.5 度才轉，而且要比不轉明顯整齊才轉，沒把握就不動。
 * 純函式＋畫布，Node 也能測（開發工具/test-upright.cjs，用 setCanvasFactory 換成 Node 的畫布）。OCR 由呼叫的人傳進來（ocrScore），這裡不載辨識引擎。 */
(function (root) {
  'use strict';

  var mkCanvas = function (w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  function setCanvasFactory(f) { mkCanvas = f; }

  // ---- 縮小成灰階 ----
  function grayOf(canvas, maxSide) {
    var W = canvas.width, H = canvas.height, k = Math.min(1, maxSide / Math.max(W, H));
    var w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
    var c = mkCanvas(w, h), g = c.getContext('2d');
    g.imageSmoothingQuality = 'high'; g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(canvas, 0, 0, w, h);
    var d = g.getImageData(0, 0, w, h).data, gray = new Uint8Array(w * h);
    for (var i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000 | 0;
    return { w: w, h: h, gray: gray };
  }

  // ---- 黑白：比周圍暗一截的就是墨水（用積分圖算區域平均，不怕光線不均）----
  function inkMask(G) {
    var w = G.w, h = G.h, gray = G.gray, win = Math.max(9, Math.round(Math.min(w, h) / 24)) | 1, r = win >> 1;
    var S = new Float64Array((w + 1) * (h + 1));
    for (var y = 0; y < h; y++) { var row = 0; for (var x = 0; x < w; x++) { row += gray[y * w + x]; S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + row; } }
    var mask = new Uint8Array(w * h), n = 0;
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        var sum = S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0], mean = sum / ((x1 - x0) * (y1 - y0));
        if (gray[y * w + x] < mean - 14 && gray[y * w + x] < 190) { mask[y * w + x] = 1; n++; }
      }
    }
    return { w: w, h: h, mask: mask, n: n };
  }

  // ---- 文字行是橫的還是直的：列／行的墨水量「忽高忽低」程度 ----
  function rough(p) {
    var m = 0, s = 0, i; for (i = 0; i < p.length; i++) m += p[i]; m /= p.length; if (!m) return 0;
    for (i = 1; i < p.length; i++) s += Math.abs(p[i] - p[i - 1]);
    return s / (p.length - 1) / m;
  }
  function axisOf(M) {
    var w = M.w, h = M.h, rows = new Float64Array(h), cols = new Float64Array(w);
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) if (M.mask[y * w + x]) { rows[y]++; cols[x]++; }
    var rr = rough(rows), cr = rough(cols), ratio = cr > 0 ? rr / cr : 1;
    return { rowRough: rr, colRough: cr, ratio: ratio, axis: ratio >= 1.25 ? 'h' : ratio <= 0.8 ? 'v' : '?' };
  }

  // ---- 歪了幾度：把墨水點依角度投影到「列」，字行最整齊（列與列差最大）的角度 ----
  function tiltOf(M) {
    var w = M.w, h = M.h, pts = [], stride = Math.max(1, Math.floor(M.n / 60000));
    for (var y = 0, c = 0; y < h; y++) for (var x = 0; x < w; x++) if (M.mask[y * w + x] && (c++ % stride === 0)) pts.push(x - w / 2, y - h / 2);
    if (pts.length < 400) return { angle: 0, gain: 1, n: pts.length };
    var span = Math.ceil(Math.sqrt(w * w + h * h)) + 4, hist = new Float64Array(span), half = span / 2;
    function score(deg) {
      var a = deg * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a), i;
      hist.fill(0);
      for (i = 0; i < pts.length; i += 2) { var yy = Math.round(pts[i + 1] * cs - pts[i] * sn + half); if (yy >= 0 && yy < span) hist[yy]++; }
      var s = 0; for (i = 1; i < span; i++) { var d = hist[i] - hist[i - 1]; s += d * d; }
      return s;
    }
    var best = 0, bs = score(0), s0 = bs, deg;
    for (deg = -15; deg <= 15; deg += 1) { var sc = score(deg); if (sc > bs) { bs = sc; best = deg; } }
    var b2 = best; for (deg = best - 1; deg <= best + 1; deg += 0.2) { var sc2 = score(deg); if (sc2 > bs) { bs = sc2; b2 = deg; } }
    return { angle: b2, gain: s0 > 0 ? bs / s0 : 1, n: pts.length / 2 };
  }

  // ---- 轉圖 ----
  function rotate90(canvas, q) {   // q：順時針轉幾個 90 度（0～3）
    q = ((q % 4) + 4) % 4; if (!q) return canvas;
    var W = canvas.width, H = canvas.height, c = q === 2 ? mkCanvas(W, H) : mkCanvas(H, W), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.translate(c.width / 2, c.height / 2); g.rotate(q * Math.PI / 2); g.drawImage(canvas, -W / 2, -H / 2);
    return c;
  }
  function rotateAny(canvas, deg) {   // 順時針轉 deg 度，畫布放大到不切掉內容，空白補白色
    var a = deg * Math.PI / 180, W = canvas.width, H = canvas.height, cs = Math.abs(Math.cos(a)), sn = Math.abs(Math.sin(a));
    var w = Math.ceil(W * cs + H * sn), h = Math.ceil(W * sn + H * cs), c = mkCanvas(w, h), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.imageSmoothingQuality = 'high';
    g.translate(w / 2, h / 2); g.rotate(a); g.drawImage(canvas, -W / 2, -H / 2);
    return c;
  }

  // ---- 轉向：決定要順時針轉幾個 90 度 ----
  // ocrScore(canvas) → Promise<數字>：這張圖「讀得出來的字」有多少（越多越正）。由呼叫的人用 OCR 實作。
  // 回傳 {q, scores, axis, steps}；q＝順時針轉幾個 90 度才會變正（0～3）
  // 實測（7 張真實發票各轉 0／90／180／270 度，縮成長邊 800 像素）：正的方向讀得出 40～130 個字，錯的方向只有 0～4 個，差距很大；
  // 長邊 640 以下字太小，正的也只剩 4～50 個字，不夠用；800 像素每次約 4 秒。
  var GOOD = 25;   // 讀得出的字數達到這個數，就當作這個方向已經夠正，不再試別的方向
  async function pickTurn(canvas, ocrScore, opt) {
    opt = opt || {};
    var A = axisOf(inkMask(grayOf(canvas, 640))), steps = [];
    // 試的順序：文字行看起來是直的 → 先試 90／270；其他先試原樣（絕大多數照片本來就是正的，只要試一次）
    var cand = A.axis === 'v' ? [1, 3, 0, 2] : [0, 1, 3, 2], scores = {};
    var small = grayOf(canvas, opt.ocrSide || 800), base = mkCanvas(small.w, small.h), bg = base.getContext('2d');
    bg.fillStyle = '#fff'; bg.fillRect(0, 0, small.w, small.h); bg.drawImage(canvas, 0, 0, small.w, small.h);
    var bestQ = 0, bestS = -1;
    for (var i = 0; i < cand.length; i++) {
      var q = cand[i], sc = await ocrScore(rotate90(base, q)); scores[q] = sc; steps.push(q + ':' + sc);
      if (sc > bestS) { bestS = sc; bestQ = q; }
      if (sc >= GOOD) break;   // 這個方向讀得出夠多的字：就是它，不再試別的
    }
    // 每個方向都讀得很少（例如整張沒什麼字、或是手寫收據）：沒把握，不轉
    if (bestS < 8) bestQ = 0;
    // 最好的方向要明顯比原樣好才轉（原樣也讀得不少時不要來回誤轉）
    else if (bestQ !== 0 && scores[0] != null && bestS < scores[0] * 2 + 6) bestQ = 0;
    return { q: bestQ, scores: scores, axis: A, steps: steps };
  }

  // ---- 擺正：回傳字行「順時針歪了幾度」（沒把握回傳 0；要轉正就轉負的）----
  function pickTilt(canvas) {
    var G = grayOf(canvas, 560), M = inkMask(G), T = tiltOf(M);
    var use = Math.abs(T.angle) >= 1.5 && T.gain >= 1.12 && Math.abs(T.angle) <= 14.5;
    return { angle: use ? T.angle : 0, raw: T.angle, gain: T.gain };
  }

  // ---- 一次做完 ----
  // 回傳 {canvas, turned（轉了幾度）, tilt（擺正幾度）, info}；沒有要轉的就回傳原本的 canvas
  async function makeUpright(canvas, ocrScore, opt) {
    opt = opt || {};
    var out = { canvas: canvas, turned: 0, tilt: 0, info: {} };
    // opt.turn：呼叫的人已經知道要順時針轉幾個 90 度（例如發票 QR code 的朝向，不用文字辨識）→ 直接用，省下 1～4 次文字辨識
    var tp = (opt.turn === 0 || opt.turn === 1 || opt.turn === 2 || opt.turn === 3) ? { q: opt.turn, via: 'given' } : await pickTurn(canvas, ocrScore, opt); out.info.turn = tp;
    var c = canvas;
    if (tp.q) { c = rotate90(canvas, tp.q); out.turned = tp.q * 90; }
    var tl = pickTilt(c); out.info.tilt = tl;
    if (tl.angle) { c = rotateAny(c, -tl.angle); out.tilt = -tl.angle; }   // 偵測到的是字行順時針歪了幾度，轉回去要轉負的
    out.canvas = c; return out;
  }

  var api = { setCanvasFactory: setCanvasFactory, grayOf: grayOf, inkMask: inkMask, axisOf: axisOf, tiltOf: tiltOf, rotate90: rotate90, rotateAny: rotateAny, pickTurn: pickTurn, pickTilt: pickTilt, makeUpright: makeUpright, GOOD: GOOD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ImageUpright = api;
})(typeof window !== 'undefined' ? window : this);
