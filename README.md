# 台股指標儀表板（自動更新版）

手機打開就能看的台股指標 App。GitHub Actions 每個交易日自動抓資料，存成 `data.json`，App 打開時讀最新數字。

## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | App 本體 |
| `data.json` | 最新資料（自動更新，不用手動改） |
| `update.mjs` | 抓資料的程式 |
| `.github/workflows/update-data.yml` | 排程：什麼時間自動執行 |

## 設定步驟（約 10 分鐘，只要做一次）

1. **建立 repo**：GitHub 右上角 ＋ → New repository，名稱例如 `Taiwan-stock`，選 **Public**（免費帳號的 GitHub Pages 需要公開）。
2. **上傳檔案**：在 repo 頁面按 *Add file → Upload files*，把整個資料夾的內容拖進去，再按 *Commit changes*。
   - ⚠ `.github` 是隱藏資料夾，一定要一起上傳。Mac 的 Finder 按 `Cmd + Shift + .` 就看得到。
   - 上傳後確認 repo 裡有 `.github/workflows/update-data.yml`。
3. **開放寫入權限**：*Settings → Actions → General → Workflow permissions* → 選 **Read and write permissions** → Save。
4. **開啟網站**：*Settings → Pages* → Source 選 *Deploy from a branch*，Branch 選 `main`、資料夾 `/ (root)` → Save。
5. **先手動跑一次**：*Actions* 分頁 → 左邊點「更新台股資料」→ 右邊 *Run workflow*。約 1 分鐘後變綠勾就成功了。
6. **打開 App**：`https://sheng007g.github.io/Taiwan-stock/`（換成你的 repo 名稱）。在 iPhone Safari 按分享 →「加入主畫面」，就像一般 App 一樣。

## 什麼時候更新（台北時間）

| 時間 | 抓什麼 |
|---|---|
| 週一～五 15:40 | 加權指數、成交金額、三大法人、台積電、櫃買、台指 VIX |
| 週一～五 21:20 | 補抓融資餘額、融資維持率等較晚公布的資料 |
| 週二～六 06:35 | 美股收盤：費半、台積電 ADR、匯率 |

GitHub 的排程常會晚 5–30 分鐘，屬於正常現象。

## 自動 vs 手動

- **自動抓**：加權指數、成交金額、櫃買指數、台積電、三大法人、融資餘額、費半、台積電 ADR、新台幣匯率、台指 VIX（期交所）。
- **自動算**：
  - **融資維持率**：Σ(每檔股票融資張數 × 收盤價) ÷ 融資金額，是近似值。
  - **台股情緒分數（0–100）**：股價動能、距高點、台指 VIX、量價、融資增減、外資買賣 6 項各自換算成分數後平均。點卡片可以看每一項的分數。
- **手動填**：MM 恐懼與貪婪指數。App 的「情緒」區有一張「每週填寫」卡片：按 ① 打開財經M平方 → 看數字 → ② 輸入後儲存。第一次可以按「設定直接連到恐懼與貪婪指數頁面」，貼上那一頁的網址，之後就能一鍵打開。超過 7 天沒填會提醒你。

## 出問題時

- Actions 出現紅色叉叉：點進去看 log。每個資料來源各自獨立，有 ✗ 的那個來源會保留上次的數字，其他照常更新。
- 台指 VIX 是讀期交所網頁，網頁改版就可能抓不到。log 會寫出找到幾個檔案連結，貼給 Claude 就能修。
- 證交所或 Yahoo 改了資料格式，抓取就可能失敗。把錯誤訊息貼給 Claude 就能修。
- repo 如果超過 60 天完全沒有動靜，GitHub 可能會暫停排程。到 Actions 頁面重新啟用即可。

資料來源：臺灣證券交易所、Yahoo Finance。燈號是簡化規則，只供學習參考，不構成投資建議。
