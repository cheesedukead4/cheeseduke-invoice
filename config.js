/*
 * 發票簽核系統｜網站設定（這個檔案會公開，只能放公開資訊，不要放任何密碼或金鑰）
 *
 * INV_AUTH.clientId：Google Cloud 的「OAuth 用戶端 ID」（網頁應用程式類型）。這是公開資訊，不是密碼。
 *   這裡沿用「檔期包材管理系統」已經建好的用戶端 ID（同一個 Google 帳號與授權來源 https://cheesedukead4.github.io，
 *   不含路徑，所以新網站不用再去 Google Cloud 設定）。Code.gs 裡的 GOOGLE_CLIENT_ID_ 必須是同一個。
 *
 * INV_CLOUD.url：Apps Script「部署為網頁應用程式」後的網址（結尾是 /exec）。
 *   部署完成前留空；填好後把這個檔案一起上傳到 GitHub。
 */
window.INV_AUTH = {
  clientId: '373508141972-7trsuj8e732pljun49bhgcerbpldi50t.apps.googleusercontent.com'
};

window.INV_CLOUD = {
  url: 'https://script.google.com/macros/s/AKfycbyY5hwGRgze0u8moCxKcggqzW_XSxcf6pxxEMM-W5qfeaLcsN_o0191iB8FJtFb9RVZeQ/exec'
};
