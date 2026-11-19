/* 收據上的「大章」→ 讀統編（使用者 2026-11-18：「收據要去判斷大章填入統編及廠商名稱」）
 * 手寫的「免用統一發票收據」沒有 QR code、也沒有印出來的賣方統編，賣方資料只在蓋的大章裡（章上有公司名稱、統一編號、負責人、電話、地址）。
 * 做法：①依顏色找章（藍色或紅色墨水、字很密的那一塊）；②只留章的墨水顏色（去掉紅色表格線、手寫的別種顏色）；
 *       ③章常常蓋歪，所以轉幾個小角度（±3、±6 度）、每個角度橫著切成幾條，每條只認數字，找出「剛好 8 碼、而且通過統編檢查碼」的數字投票；
 *       ④得票最多的就是統編；廠商名稱靠統編去查（章上弧形排列的名稱文字辨識讀不準，只當參考）。
 * 2026-11-19（使用者連說「收據辨識統編還不完全」）用使用者的 5 張真實收據實測後補強：
 *   ⑤藍墨水「優勢圖」（B−R 越大越黑，扣掉紙張色偏）：淡藍／青色的章、細瘦的數字、章旁的黑字／紅線／鉛筆字都不會干擾；整塊章直接給文字辨識（只認數字）讀，比切行準很多；
 *   ⑥章躺著（照片歪 90／270／180 度）時，優勢圖轉向再讀；⑦找章的藍色判斷也加上優勢（淡色章不再被當成「墨水不夠密」）。
 * 純函式＋畫布，Node 也能測（開發工具/test-stamp.cjs，用 setCanvasFactory 換成 Node 的畫布）。文字辨識由呼叫的人傳進來（ocrDigits），這裡不載辨識引擎。 */
(function (root) {
  'use strict';

  var mkCanvas = function (w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  function setCanvasFactory(f) { mkCanvas = f; }

  function hsv(r, g, b) {
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    return { h: h, s: mx ? d / mx : 0, v: mx / 255 };
  }
  // 顏色分類：藍／紫墨水（色相 190～285）、紅墨水（色相 ≥ 340 或 ≤ 20）
  function inkClass(r, g, b, sat) {
    var p = hsv(r, g, b); if (p.s <= sat || p.v <= 0.18 || p.v >= 0.96) return 0;
    if (p.h >= 190 && p.h <= 285) return 1;
    if (p.h >= 340 || p.h <= 20) return 2;
    return 0;
  }

  // 紙張色偏：亮像素（紅色 > 170）的 B−R 中間值（白紙在偏冷／偏暖的光線下會有一點色偏，算「優勢」時要扣掉）
  function paperTint(d, n) {
    var a = []; for (var i = 0; i < n; i += 5) if (d[i * 4] > 170) a.push(d[i * 4 + 2] - d[i * 4]);
    if (!a.length) return 0; a.sort(function (x, y) { return x - y; }); return a[a.length >> 1];
  }

  // ---- 找章：回傳候選（依密度由高到低）[{color:'blue'|'red', box:{x,y,w,h}（原圖座標）, density}] ----
  function find(canvas) {
    var W0 = canvas.width, H0 = canvas.height, k = Math.min(1, 800 / Math.max(W0, H0)), W = Math.max(1, Math.round(W0 * k)), H = Math.max(1, Math.round(H0 * k));
    var c = mkCanvas(W, H), g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.drawImage(canvas, 0, 0, W, H);
    var d = g.getImageData(0, 0, W, H).data, masks = { blue: new Uint8Array(W * H), red: new Uint8Array(W * H) }, faint = { blue: new Uint8Array(W * H), red: new Uint8Array(W * H) };
    var tint = paperTint(d, W * H);   // 紙張的色偏（B−R 的中間值）
    for (var i = 0; i < W * H; i++) {
      var dom = d[i * 4 + 2] - d[i * 4] - tint;   // 藍墨水優勢：藍多於紅（黑字、紅線、鉛筆字、白紙都接近 0）
      var cl = inkClass(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], 0.30); if (cl === 1 || (dom >= 30 && d[i * 4] < 225)) masks.blue[i] = 1; else if (cl === 2) masks.red[i] = 1;
      var cf = inkClass(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], 0.17); if (cf === 1 || (dom >= 16 && d[i * 4] < 235)) faint.blue[i] = 1; else if (cf === 2) faint.red[i] = 1;
    }
    var out = [];
    ['blue', 'red'].forEach(function (color) {
      var m = masks[color], S = new Int32Array((W + 1) * (H + 1)), y, x;
      for (y = 0; y < H; y++) { var row = 0; for (x = 0; x < W; x++) { row += m[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; } }
      var sum = function (x0, y0, x1, y1) { return S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0]; };
      var seed = null;
      [0.12, 0.16, 0.20, 0.26, 0.32].forEach(function (fw) {
        [0.7, 0.85, 1.0, 1.2, 1.4].forEach(function (asp) {
          var w = Math.round(W * fw), h = Math.round(w * asp); if (h >= H || w >= W) return;
          for (var yy = 0; yy + h <= H; yy += 6) for (var xx = 0; xx + w <= W; xx += 6) { var den = sum(xx, yy, xx + w, yy + h) / (w * h); if (!seed || den > seed.den) seed = { x: xx, y: yy, w: w, h: h, den: den }; }
        });
      });
      if (!seed || seed.den < 0.12) return;   // 墨水不夠密：不是章
      // 往外長：每邊 6 像素厚的條帶還有墨水（密度 ≥ 0.06）就繼續長，最多長到種子的 2.2 倍（章外圈的弧形字、邊框要包進來）
      var b = { x0: seed.x, y0: seed.y, x1: seed.x + seed.w, y1: seed.y + seed.h }, T = 6, th = 0.06, limW = seed.w * 2.2, limH = seed.h * 2.2;
      for (var it = 0; it < 80; it++) {
        var moved = false, bw = b.x1 - b.x0, bh = b.y1 - b.y0;
        if (b.x0 - T >= 0 && bw < limW && sum(b.x0 - T, b.y0, b.x0, b.y1) / (T * bh) >= th) { b.x0 -= 3; moved = true; }
        if (b.x1 + T <= W && bw < limW && sum(b.x1, b.y0, b.x1 + T, b.y1) / (T * bh) >= th) { b.x1 += 3; moved = true; }
        if (b.y0 - T >= 0 && bh < limH && sum(b.x0, b.y0 - T, b.x1, b.y0) / (T * (b.x1 - b.x0)) >= th) { b.y0 -= 3; moved = true; }
        if (b.y1 + T <= H && bh < limH && sum(b.x0, b.y1, b.x1, b.y1 + T) / (T * (b.x1 - b.x0)) >= th) { b.y1 += 3; moved = true; }
        if (!moved) break;
      }
      // 另一種長法：把墨水膨脹一點（字與字、字與外框連起來）、從種子出發找連在一起的整塊，章再大也能包進來；太大（可能連到旁邊的手寫字）就不採用，退回上面的長法
      var fm = faint[color], S2 = new Int32Array((W + 1) * (H + 1));
      for (y = 0; y < H; y++) { var row2 = 0; for (x = 0; x < W; x++) { row2 += fm[y * W + x]; S2[(y + 1) * (W + 1) + x + 1] = S2[y * (W + 1) + x + 1] + row2; } }
      var r = Math.max(3, Math.round(W * 0.012)), dil = new Uint8Array(W * H), cnt;
      for (y = 0; y < H; y++) for (x = 0; x < W; x++) { var x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(W, x + r + 1), y1 = Math.min(H, y + r + 1); cnt = S2[y1 * (W + 1) + x1] - S2[y0 * (W + 1) + x1] - S2[y1 * (W + 1) + x0] + S2[y0 * (W + 1) + x0]; if (cnt > 1) dil[y * W + x] = 1; }
      var seen = new Uint8Array(W * H), stack = [], bx0 = W, by0 = H, bx1 = 0, by1 = 0;
      for (y = seed.y; y < seed.y + seed.h; y++) for (x = seed.x; x < seed.x + seed.w; x++) if (fm[y * W + x]) { var id0 = y * W + x; if (!seen[id0]) { seen[id0] = 1; stack.push(id0); } }
      while (stack.length) {
        var p = stack.pop(), px = p % W, py = (p / W) | 0;
        if (fm[p]) { if (px < bx0) bx0 = px; if (px > bx1) bx1 = px; if (py < by0) by0 = py; if (py > by1) by1 = py; }
        var nb = [px > 0 ? p - 1 : -1, px < W - 1 ? p + 1 : -1, py > 0 ? p - W : -1, py < H - 1 ? p + W : -1];
        for (var q = 0; q < 4; q++) { var n = nb[q]; if (n >= 0 && !seen[n] && dil[n]) { seen[n] = 1; stack.push(n); } }
      }
      var cw = bx1 - bx0 + 1, ch = by1 - by0 + 1;
      var cfill = bx1 > bx0 ? (S2[(by1 + 1) * (W + 1) + bx1 + 1] - S2[by0 * (W + 1) + bx1 + 1] - S2[(by1 + 1) * (W + 1) + bx0] + S2[by0 * (W + 1) + bx0]) / (cw * ch) : 0, asp = ch / Math.max(1, cw);
      // 整塊的大小要合理：不超過照片的 35%、字夠密（墨水占比 ≥ 0.10，連到一大片手寫字的會稀疏）、長寬比不離譜、而且比種子大
      // 還要比「往外長」那一塊不稀疏太多：章旁邊有手寫字（例如章右邊一整排藍筆批註）連到章時，膨脹後的整塊會把手寫字一起包進來（變成又高又稀疏、讀的是手寫字不是章）；
      // 這時整塊的墨水占比會掉到往外長那塊的 75% 以下 → 不採用整塊，用往外長那塊（使用者 2026-11-19：「收據辨識統編還不完全」，實測 4000×3000 原圖：整塊 237×352、占比 0.13，往外長那塊 192×148、占比 0.23 才是真正的章）
      var growFill = sum(b.x0, b.y0, b.x1, b.y1) / Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0)), growBox = { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }, alt = null;
      if (bx1 > bx0 && cw * ch <= W * H * 0.35 && cfill >= 0.10 && cfill >= growFill * 0.75 && asp >= 0.45 && asp <= 2.3 && cw >= seed.w && ch >= seed.h) { b = { x0: bx0, y0: by0, x1: bx1 + 1, y1: by1 + 1 }; alt = growBox; }   // 採用整塊時，把「往外長」那塊留作備用（整塊讀不到統編時再試它）
      var bw2 = b.x1 - b.x0, bh2 = b.y1 - b.y0, inkN = sum(b.x0, b.y0, b.x1, b.y1);
      out.push({ color: color, density: seed.den, fill: inkN / (bw2 * bh2), box: { x: Math.round(b.x0 / k), y: Math.round(b.y0 / k), w: Math.round(bw2 / k), h: Math.round(bh2 / k) }, alt: alt ? { x: Math.round(alt.x0 / k), y: Math.round(alt.y0 / k), w: Math.round((alt.x1 - alt.x0) / k), h: Math.round((alt.y1 - alt.y0) / k) } : null });
    });
    // 章的樣子：夠大（寬至少是照片的 14%）、不是實心的小私章（墨水占比 ≤ 0.5）；候選依面積大到小
    return out.filter(function (c) { return c.box.w >= W0 * 0.14 && c.fill <= 0.42; }).sort(function (a, b) { return b.box.w * b.box.h - a.box.w * a.box.h; });
  }

  // ---- 只留章墨水顏色的黑白圖（墨水＝黑、其他＝白），放大／縮小到長邊約 1200 像素 ----
  function inkImage(canvas, box, color) {
    var W = canvas.width, H = canvas.height, padX = Math.round(box.w * 0.18), padY = Math.round(box.h * 0.15);   // 找到的範圍常常只框到章裡面最密的那塊（外圈與數字最後一碼可能在框外），往外多留一圈
    var cx = Math.max(0, box.x - padX), cy = Math.max(0, box.y - padY), cw = Math.min(W - cx, box.w + 2 * padX), ch = Math.min(H - cy, box.h + 2 * padY);
    var t = mkCanvas(cw, ch), tg = t.getContext('2d'); tg.fillStyle = '#fff'; tg.fillRect(0, 0, cw, ch); tg.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
    var id = tg.getImageData(0, 0, cw, ch), d = id.data, want = color === 'red' ? 2 : 1;   // 舊的切行／切條方法用這個硬分類的黑白圖（低解析度小章靠它）；淡藍章用上面的優勢圖整塊讀
    for (var i = 0; i < cw * ch; i++) { var v = inkClass(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], 0.22) === want ? 0 : 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
    tg.putImageData(id, 0, 0);
    var up = Math.max(0.5, Math.min(4, 1200 / Math.max(cw, ch)));
    return { canvas: t, w: cw, h: ch, up: up };
  }
  // ---- 藍墨水優勢圖：把章（加外框）切出來，B−R 越大越黑（扣掉紙張色偏）→ 灰階圖，可轉 q×90 度；縮放到長邊約 longSide 像素 ----
  function domCrop(canvas, box, q, longSide, lo, hi) {
    var W = canvas.width, H = canvas.height, padX = Math.round(box.w * 0.12), padY = Math.round(box.h * 0.12);
    var cx = Math.max(0, box.x - padX), cy = Math.max(0, box.y - padY), cw = Math.max(1, Math.min(W - cx, box.w + 2 * padX)), ch = Math.max(1, Math.min(H - cy, box.h + 2 * padY));
    var sc = Math.max(0.4, Math.min(3, (longSide || 1800) / Math.max(cw, ch))), tw = Math.max(1, Math.round(cw * sc)), th = Math.max(1, Math.round(ch * sc));
    var t = mkCanvas(tw, th), g = t.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, tw, th); g.imageSmoothingQuality = 'high'; g.drawImage(canvas, cx, cy, cw, ch, 0, 0, tw, th);
    var id = g.getImageData(0, 0, tw, th), d = id.data, tint = paperTint(d, tw * th), LO = lo == null ? 8 : lo, HI = hi == null ? 58 : hi;
    for (var i = 0; i < tw * th; i++) { var v = 255 - Math.max(0, Math.min(255, (d[i * 4 + 2] - d[i * 4] - tint - LO) * 255 / (HI - LO))); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = Math.round(v); d[i * 4 + 3] = 255; }
    g.putImageData(id, 0, 0);
    q = ((q || 0) % 4 + 4) % 4; if (!q) return t;
    var ow = q % 2 ? th : tw, oh = q % 2 ? tw : th, o = mkCanvas(ow, oh), og = o.getContext('2d'); og.fillStyle = '#fff'; og.fillRect(0, 0, ow, oh); og.translate(ow / 2, oh / 2); og.rotate(q * Math.PI / 2); og.drawImage(t, -tw / 2, -th / 2);
    return o;
  }
  function rotated(ink, angle) {
    var R = Math.ceil(Math.hypot(ink.w, ink.h) * ink.up), c = mkCanvas(R, R), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, R, R); g.imageSmoothingQuality = 'high'; g.translate(R / 2, R / 2); g.rotate(angle * Math.PI / 180);
    g.drawImage(ink.canvas, -ink.w * ink.up / 2, -ink.h * ink.up / 2, ink.w * ink.up, ink.h * ink.up);
    return { canvas: c, R: R, y0: Math.round((R - ink.h * ink.up) / 2), y1: Math.round((R + ink.h * ink.up) / 2) };
  }


  // ---- 字塊：把章的黑白圖裡連在一起的墨水分成一個一個字塊（8 方向連通），記每塊的範圍與中心 ----
  function components(ink) {
    var w = ink.w, h = ink.h, d = ink.canvas.getContext('2d').getImageData(0, 0, w, h).data, seen = new Uint8Array(w * h), comps = [], stack = [];
    for (var s = 0; s < w * h; s++) {
      if (seen[s] || d[s * 4] >= 128) continue;
      var x0 = w, x1 = 0, y0 = h, y1 = 0, area = 0, sx = 0, sy = 0; seen[s] = 1; stack.length = 0; stack.push(s);
      while (stack.length) {
        var p = stack.pop(), px = p % w, py = (p / w) | 0; area++; sx += px; sy += py;
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue; var nx = px + dx, ny = py + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          var n = ny * w + nx; if (!seen[n] && d[n * 4] < 128) { seen[n] = 1; stack.push(n); }
        }
      }
      comps.push({ x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0 + 1, h: y1 - y0 + 1, area: area, cx: sx / area, cy: sy / area });
    }
    return comps;
  }
  // 找最像「一行大字」的幾行：試幾個角度把字塊中心轉平，依高度相近的分成一行；回傳 [{angle（這一行順時針歪了幾度）, comps, medH, score}]，分數高的在前
  function bigRows(ink, maxRows) {
    var H = ink.h, W = ink.w;
    var cs = components(ink).filter(function (c) { return c.area >= Math.max(12, H * H * 0.0004) && c.h >= H * 0.07 && c.h <= H * 0.45 && c.w <= W * 0.3 && c.w >= H * 0.015; });
    if (cs.length < 5) return [];
    var best = [];
    for (var ang = -10; ang <= 10; ang += 2) {
      var a = ang * Math.PI / 180, cs2 = cs.map(function (c) { return { c: c, ry: -c.cx * Math.sin(a) + c.cy * Math.cos(a) }; }).sort(function (p, q) { return p.ry - q.ry; });
      var rows = [], cur = null;
      cs2.forEach(function (e) {
        if (cur && Math.abs(e.ry - cur.ry) <= Math.max(6, cur.medH * 0.55)) { cur.items.push(e); cur.ry = cur.items.reduce(function (s, x) { return s + x.ry; }, 0) / cur.items.length; cur.medH = median(cur.items.map(function (x) { return x.c.h; })); }
        else { cur = { items: [e], ry: e.ry, medH: e.c.h }; rows.push(cur); }
      });
      rows.forEach(function (r) { if (r.items.length >= 5) best.push({ angle: ang, comps: r.items.map(function (x) { return x.c; }), medH: r.medH, score: r.items.length * r.medH, ry: r.ry }); });
    }
    best.sort(function (p, q) { return q.score - p.score; });
    var out = [];   // 相近的（同一行在不同角度重複出現）只留分數最高的
    best.forEach(function (r) { if (!out.some(function (o) { return Math.abs(o.comps[0].cy - r.comps[0].cy) < o.medH && Math.abs(o.comps[0].cx - r.comps[0].cx) < o.medH * 2; })) out.push(r); });
    return out.slice(0, maxRows || 3);
  }
  function median(a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s[s.length >> 1]; }
  // 一行字塊 → 擺平（用字塊中心做直線擬合求歪了幾度）後切出這一行、放大到字高約 64 像素的黑白小圖
  function rowImage(ink, row, extra) {
    var n = row.comps.length, mx = 0, my = 0, i; row.comps.forEach(function (c) { mx += c.cx; my += c.cy; }); mx /= n; my /= n;
    var sxx = 0, sxy = 0; row.comps.forEach(function (c) { sxx += (c.cx - mx) * (c.cx - mx); sxy += (c.cx - mx) * (c.cy - my); });
    var tilt = sxx ? Math.atan(sxy / sxx) * 180 / Math.PI : 0, theta = -(tilt + (extra || 0)), rot = rotated(ink, theta), a = theta * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
    var ymin = 1e9, ymax = -1e9, xmin = 1e9, xmax = -1e9;
    row.comps.forEach(function (c) { [[c.x0, c.y0], [c.x1, c.y0], [c.x0, c.y1], [c.x1, c.y1]].forEach(function (p) { var px = p[0] - ink.w / 2, py = p[1] - ink.h / 2, X = (px * cs - py * sn) * ink.up + rot.R / 2, Y = (px * sn + py * cs) * ink.up + rot.R / 2; if (Y < ymin) ymin = Y; if (Y > ymax) ymax = Y; if (X < xmin) xmin = X; if (X > xmax) xmax = X; }); });
    var hh = ymax - ymin, padY = hh * 0.45, padX = hh * 0.9, cx0 = Math.max(0, Math.round(xmin - padX)), cx1 = Math.min(rot.R, Math.round(xmax + padX)), cy0 = Math.max(0, Math.round(ymin - padY)), cy1 = Math.min(rot.R, Math.round(ymax + padY));
    var sc = Math.max(0.5, Math.min(3, 64 / Math.max(8, row.medH * ink.up))), cw = Math.max(1, cx1 - cx0), ch = Math.max(1, cy1 - cy0), o = mkCanvas(Math.round(cw * sc), Math.round(ch * sc)), og = o.getContext('2d');
    og.fillStyle = '#fff'; og.fillRect(0, 0, o.width, o.height); og.imageSmoothingQuality = 'high'; og.drawImage(rot.canvas, cx0, cy0, cw, ch, 0, 0, o.width, o.height);
    return o;
  }

  // 一段辨識文字 → [[8碼, 票數]]：非數字隔開成數字串；剛好 8 碼＝2 票；9～11 碼的長串（旁邊的圖案、邊框常被多讀成一兩碼）裡每個連續 8 碼＝1 票
  function digitVotes(text) {
    var out = [], gs = String(text || '').match(/\d{8,11}/g) || [];
    gs.forEach(function (g) { if (g.length === 8) out.push([g, 2]); else for (var i = 0; i + 8 <= g.length; i++) out.push([g.slice(i, i + 8), 1]); });
    return out;
  }
  // 辨識出的文字裡「剛好 8 碼」的數字（用非數字隔開），例如「85868241」；電話 06-5894899 是 9 碼、手機 10 碼，不會被當成統編
  function groups8(text) { return (String(text || '').match(/(?<!\d)\d{8}(?!\d)/g) || []); }

  // ---- 主流程：ocrDigits(canvas) → Promise<文字>（只認 0-9 與 -，單行模式）；taxOk(8碼)→是否通過統編檢查碼 ----
  // 回傳 {taxId, votes:{8碼:票數}, sure, box, color, tried}；沒讀到回傳 taxId ''
  async function readStamp(canvas, ocrDigits, taxOk, opt) {
    opt = opt || {};
    var base = (opt.finder || find)(canvas).slice(0, opt.maxCandidates || 2), cands = [], tried = [], exclude = opt.exclude || [];
    base.forEach(function (c) { cands.push(c); if (c.alt) cands.push({ color: c.color, density: c.density, fill: c.fill, box: c.alt, alt: null }); });   // 整塊讀不到統編 → 再試「往外長」那塊（只有失敗時才多花時間）
    for (var ci = 0; ci < cands.length; ci++) {
      var cand = cands[ci], ink = inkImage(canvas, cand.box, cand.color), votes = {}, strong = {}, calls = 0;
      // 票數：完全讀到 8 碼＝2 票（strong＋1）、9～11 碼長串裡的連續 8 碼＝1 票（多半是旁邊的字被多讀成一兩碼，不算 strong）
      var addV = function (txt) { digitVotes(txt).forEach(function (v) { if (taxOk(v[0]) && exclude.indexOf(v[0]) < 0) { votes[v[0]] = (votes[v[0]] || 0) + v[1]; if (v[1] === 2) strong[v[0]] = (strong[v[0]] || 0) + 1; } }); };
      // 方法零（藍色章）：藍墨水優勢圖整塊直接讀（psm 6／12，只認數字；縮放大小各讀一次）。沒讀到才把圖轉 90／270／180 度再讀（章躺著的收據照片）
      if (cand.color === 'blue' && opt.dom !== false) {
        var addVotes = addV;
        var sureNow = function () { var ks = Object.keys(votes).sort(function (a, b) { return votes[b] - votes[a]; }); return ks.length && votes[ks[0]] >= 6 && (ks.length === 1 || votes[ks[1]] <= votes[ks[0]] / 2); };
        // [長邊像素, psm, 低門檻 LO, 高門檻 HI]：LO/HI 越小筆畫越粗。實測 4 張真實收據：淡藍章／歪躺章用 (4,40) 最準、橢圓章小字用 (8,58)＋psm 11 最準 → 兩種粗細、幾種縮放與 psm 交叉投票
        var variants = [[1800, '6', 4, 40], [1800, '6', 8, 58], [1200, '6', 4, 40], [1800, '11', 8, 58], [2600, '6', 4, 40], [1800, '12', 8, 58], [1200, '11', 8, 58], [2600, '12', 4, 40]];
        var turnVariants = [[1800, '6', 4, 40], [2600, '6', 4, 40], [1200, '6', 4, 40], [2600, '12', 4, 40]];
        var turns = opt.turns || [0, 1, 3, 2];
        for (var ti = 0; ti < turns.length && !Object.keys(votes).length; ti++) {
          var vs = turns[ti] ? turnVariants : variants;   // 轉向（章躺著）的只試前幾種（省時間）
          for (var vi = 0; vi < vs.length && !sureNow(); vi++) {
            var dc = domCrop(canvas, cand.box, turns[ti], vs[vi][0], vs[vi][2], vs[vi][3]); addVotes(await ocrDigits(dc, vs[vi][1])); calls++;
          }
        }
      }
      // 方法一：找出章裡「字最大的那幾行」（統編通常是章上最大的數字），擺平、單獨切出來，只認數字，微調角度各讀一次
      // 方法零（優勢圖）已經很有把握（至少兩次完全讀到同一個、而且遠勝第二名）→ 不再跑舊的切行／切條方法（它們在淡藍章上會系統性讀錯，例如把 6 讀成 8 還拿到高票）；
      // 方法零只有零星一兩票（可能是亂讀剛好通過檢查碼，低解析度小章常這樣）→ 再跑舊方法，兩邊的票加在一起，兩種方法都讀到的會勝出
      var domKeys = Object.keys(votes).sort(function (a, b) { return votes[b] - votes[a]; }), domTrusted = domKeys.length > 0 && votes[domKeys[0]] >= 3 && (domKeys.length === 1 || votes[domKeys[1]] <= votes[domKeys[0]] / 2);   // 3 票＝至少兩次讀到（一次完全讀到＝2 票、長串裡的連續 8 碼＝1 票）
      var rows = [];
      if (!domTrusted) try { rows = bigRows(ink, 3); } catch (e) { rows = []; }
      for (var ri = 0; ri < rows.length; ri++) {
        [0, -2, 2].forEach(function () { });
        var extras = [0, -2, 2];
        for (var ei = 0; ei < extras.length; ei++) {
          var rimg = rowImage(ink, rows[ri], extras[ei]);
          for (var pm = 0; pm < 2; pm++) { var txt0 = await ocrDigits(rimg, pm ? '7' : '8'); calls++; addV(txt0); }
        }
        var k0 = Object.keys(votes).sort(function (a, b) { return votes[b] - votes[a]; });
        if (k0.length && votes[k0[0]] >= 6 && (k0.length === 1 || votes[k0[1]] <= votes[k0[0]] / 2)) break;   // 已經很確定（高票且遠勝第二名）就不再讀別行
      }
      // 方法二（方法一沒讀到統編才用）：橫條切片
      var angles = (domTrusted || (function () { var ks = Object.keys(votes).sort(function (a, b) { return votes[b] - votes[a]; }); return ks.length > 0 && votes[ks[0]] >= 3 && (ks.length === 1 || votes[ks[1]] <= votes[ks[0]] / 2); })()) ? [] : (opt.angles || [0, -3, 3, -6, 6]);   // 已經有把握（≥3 票且遠勝第二名）就不切條   // 方法零或方法一已經有票就不用切條   // 章常蓋歪，轉幾個小角度各試一遍   // 章常蓋歪，轉幾個小角度各試一遍
      for (var ai = 0; ai < angles.length; ai++) {
        var rot = rotated(ink, angles[ai]), sh = Math.round(ink.h * ink.up * (opt.stripFrac || 0.20)), step = Math.max(4, Math.round(ink.h * ink.up * (opt.stepFrac || 0.06)));   // 切成窄條（高度 20%、每次移 6%）：一條裡大多只有一行字，認數字時不會被旁邊的中文字干擾
        for (var y = rot.y0; y + sh <= rot.y1 + 2; y += step) {
          var s = mkCanvas(rot.R, sh), sg = s.getContext('2d'); sg.fillStyle = '#fff'; sg.fillRect(0, 0, rot.R, sh); sg.drawImage(rot.canvas, 0, y, rot.R, sh, 0, 0, rot.R, sh);
          var txt = await ocrDigits(s, '7'); calls++;
          addV(txt);
        }
        // 已經有一個統編拿到 3 票以上、別的都沒有超過 1 票：很確定了，不再多轉角度（省時間）
        var ks = Object.keys(votes).sort(function (a, b) { return votes[b] - votes[a]; });
        if (ks.length && votes[ks[0]] >= 5 && (ks.length === 1 || votes[ks[1]] <= votes[ks[0]] / 2)) break;
      }
      var keys = Object.keys(votes).sort(function (a, b) { return votes[b] - votes[a]; });
      tried.push({ color: cand.color, density: cand.density, box: cand.box, calls: calls, votes: votes });
      if (keys.length) {
        var top = keys[0], second = keys[1] ? votes[keys[1]] : 0, strong2 = keys[1] ? (strong[keys[1]] || 0) : 0, sure = (votes[top] >= 5 && votes[top] >= second * 2) || ((strong[top] || 0) >= 3 && (strong[top] || 0) >= strong2 * 3), verified = false;
        // 不太確定（得票不夠高、或有票數接近的第二名）：如果呼叫的人給了 opt.verify(8碼)→Promise<是否查得到登記>，依得票順序（最多 3 個）找第一個查得到的；查得到就以它為準（6／8、5／6 這類讀錯的統編，登記裡不會有）
        if (!sure && opt.verify && keys.length) {
          for (var vk = 0; vk < Math.min(3, keys.length); vk++) { var okv = false; try { okv = await opt.verify(keys[vk]); } catch (e) { okv = false; } if (okv) { top = keys[vk]; sure = true; verified = true; break; } }
        }
        return { taxId: top, votes: votes, sure: sure, verified: verified, alts: keys.filter(function (k) { return k !== top; }).slice(0, 3), box: cand.box, color: cand.color, tried: tried };
      }
    }
    return { taxId: '', votes: {}, sure: false, box: null, color: '', tried: tried };
  }

  var api = { _domCrop: domCrop, _paperTint: paperTint, _bigRows: bigRows, _rowImage: rowImage, setCanvasFactory: setCanvasFactory, find: find, inkImage: inkImage, rotated: rotated, groups8: groups8, digitVotes: digitVotes, readStamp: readStamp, inkClass: inkClass };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.StampRead = api;
})(typeof window !== 'undefined' ? window : this);
