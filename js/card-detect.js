/* 發票上印的「卡號」判讀（執行長發票用）
 * 使用者的規則（2026-11-18）：發票上偵測到卡號末 4 碼 7170（玉山卡，公司卡）→ 請款別 N（不請款、公司卡已付）；其餘一律請款（Y）；
 * 有卡號就把卡號填進「卡別」，沒有卡號就填「現金」。
 * 這支程式只負責「看文字辨識（OCR）出來的文字，判斷是哪張卡」，不碰畫面、不跑 OCR（OCR 在 index.html 裡用辨識引擎跑，再把文字交給這裡）。純函式，Node 也能測（開發工具/test-card-detect.cjs）。
 *
 * 為什麼要「模糊比對」：實測使用者的 7 張真實發票（1108×1477 像素），卡號那一行（例如「卡號:539231******8651」）OCR 常常讀錯數字（8651 → 8091、7170 → 5170），
 * 甚至整行讀不到。所以不能只信讀到的數字：公司卡（524255******7170）用「前 6 碼＋末 4 碼各自比對」容許讀錯 1～2 個數字；讀得不清楚的一律標示「請確認」，
 * 完全讀不到卡號、但發票上寫了「卡號」二字的，不亂猜（請款別留給人選）。 */
(function (root) {
  'use strict';

  // 公司卡（請款別 N，公司卡已付）。bin＝卡號前 6 碼（發卡組織＋銀行代碼），last4＝末 4 碼；之後要加別張公司卡，在這裡加一筆
  var COMPANY_CARDS = [{ name: '玉山卡', bin: '524255', last4: '7170' }];
  var CASH = '現金';

  function digitsOnly(s) { return String(s == null ? '' : s).replace(/[^0-9]/g, ''); }
  // 兩串數字逐位比對，相同的位數（長度不同回傳 -1）
  function sameDigits(a, b) { if (a.length !== b.length) return -1; var n = 0; for (var i = 0; i < a.length; i++) if (a[i] === b[i]) n++; return n; }

  // 從一段 OCR 文字找「像卡號」的候選：{bin, last4, clean, src}
  //  ① 標準遮罩寫法：6 碼＋遮罩（* # x 等）＋4 碼，例如 524255******7170、539231######8651（clean）
  //  ② 「卡號」二字後面接的一串數字與符號（遮罩常被讀成數字，例如 5392314444448091）：取前 6 碼與末 4 碼（noisy）
  //  ③ 只有數字的一整行（條帶辨識只認數字時，整串 10～16 碼，開頭是 3～6）：取前 6 碼與末 4 碼（noisy）；長度 9 碼（遮罩整段被吃掉）也收，當作 noisy
  function candidates(text) {
    var out = [], lines = String(text == null ? '' : text).normalize('NFKC').split(/\r?\n/);
    lines.forEach(function (line) {
      var l = line.replace(/[ \t]+/g, '');
      var m, re = /(\d{4,6})[*＊#xX×•·\-_.]{2,10}(\d{4})(?!\d)/g;
      while ((m = re.exec(l))) out.push({ bin: m[1].length === 6 ? m[1] : '', last4: m[2], clean: true, src: m[0] });
      if (!out.some(function (c) { return c.src && l.indexOf(c.src) >= 0; })) { var m2 = /[*＊#xX×•·]{3,}(\d{4})(?!\d)/.exec(l); if (m2) out.push({ bin: '', last4: m2[1], clean: true, src: m2[0] }); }   // 只讀到「****7170」（前面被遮罩吃掉）
      var k = /卡[號号][:;：]?(.*)$/.exec(l);
      if (k) {
        var d = digitsOnly(k[1]);
        if (d.length >= 9 && d.length <= 20 && !out.some(function (c) { return c.last4 === d.slice(-4); })) out.push({ bin: d.slice(0, 6), last4: d.slice(-4), clean: false, src: k[1] });
      }
      if (!k && /^[0-9*#＊\-]{9,24}$/.test(l)) {
        var d2 = digitsOnly(l);
        if (d2.length >= 9 && d2.length <= 16 && /^[3-6]/.test(d2)) out.push({ bin: d2.slice(0, 6), last4: d2.slice(-4), clean: false, src: l });
      }
    });
    return out;
  }
  function hasCardWord(text) { return /卡[號号]/.test(String(text == null ? '' : text).normalize('NFKC').replace(/\s+/g, '')); }

  // 這個候選像不像某張公司卡。回傳 {card, level:'exact'|'close'|'maybe'} 或 null
  //   exact：前 6 碼與末 4 碼都完全相同；close：末 4 碼相同（前 6 碼不同或沒讀到），或前 6 碼相同且末 4 碼至少 3 碼相同；
  //   maybe：前 6 碼至少 5 碼相同、末 4 碼至少 3 碼相同（兩邊各讀錯一個）
  function companyMatch(c) {
    for (var i = 0; i < COMPANY_CARDS.length; i++) {
      var cc = COMPANY_CARDS[i], bs = c.bin ? sameDigits(c.bin, cc.bin) : -1, ls = sameDigits(c.last4, cc.last4);
      if (ls === 4 && bs === 6) return { card: cc, level: 'exact' };
      if (ls === 4) return { card: cc, level: 'close' };   // 使用者的規則看末 4 碼：末 4 碼是 7170 就先當公司卡（前 6 碼不同或沒讀到，標示請確認）
      if (bs === 6 && ls >= 3) return { card: cc, level: 'close' };
      if (bs >= 5 && ls >= 3) return { card: cc, level: 'maybe' };
    }
    return null;
  }

  // 主函式：texts＝同一張發票幾次辨識（不同範圍、不同方式）的文字（字串或字串陣列）。
  // 回傳 {kind:'company'|'other'|'none'|'unknown', yn:'N'|'Y'|'', card:'玉山卡'|'卡號末4碼 8651'|'現金'|'', last4, sure:boolean, note}
  //   company：認得是公司卡 → N、卡別＝玉山卡；other：有卡號、不是公司卡 → Y、卡別＝卡號末 4 碼；none：完全沒有卡號 → Y、現金；
  //   unknown：發票上有「卡號」二字、但數字讀不出來 → 不猜（yn、card 留空，請人確認）
  function judgeCard(texts) {
    var list = Array.isArray(texts) ? texts : [texts], all = list.join('\n');
    var cands = []; list.forEach(function (t) { candidates(t).forEach(function (c) { cands.push(c); }); });
    // 先看有沒有認得是公司卡的（任何一次辨識像就算：公司卡判錯成 Y 的代價比較大，會去請款）
    var best = null;
    cands.forEach(function (c) {
      var m = companyMatch(c); if (!m) return;
      var rank = { exact: 3, close: 2, maybe: 1 }[m.level];
      if (!best || rank > best.rank) best = { rank: rank, m: m, c: c };
    });
    if (best) {
      var sure = best.m.level === 'exact';
      return { kind: 'company', yn: 'N', card: best.m.card.name, last4: best.m.card.last4, sure: sure,
        note: sure ? '發票上的卡號末 4 碼 ' + best.m.card.last4 + '＝' + best.m.card.name + '（公司卡）→ 請款別 N、不請款'
          : '發票上的卡號讀到「' + (best.c.bin || '') + '…' + best.c.last4 + '」，很像' + best.m.card.name + '（公司卡末 4 碼 ' + best.m.card.last4 + '）→ 先填請款別 N、不請款；卡號沒讀得很清楚，請對照發票確認' };
    }
    // 其他卡：挑最像卡號的（遮罩寫法優先、同類取最後一個）
    var clean = cands.filter(function (c) { return c.clean; }), pool = clean.length ? clean : cands;
    if (pool.length) {
      var c0 = pool[pool.length - 1], isClean = !!c0.clean;
      return { kind: 'other', yn: 'Y', card: '卡號末4碼 ' + c0.last4, last4: c0.last4, sure: isClean,
        note: '發票上有卡號，末 4 碼 ' + c0.last4 + '（不是公司卡 ' + COMPANY_CARDS[0].last4 + '）→ 請款別 Y、請款，卡別填卡號；' + (isClean ? '文字辨識讀數字可能有誤，請對照發票確認末 4 碼' : '卡號沒讀得很清楚，請對照發票確認末 4 碼') };
    }
    if (hasCardWord(all)) return { kind: 'unknown', yn: '', card: '', last4: '', sure: false, note: '發票上有「卡號」，但數字沒讀清楚，沒有自動判斷——請對照發票自己選請款別（公司卡末 4 碼 ' + COMPANY_CARDS[0].last4 + '＝N，其他＝Y）並填卡別' };
    return { kind: 'none', yn: 'Y', card: CASH, last4: '', sure: false, note: '沒有偵測到卡號 → 請款別 Y、請款，卡別填「' + CASH + '」；若這張其實是刷公司卡（末 4 碼 ' + COMPANY_CARDS[0].last4 + '）付款，請改請款別 N' };
  }

  var api = { judgeCard: judgeCard, candidates: candidates, companyMatch: companyMatch, hasCardWord: hasCardWord, COMPANY_CARDS: COMPANY_CARDS, CASH: CASH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CardDetect = api;
})(typeof window !== 'undefined' ? window : this);
