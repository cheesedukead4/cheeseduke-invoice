/*
 * 電子發票證明聯 QR code 讀取與解析（EInvoiceQR）
 * ---------------------------------------------------------------
 * 財政部規格：證明聯上有兩個 QR code。
 *   左邊（前 77 碼固定）：發票字軌號碼 10、開立日期 7（民國 yyyMMdd）、隨機碼 4、銷售額 8（十六進位）、
 *     總計額 8（十六進位）、買方統編 8、賣方統編 8、加密驗證資訊 24；之後是「:」分隔的營業人自行使用區、
 *     本碼品目筆數、發票總品目筆數、中文編碼（0 Big5／1 UTF-8／2 Base64）、再接「品名:數量:單價」。
 *   右邊：以「**」開頭，接續其餘品項「品名:數量:單價」。
 * 這支程式負責：從圖片或 PDF 找出 QR code（先用 jsQR，沒找齊左右兩個再用 zxing；兩者都從 CDN 載入）→ 解析 → 對帳（品項合計是否等於發票總計）。
 * QR 沒有賣方名稱，網頁會再用賣方統編去查廠商名稱。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EInvoiceQR = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  var JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
  // 第二道解碼器（zxing-cpp 的 WebAssembly 版）：jsQR 讀不到時才載入，約 1MB。實測手機拍的發票照片，
  // 左邊那個密度較高的 QR code jsQR 讀不到，zxing 放大 2 倍後讀得到
  var ZXING_BASE = 'https://cdn.jsdelivr.net/npm/zxing-wasm@3.0.3/dist/';

  // ---------- 解析 ----------
  function asBytes(x) {
    if (x instanceof Uint8Array) return x;
    if (Array.isArray(x)) return Uint8Array.from(x);
    if (typeof x === 'string') return new TextEncoder().encode(x);
    return new Uint8Array(0);
  }
  function ascii(b, from, to) { var s = ''; for (var i = from; i < to && i < b.length; i++) s += String.fromCharCode(b[i]); return s; }
  // 以 0x3A（:）切開。Big5 的第二個位元組不會落在 0x3A，UTF-8 多位元組也不會，所以直接在位元組層切是安全的
  function splitColon(b, from) {
    var out = [], start = from || 0;
    for (var i = start; i <= b.length; i++) {
      if (i === b.length || b[i] === 0x3A) { out.push(b.subarray(start, i)); start = i + 1; }
    }
    return out;
  }
  function decodeName(bytes, enc) {
    try {
      if (enc === 0) return new TextDecoder('big5').decode(bytes);
      if (enc === 2) {
        var bin = atob(new TextDecoder().decode(bytes).replace(/\s/g, ''));
        var arr = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8').decode(arr);
      }
    } catch (e) { /* 退回下面的 UTF-8 */ }
    return new TextDecoder('utf-8').decode(bytes);
  }
  function num(bytes) { var t = ascii(bytes, 0, bytes.length).trim(); var v = t === '' ? NaN : Number(t); return isFinite(v) ? v : NaN; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function validDate(y, m, d) {
    if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
    var dt = new Date(y, m - 1, d); return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }
  function parseItems(segs, from, enc) {
    var items = [];
    for (var i = from; i + 2 < segs.length; i += 3) {
      var name = decodeName(segs[i], enc).trim(), qty = num(segs[i + 1]), price = num(segs[i + 2]);
      if (!name && isNaN(qty) && isNaN(price)) continue;
      var amount = isNaN(qty) || isNaN(price) ? NaN : Math.round(qty * price * 100) / 100;
      items.push({ name: name.slice(0, 80), qty: qty, price: price, amount: amount });
    }
    return items;
  }
  var HEAD = /^([A-Z]{2}\d{8})(\d{3})(\d{2})(\d{2})([0-9A-Za-z]{4})([0-9A-Fa-f]{8})([0-9A-Fa-f]{8})(\d{8})(\d{8})/;
  function isLeft(b) { return b.length >= 77 && HEAD.test(ascii(b, 0, 77)); }
  function isRight(b) { return b.length >= 2 && b[0] === 0x2A && b[1] === 0x2A; }

  function parseLeft(b) {
    var m = HEAD.exec(ascii(b, 0, 77)); if (!m) return null;
    var y = Number(m[2]) + 1911, mo = Number(m[3]), d = Number(m[4]);
    if (!validDate(y, mo, d)) return null;
    var r = {
      invoiceNo: m[1], invoiceDate: y + '-' + pad(mo) + '-' + pad(d), randomCode: m[5],
      sales: parseInt(m[6], 16), total: parseInt(m[7], 16), buyerId: m[8], sellerId: m[9],
      enc: 1, declaredHere: 0, declaredTotal: 0, items: []
    };
    if (b.length > 77 && b[77] === 0x3A) {
      var segs = splitColon(b, 78); // [自行使用區, 本碼筆數, 總筆數, 編碼, 品名, 數量, 單價, …]
      r.declaredHere = num(segs[1] || new Uint8Array(0)) || 0;
      r.declaredTotal = num(segs[2] || new Uint8Array(0)) || 0;
      var enc = num(segs[3] || new Uint8Array(0)); r.enc = enc === 0 || enc === 2 ? enc : 1;
      r.items = parseItems(segs, 4, r.enc);
    }
    return r;
  }
  function parseRight(b, enc) { return parseItems(splitColon(b, 2), 0, enc); }

  // codes：每個 QR code 的內容（位元組陣列、Uint8Array 或字串）。回傳 null 代表沒有任何電子發票 QR
  function parse(codes) {
    var list = (codes || []).map(asBytes), left = null, rights = [];
    list.forEach(function (b) { if (!left && isLeft(b)) left = parseLeft(b); else if (isRight(b)) rights.push(b); });
    if (!left) return rights.length ? { ok: false, reason: 'only-right' } : null;
    // 一張發票只有一個右邊 QR。同一個 QR 被讀到兩次（內容一樣）只算一次；若讀到內容不同的多個（兩個解碼器對同一個 QR
    // 輸出略有差異），只取品項最多的那個，避免重複計入。同一個 QR 內的相同品項（例如兩罐同款飲料各一行）要保留
    var rightItems = [], seenRight = {};
    rights.forEach(function (b) {
      var key = Array.prototype.join.call(b, ',');
      if (seenRight[key]) return; seenRight[key] = 1;
      var its = parseRight(b, left.enc); if (its.length > rightItems.length) rightItems = its;
    });
    left.items = left.items.concat(rightItems);
    left.ok = true;
    left.hasRight = rights.length > 0;
    left.complete = left.declaredTotal > 0 ? left.items.length >= left.declaredTotal : true;
    return left;
  }

  // ---------- 對帳：把 QR 的品項變成請款項目 ----------
  function sumOf(items) { return items.reduce(function (s, i) { return s + (isNaN(i.amount) ? 0 : i.amount); }, 0); }
  // 規則：品項一律逐項變成請款項目（不放進備註）。品項合計和發票總計對不上時：
  //   品項是未稅金額 → 補一行「營業稅」；合計比總計少 → 補一行差額（品項沒讀完會寫明）；合計比總計多（可能有折扣）→ 不補，
  //   畫面上原本就有「請款合計與發票總計不同」的提醒。請款金額不接受負數，所以多的部分只能請使用者自行調整
  function claimLines(r) {
    var items = (r.items || []).filter(function (i) { return !isNaN(i.amount) && i.name; });
    var total = r.total, sales = r.sales, sum = Math.round(sumOf(items) * 100) / 100;
    var itemsText = (r.items || []).map(function (i) { return i.name + ' ×' + i.qty + ' @' + i.price; }).join('；');
    if (!items.length) return { mode: 'total', lines: [{ description: '發票費用', amount: total }], itemsText: itemsText, note: 'QR code 沒有品項資料，已用發票總計一筆帶入' };
    var lines = items.map(function (i) { return { description: i.name, amount: Math.round(i.amount) }; });
    var lineSum = lines.reduce(function (n, l) { return n + l.amount; }, 0), diff = total - lineSum;
    if (diff === 0) return { mode: 'items', lines: lines, itemsText: itemsText, note: '品項明細取自 QR code，合計與發票總計一致' };
    if (r.complete && total > sales && Math.abs(sum - sales) <= 1 && diff > 0) {
      lines.push({ description: '營業稅', amount: diff });
      return { mode: 'items+tax', lines: lines, itemsText: itemsText, note: '品項為未稅金額，已另加營業稅，合計與發票總計一致' };
    }
    if (diff > 0) {
      var incomplete = !r.complete, label = incomplete ? '其他品項（QR code 未讀完，請核對）' : diff <= 2 ? '尾差' : '差額（品項合計與發票總計不符，請核對）';
      lines.push({ description: label, amount: diff });
      var why = incomplete ? '品項不完整（發票共 ' + r.declaredTotal + ' 項，只讀到 ' + r.items.length + ' 項；右邊的 QR code 可能沒拍到），品項已逐項帶入，差額 ' + diff + ' 元另補一行'
        : diff <= 2 ? '品項合計 ' + lineSum + ' 與發票總計 ' + total + ' 相差 ' + diff + ' 元（四捨五入尾差），已補一行「尾差」'
        : '品項合計 ' + lineSum + ' 與發票總計 ' + total + ' 不一致，品項已逐項帶入，差額 ' + diff + ' 元另補一行';
      return { mode: 'items+gap', lines: lines, itemsText: itemsText, note: why };
    }
    return { mode: 'items+over', lines: lines, itemsText: itemsText, note: '品項合計 ' + lineSum + ' 比發票總計 ' + total + ' 多 ' + (-diff) + ' 元（可能有折扣），品項已逐項帶入，請自行調整金額' };
  }

  // ---------- 讀取圖片／PDF 中的 QR code ----------
  var jsqrPromise = null;
  function ensureJsQR() {
    if (root.jsQR) return Promise.resolve(root.jsQR);
    if (!jsqrPromise) jsqrPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script'); s.src = JSQR_URL; s.async = true;
      s.onload = function () { root.jsQR ? resolve(root.jsQR) : reject(new Error('QR 解碼模組載入失敗')); };
      s.onerror = function () { jsqrPromise = null; s.remove(); reject(new Error('無法載入 QR 解碼模組，請確認網路連線')); };
      document.head.appendChild(s);
    });
    return jsqrPromise;
  }
  var zxingPromise = null;
  function ensureZXing() {
    if (root.ZXingWASM) return Promise.resolve(root.ZXingWASM);
    if (!zxingPromise) zxingPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script'); s.src = ZXING_BASE + 'iife/reader/index.js'; s.async = true;
      s.onload = function () {
        if (!root.ZXingWASM) return reject(new Error('QR 解碼模組載入失敗'));
        root.ZXingWASM.setZXingModuleOverrides({ locateFile: function (path, prefix) { return path.slice(-5) === '.wasm' ? ZXING_BASE + 'reader/' + path : prefix + path; } });
        resolve(root.ZXingWASM);
      };
      s.onerror = function () { zxingPromise = null; s.remove(); reject(new Error('無法載入 QR 解碼模組，請確認網路連線')); };
      document.head.appendChild(s);
    });
    return zxingPromise;
  }
  function newCanvas(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }
  // 找到一個之後，把它在畫面上塗白，再找下一個（發票上有兩個 QR code）
  function mask(d, w, h, loc) {
    var pts = [loc.topLeftCorner, loc.topRightCorner, loc.bottomLeftCorner, loc.bottomRightCorner];
    var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
    var minx = Math.min.apply(null, xs), maxx = Math.max.apply(null, xs), miny = Math.min.apply(null, ys), maxy = Math.max.apply(null, ys);
    var px = (maxx - minx) * 0.12, py = (maxy - miny) * 0.12;
    var x0 = Math.max(0, Math.floor(minx - px)), x1 = Math.min(w - 1, Math.ceil(maxx + px)), y0 = Math.max(0, Math.floor(miny - py)), y1 = Math.min(h - 1, Math.ceil(maxy + py));
    for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) { var k = (y * w + x) * 4; d[k] = d[k + 1] = d[k + 2] = 255; d[k + 3] = 255; }
  }
  // 讀一塊區域。scale 盡量用 1（原始像素）或整數倍：jsQR 對「非整數倍的縮放」很敏感（實測 1.33 倍會讀不到）
  function scanRegion(jsQR, src, sx, sy, sw, sh, scale, inversion, found) {
    var c = newCanvas(sw * scale, sh * scale), ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = scale < 1; // 放大時不平滑，保持方塊邊緣銳利；縮小時才平滑
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    var img = ctx.getImageData(0, 0, c.width, c.height);
    for (var k = 0; k < 4; k++) {
      var r = jsQR(img.data, c.width, c.height, { inversionAttempts: inversion });
      if (!r) break;
      found.push(Uint8Array.from(r.binaryData && r.binaryData.length ? r.binaryData : new TextEncoder().encode(r.data)));
      mask(img.data, c.width, c.height, r.location);
    }
    c.width = c.height = 0;
  }
  // 第二道：zxing。同樣由粗到細，放大一律用整數倍；找齊（左＋右）就停
  async function scanWithZXing(canvas, found, done) {
    var Z = await ensureZXing(), W = canvas.width, H = canvas.height, S = Math.max(W, H);
    // 原始像素（長邊超過 4000 才縮）→ 小圖放大 2 倍 → 大圖切四塊 → 中間橫帶。每一輪先用預設的區域二值化，
    // 沒找齊再用全域直方圖二值化（實測有些照片只有其中一種讀得到）
    var base = S > 4000 ? 4000 / S : 1, passes = [[0, 0, W, H, base]];
    if (S <= 2000) passes.push([0, 0, W, H, 2]);
    else [[0, 0], [0.4, 0], [0, 0.4], [0.4, 0.4]].forEach(function (o) { passes.push([W * o[0], H * o[1], W * 0.6, H * 0.6, Math.min(1, 3000 / (0.6 * S))]); });
    passes.push([W * 0.05, H * 0.2, W * 0.9, H * 0.6, S * 0.9 <= 2000 ? 2 : 1]);
    for (var i = 0; i < passes.length && !done(); i++) {
      var p = passes[i], c = newCanvas(p[2] * p[4], p[3] * p[4]), ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = p[4] < 1; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(canvas, p[0], p[1], p[2], p[3], 0, 0, c.width, c.height);
      var img = ctx.getImageData(0, 0, c.width, c.height);
      for (var j = 0; j < 2 && !done(); j++) {
        try {
          var res = await Z.readBarcodes(img, { formats: ['QRCode'], binarizer: j ? 'GlobalHistogram' : 'LocalAverage', tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, maxNumberOfSymbols: 4 });
          res.forEach(function (r) { if (r.isValid && r.bytes && r.bytes.length) addUnique(found, Uint8Array.from(r.bytes)); });
        } catch (e) { /* 這一輪失敗就換下一輪 */ }
      }
      c.width = c.height = 0;
    }
  }
  function addUnique(list, bytes) { var k = Array.prototype.join.call(bytes, ','); if (!list._seen) list._seen = {}; if (!list._seen[k]) { list._seen[k] = 1; list.push(bytes); } }

  // 由粗到細，找齊（左＋右）就提早結束：
  //  1 原始像素（太大的圖縮到 2600 以內）→ 2 大圖切成四個重疊區塊、各自用原始像素 → 3 縮小一半（QR 很大時）
  //  → 4 小圖放大 2 倍 → 5 中間橫帶 → 6 縮到 0.75 → 7 容許反白 QR
  async function scanCanvas(canvas) {
    var jsQR = await ensureJsQR(), found = [], W = canvas.width, H = canvas.height, S = Math.max(W, H);
    var base = S > 2600 ? 2600 / S : 1, tileScale = Math.min(1, 2600 / (0.6 * S));
    function done() { var r = parse(found); return !!(r && r.ok && r.complete); }
    var passes = [[0, 0, W, H, base, 'dontInvert']];
    if (S > 2000) [[0, 0], [0.4, 0], [0, 0.4], [0.4, 0.4]].forEach(function (o) { passes.push([W * o[0], H * o[1], W * 0.6, H * 0.6, tileScale, 'dontInvert']); });
    passes.push([0, 0, W, H, 0.5 * base, 'dontInvert']);
    if (S < 1400) passes.push([0, 0, W, H, 2, 'dontInvert']);
    passes.push([W * 0.05, H * 0.2, W * 0.9, H * 0.6, Math.min(1, 2600 / (0.9 * S)), 'dontInvert']);
    passes.push([0, 0, W, H, 0.75 * base, 'dontInvert']);
    passes.push([0, 0, W, H, base, 'attemptBoth']);
    for (var i = 0; i < passes.length && !done(); i++) {
      var p = passes[i], tmp = [];
      try { scanRegion(jsQR, canvas, p[0], p[1], p[2], p[3], p[4], p[5], tmp); } catch (e) { /* 這一輪失敗就換下一輪 */ }
      tmp.forEach(function (b) { addUnique(found, b); });
      await new Promise(function (r) { setTimeout(r, 0); }); // 讓畫面有機會更新
    }
    // 第二道：zxing（jsQR 沒找齊左右兩個、或品項不完整時才載入）
    if (!done()) {
      try { await scanWithZXing(canvas, found, done); } catch (e) { console.warn('zxing 解碼失敗', e); }
    }
    // 備援：瀏覽器內建的 BarcodeDetector（Android Chrome 等）。它只給文字，中文品名若是 Big5 可能亂碼
    if (!parse(found) && root.BarcodeDetector) {
      try {
        var codes = await new root.BarcodeDetector({ formats: ['qr_code'] }).detect(canvas);
        codes.forEach(function (c) { if (c.rawValue) addUnique(found, new TextEncoder().encode(c.rawValue)); });
      } catch (e) { /* 不支援就算了 */ }
    }
    return parse(found);
  }
  async function fileToCanvases(file) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')) {
      if (!root.pdfjsLib) throw new Error('PDF 模組載入失敗，請確認網路連線');
      root.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      var doc = await root.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise, out = [];
      for (var n = 1; n <= Math.min(2, doc.numPages); n++) {
        var page = await doc.getPage(n), vp = page.getViewport({ scale: 2.5 }), c = newCanvas(vp.width, vp.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise; out.push(c);
      }
      return out;
    }
    var bmp = await createImageBitmap(file), c2 = newCanvas(bmp.width, bmp.height);
    c2.getContext('2d').drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
    return [c2];
  }
  // 讀一個檔案。找到電子發票 QR 回傳解析結果；沒有就回傳 null（呼叫端再改用文字辨識）
  async function scanFile(file) {
    var canvases = await fileToCanvases(file), result = null;
    for (var i = 0; i < canvases.length && !(result && result.ok); i++) {
      result = await scanCanvas(canvases[i]);
      canvases[i].width = canvases[i].height = 0;
    }
    return result && result.ok ? result : null;
  }

  return { parse: parse, claimLines: claimLines, scanFile: scanFile, scanCanvas: scanCanvas, _internal: { parseLeft: parseLeft, splitColon: splitColon, isLeft: isLeft, isRight: isRight } };
});
