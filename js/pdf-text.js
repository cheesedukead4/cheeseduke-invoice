/* PDF 電子發票：直接讀 PDF 裡的文字（不用文字辨識 OCR）
 * 緣由（2026-11-18，使用者傳了一份 ematic 開的 B2B「電子發票證明聯」PDF）：這種 PDF 的中文字用「沒有內嵌的中文字型」（MSungStd-Light-Acro／UniCNS-UCS2-H），
 * 網頁用的 pdf.js 沒有帶「字元對照檔（cMap）」就解不出這些字，畫成圖是空白表格，文字辨識只讀到 logo 與印章。
 * 帶上對照檔（cMapUrl，來自 jsDelivr 的 pdfjs-dist@3.11.174/cmaps/；cdnjs 沒有放）之後：①畫出來的圖有字；②可以直接把文字層讀出來——不是辨識，是 PDF 裡本來就有的字，發票號碼、日期、金額一個字都不會讀錯。
 * 這支程式：
 *   docOptions(bytes)  ：給 pdfjsLib.getDocument 用的參數（含對照檔位置）；網頁裡所有開 PDF 的地方都用它
 *   read(file)         ：讀第 1 頁文字層 → {lines, text}；沒有文字（掃描的 PDF）回傳 null
 *   groupRows(items)   ：把文字片段依位置排成一行一行（純函式，Node 也能測）
 *   parse(lines, opt)  ：從文字讀出 發票號碼／日期／含稅總額／買賣方統編／品名（純函式，Node 也能測；開發工具/test-pdf-text.cjs）
 * 金額會用「銷售額＋營業稅＝總計」與「中文大寫金額」交叉核對；核對不起來的標示 amountSure=false，請人看。 */
(function (root) {
  'use strict';

  var CMAP_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/';
  var WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  function docOptions(bytes) { return { data: bytes, cMapUrl: CMAP_URL, cMapPacked: true }; }

  // ---- 文字片段 → 一行一行 ----
  function groupRows(items) {
    var rows = [];
    (items || []).forEach(function (it) {
      var s = it && it.str; if (s == null || !String(s).trim()) return;
      var x = it.transform ? it.transform[4] : it.x, y = it.transform ? it.transform[5] : it.y, row = null;
      for (var i = 0; i < rows.length; i++) if (Math.abs(rows[i].y - y) <= 3) { row = rows[i]; break; }
      if (!row) { row = { y: y, cells: [] }; rows.push(row); }
      row.cells.push({ x: x, s: String(s).trim() });
    });
    rows.sort(function (a, b) { return b.y - a.y; });
    return rows.map(function (r) { return r.cells.sort(function (a, b) { return a.x - b.x; }).map(function (c) { return c.s; }).join(' | '); });
  }

  // ---- 中文大寫金額（玖仟伍佰肆拾柒元整 → 9547）----
  var CN_DIGIT = { '零': 0, '〇': 0, '壹': 1, '一': 1, '貳': 2, '二': 2, '參': 3, '叁': 3, '三': 3, '肆': 4, '四': 4, '伍': 5, '五': 5, '陸': 6, '六': 6, '柒': 7, '七': 7, '捌': 8, '八': 8, '玖': 9, '九': 9 };
  var CN_UNIT = { '拾': 10, '十': 10, '佰': 100, '百': 100, '仟': 1000, '千': 1000 };
  function cnToNumber(s) {
    s = String(s || '').replace(/[元圓圆整正\s]/g, ''); if (!s) return NaN;
    var total = 0, section = 0, cur = 0, seen = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c in CN_DIGIT) { cur = CN_DIGIT[c]; seen = true; }
      else if (c in CN_UNIT) { section += (cur || 1) * CN_UNIT[c]; cur = 0; seen = true; }
      else if (c === '萬' || c === '万') { total += (section + cur) * 10000; section = 0; cur = 0; seen = true; }
      else if (c === '億' || c === '亿') { total = (total + section + cur) * 100000000; section = 0; cur = 0; seen = true; }
      else return NaN;
    }
    return seen ? total + section + cur : NaN;
  }

  function flat(s) { return String(s == null ? '' : s).normalize('NFKC').replace(/[\s|]+/g, ''); }
  function num(s) { var m = /(\d[\d,]*)/.exec(String(s || '')); return m ? Number(m[1].replace(/,/g, '')) : NaN; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function validDate(y, m, d) { return y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31; }

  // 標籤後面的數字：同一行（標籤後面接的）或下一行（整行只有數字）
  function labelledNumber(F, i, labelRe) {
    var m = labelRe.exec(F[i]); if (!m) return NaN;
    var rest = F[i].slice(m.index + m[0].length), n = /^\D*(\d[\d,]*)/.exec(rest);
    if (n) return Number(n[1].replace(/,/g, ''));
    for (var j = i + 1; j < Math.min(F.length, i + 3); j++) { if (!F[j]) continue; var k = /^\D?(\d[\d,]*)$/.exec(F[j]); return k ? Number(k[1].replace(/,/g, '')) : NaN; }
    return NaN;
  }

  // ---- 從文字讀出發票欄位 ----
  // opt: {ownTaxId: 本公司統編（買方，不當賣方）, taxOk: 統編檢查碼函式}
  function parse(lines, opt) {
    opt = opt || {};
    var own = opt.ownTaxId || '', taxOk = typeof opt.taxOk === 'function' ? opt.taxOk : function () { return true; };
    var L = (lines || []).map(function (x) { return String(x == null ? '' : x).normalize('NFKC'); });
    var F = L.map(flat), all = L.join('\n');
    var out = { invoiceNo: '', invoiceDate: '', amount: '', amountSure: false, sellerTaxId: '', buyerTaxId: '', vendor: '', buyerName: '', description: '', sales: '', tax: '', ok: false, complete: false, notes: [] };

    // 發票號碼：2 個英文字母＋8 碼數字（有「發票號碼」標籤優先）
    var fAll = F.join('\n'), m = /發票號碼[:：]?([A-Z]{2})[-－]?(\d{8})(?!\d)/.exec(fAll);
    if (!m) for (var a = 0; a < L.length && !m; a++) m = /(?<![A-Za-z0-9])([A-Z]{2})-?(\d{8})(?!\d)/.exec(L[a].replace(/ \| /g, ' '));
    if (m) out.invoiceNo = m[1] + m[2];

    // 日期：西元 2026-10-28（2026/10/28）或 民國 115年10月28日
    for (var b = 0; b < L.length && !out.invoiceDate; b++) {
      var d1 = /(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?!\d)/.exec(L[b]);
      if (d1 && validDate(+d1[1], +d1[2], +d1[3])) { out.invoiceDate = d1[1] + '-' + pad2(+d1[2]) + '-' + pad2(+d1[3]); break; }
      var d2 = /(\d{2,3})年(\d{1,2})月(\d{1,2})日/.exec(F[b]);
      if (d2 && validDate(+d2[1] + 1911, +d2[2], +d2[3])) { out.invoiceDate = (+d2[1] + 1911) + '-' + pad2(+d2[2]) + '-' + pad2(+d2[3]); break; }
    }

    // 金額：總計（含稅）；用「銷售額合計＋營業稅」與中文大寫交叉核對
    var total = NaN, sales = NaN, tax = NaN, cn = NaN;
    for (var i = 0; i < F.length; i++) {
      if (isNaN(total) && /^(?:含稅)?總計(?!新)/.test(F[i])) total = labelledNumber(F, i, /^(?:含稅)?總計(?:額|金額)?/);
      if (isNaN(total) && /^含稅(?:合計|總額|金額)/.test(F[i])) total = labelledNumber(F, i, /^含稅(?:合計|總額|金額)/);
      if (isNaN(sales) && /^銷售額(?:合計)?/.test(F[i])) sales = labelledNumber(F, i, /^銷售額(?:合計)?/);
      if (isNaN(tax) && /^營業稅(?!率)/.test(F[i])) { var tn = labelledNumber(F, i, /^營業稅/); if (isNaN(tn) && F[i + 1]) { var k = /(\d[\d,]*)$/.exec(F[i + 1]); if (k) tn = Number(k[1].replace(/,/g, '')); } tax = tn; }
      if (isNaN(cn)) { var cm = /([零壹貳參叁肆伍陸柒捌玖拾佰仟萬億〇一二三四五六七八九十百千]{2,})元?整?/.exec(F[i]); if (cm && /[壹貳參叁肆伍陸柒捌玖]|元整/.test(F[i])) cn = cnToNumber(cm[1]); }
    }
    var sum = (!isNaN(sales) && !isNaN(tax)) ? sales + tax : NaN, labelled = !isNaN(total);
    if (isNaN(total)) total = !isNaN(cn) ? cn : sum;
    if (!isNaN(total)) {
      out.amount = String(total);
      // 「核對過」＝至少兩個獨立來源一致（標示的總計、中文大寫、銷售額＋營業稅）；只有一個來源（例如沒有「總計」只能用銷售額＋營業稅）不算
      var okSum = !isNaN(sum) && sum === total, okCn = !isNaN(cn) && cn === total;
      out.amountSure = (labelled ? 1 : 0) + (okSum ? 1 : 0) + (okCn ? 1 : 0) >= 2 || (!labelled && okSum && okCn);
      if (!isNaN(sum) && sum !== total) out.notes.push('銷售額 ' + sales + '＋營業稅 ' + tax + '＝' + sum + '，和總計 ' + total + ' 對不起來，請核對金額');
      if (!isNaN(cn) && cn !== total) out.notes.push('中文大寫金額是 ' + cn + '，和總計 ' + total + ' 對不起來，請核對金額');
    }
    if (!isNaN(sales)) out.sales = String(sales);
    if (!isNaN(tax)) out.tax = String(tax);

    // 統編：看「統一編號」標籤；買方（買方／買受人那一塊）與賣方分開。沒有標籤的 8 碼數字不採用（電話、序號都可能是 8 碼）
    var sellerTax = '', buyerTax = '';
    for (var c = 0; c < L.length; c++) {
      if (!/統一編號|統編|Tax\s*(?:ID|No)|營業人編號/i.test(L[c]) || /電話|TEL|傳真|FAX/i.test(L[c])) continue;
      var tm = /(?<![A-Za-z0-9])(\d{8})(?!\d)/.exec(L[c]) || (F[c + 1] && /^(\d{8})$/.exec(F[c + 1]));
      if (!tm) continue; var v = tm[1];
      var near = F.slice(Math.max(0, c - 2), c + 1).join('');
      var isBuyer = /買方|買受人|買受|購買人|客戶/.test(near) && !/賣方|銷售方|銷售人/.test(F[c]), isOwn = !!own && v === own;
      if (isBuyer || isOwn) { if (!buyerTax) buyerTax = v; continue; }
      if (!sellerTax && taxOk(v)) sellerTax = v;
    }
    out.sellerTaxId = sellerTax; out.buyerTaxId = buyerTax;

    // 名稱：買方名稱（「買方」那一行的公司名）；賣方名稱只在有「賣方／銷售人」標籤時採用，沒有就留空（由統編查詢補）
    var coRe = /([一-鿿A-Za-z0-9（）()\-.&]{2,30}(?:股份有限公司|有限公司|有限合夥|企業社|商行|工作室|實業社|商號))/;
    for (var e = 0; e < L.length; e++) {
      if (/買\s*方|買受人/.test(L[e].replace(/[\s|]+/g, '')) ) { var bn = coRe.exec(L[e].replace(/ \| /g, ' ')); if (bn && !out.buyerName) out.buyerName = bn[1]; }
      var sv = /(?:賣方|銷售(?:人|方)|營業人名稱)[:：]?\s*\|?\s*([^|]+)/.exec(L[e]);
      if (sv && !out.vendor) { var vn = coRe.exec(sv[1]); if (vn && vn[1] !== out.buyerName) out.vendor = vn[1]; }
    }

    // 品名：「品名 | 數量 | 單價 | 金額 | 備註」表頭到「銷售額合計」之間；表頭下面第一段不是數字開頭的行是品名，後面數字之後的字是備註
    var h = -1, t = -1;
    for (var g = 0; g < F.length; g++) { if (h < 0 && /^品名/.test(F[g])) h = g; if (h >= 0 && g > h && /^銷售額/.test(F[g])) { t = g; break; } }
    if (h >= 0) {
      // 一行裡的格子（以 | 分開）：第一個以數字開頭的格子之前是品名；從那格起（數量、單價、金額）把開頭的數字拿掉，剩下的字是備註；
      // 數字出現之後的整行文字（沒有數字）是備註接續。品名與數字有時會被排在同一行（"服務費 | 1 | 9,092 | 9,092 備註…"），也有分兩行的
      var body = L.slice(h + 1, t < 0 ? Math.min(L.length, h + 8) : t).map(function (x) { return x.trim(); }).filter(Boolean), names = [], rest = [], inRest = false;
      body.forEach(function (x, bi) {
        var cells = x.split(' | ').map(function (c) { return c.trim(); }), k = -1;
        for (var q = 0; q < cells.length; q++) if (/^\d[\d,.]*(\s|$)/.test(cells[q])) { k = q; break; }
        if (k < 0) { var nextIsNumRow = bi + 1 < body.length && /^\d[\d,.]*(\s|\||$)/.test(body[bi + 1]); (inRest && !nextIsNumRow ? rest : names).push(cells.join(' ')); return; }   // 數字之後的文字行：下一行又是數字列＝新的品項名稱；否則是備註接續
        inRest = true;
        if (k > 0) names.push(cells.slice(0, k).join(' '));
        cells.slice(k).forEach(function (c) { var tail = c.replace(/^\d[\d,.]*\s*/, '').trim(); if (tail) rest.push(tail); });
      });
      var nm = names.join(' ').trim(), rm = rest.join(' ').trim();
      out.description = nm ? (rm ? nm + '（' + rm + '）' : nm) : rm;
    }

    out.ok = !!(out.invoiceNo && out.amount);
    out.complete = !!(out.ok && out.invoiceDate && out.sellerTaxId);
    if (out.ok && !out.sellerTaxId) out.notes.push('PDF 文字層沒有賣方統編（可能只蓋在印章圖上）');
    return out;
  }

  // ---- 讀 PDF 第 1 頁文字層 ----
  async function read(file, lib) {
    lib = lib || root.pdfjsLib; if (!lib) return null;
    try { if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = WORKER_URL; } catch (_) { }
    var bytes = new Uint8Array(await file.arrayBuffer()), doc = await lib.getDocument(docOptions(bytes)).promise, lines = [];
    try { var page = await doc.getPage(1), tc = await page.getTextContent(); lines = groupRows(tc.items); }
    finally { try { doc.destroy(); } catch (_) { } }
    return lines.length ? { lines: lines, text: lines.join('\n') } : null;
  }

  var api = { docOptions: docOptions, read: read, parse: parse, groupRows: groupRows, cnToNumber: cnToNumber, CMAP_URL: CMAP_URL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PdfText = api;
})(typeof window !== 'undefined' ? window : this);
