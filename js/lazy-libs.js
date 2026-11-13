/* 第三方套件改成「用到才載入」：Excel（xlsx，壓縮後約 316KB）、PDF（pdf.js，約 89KB）、發票文字辨識（tesseract，約 10KB）。
 * 原本都寫在網頁裡同步載入，第一次打開頁面（或換手機）就要先把它們下載完，後面的程式才會執行；其實大部分人一整天都用不到。
 * LazyLibs.ensure('xlsx'|'pdf'|'ocr') 回傳 Promise：套件已經在就立刻完成；還沒載入就現在載入（同時多次呼叫只載一次）；失敗會丟錯誤、下次可以重試。
 * LazyLibs.prefetch(role)：畫面出來、瀏覽器閒下來之後，在背景先把可能用到的載好，之後按下去就不用等。 */
(function (root) {
  var LIBS = {
    xlsx: { url: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', ok: function () { return !!root.XLSX; } },
    pdf: { url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', ok: function () { return !!root.pdfjsLib; } },
    ocr: { url: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js', ok: function () { return !!root.Tesseract; } }
  };
  var pending = {};
  function ensure(name) {
    var d = LIBS[name];
    if (!d) return Promise.reject(new Error('不認得的模組：' + name));
    if (d.ok()) return Promise.resolve();
    if (pending[name]) return pending[name];
    pending[name] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = d.url; s.async = true;
      s.onload = function () { if (d.ok()) resolve(); else reject(new Error('模組載入後無法使用：' + name)); };
      s.onerror = function () { try { s.remove(); } catch (e) {} reject(new Error('無法載入模組，請確認網路連線：' + name)); };
      document.head.appendChild(s);
    }).catch(function (e) { pending[name] = null; throw e; });
    return pending[name];
  }
  // 預先載入：所有人都先載 pdf 與 ocr（小）；xlsx（大）只給會匯入／匯出 Excel 的角色
  function prefetch(role) {
    var names = ['pdf', 'ocr'];
    if (role === 'finance' || role === 'admin' || role === 'executive') names.push('xlsx');
    var go = function () { names.forEach(function (n) { ensure(n).catch(function () {}); }); };
    if (root.requestIdleCallback) root.requestIdleCallback(go, { timeout: 8000 }); else setTimeout(go, 3000);
  }
  root.LazyLibs = { ensure: ensure, prefetch: prefetch };
})(typeof window !== 'undefined' ? window : this);
