// 台股指標儀表板：抓最新資料寫入 data.json
// 由 GitHub Actions 定時執行（Node 20+，不需安裝套件）
// 每個資料來源各自 try/catch：某個來源失敗時保留上次的數字，不會整份壞掉。
import { readFile, writeFile } from 'node:fs/promises';

const OUT = new URL('./data.json', import.meta.url);
const UA = { 'User-Agent': 'Mozilla/5.0 (twstock-dash; GitHub Actions)', 'Accept': 'application/json' };

const num = s => {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').replace(/^X/, '').replace(/<[^>]*>/g, '').trim();
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
};
const round = (n, dp = 2) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { ...UA, Accept: 'text/html,text/plain,*/*' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

// 證交所 JSON 裡找出欄位名稱符合條件的表格（支援新版 tables[] 與舊版 fieldsN/dataN）
function findTable(j, pred) {
  const cands = [];
  if (Array.isArray(j.tables)) j.tables.forEach(t => t && cands.push([t.fields, t.data]));
  if (j.fields && j.data) cands.push([j.fields, j.data]);
  Object.keys(j).forEach(k => { const m = k.match(/^fields(\d+)$/); if (m && j['data' + m[1]]) cands.push([j[k], j['data' + m[1]]]); });
  return cands.find(([f, d]) => Array.isArray(f) && Array.isArray(d) && d.length && pred(f.map(String)));
}

const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
const lin = (x, x0, x1) => clamp((x - x0) / (x1 - x0) * 100); // x0→0 分, x1→100 分
function pushHist(data, key, date, val, keep = 60) {
  const h = (data.history[key] ||= []).filter(x => x.date !== date);
  h.push({ date, val }); h.sort((a, b) => a.date.localeCompare(b.date));
  data.history[key] = h.slice(-keep); return data.history[key];
}

// 台北時間的日期，往前找 n 天
function taipeiDate(offsetDays = 0) {
  const d = new Date(Date.now() + 8 * 3600e3 - offsetDays * 86400e3);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
const ymd = iso => iso.replace(/-/g, '');
const rocToIso = s => { // "115/11/13" -> "2026-11-13"
  const [y, m, d] = s.trim().split('/').map(Number);
  return `${y + 1911}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

// 找出物件裡所有「二維陣列」的列（證交所新舊 JSON 格式不同，用這個比較保險）
function allRows(obj, out = []) {
  if (Array.isArray(obj)) {
    if (obj.length && obj.every(r => Array.isArray(r))) out.push(...obj);
    else obj.forEach(x => allRows(x, out));
  } else if (obj && typeof obj === 'object') Object.values(obj).forEach(x => allRows(x, out));
  return out;
}

// 往回找最近一個有資料的交易日
async function twseLatest(build, check, maxBack = 8) {
  for (let i = 0; i <= maxBack; i++) {
    const iso = taipeiDate(i);
    try {
      const j = await getJSON(build(ymd(iso)));
      if (j && j.stat === 'OK' && check(j)) {
        // 用證交所回傳的資料日期（若有），避免把查詢日當成交易日
        const dd = String(j.date || '');
        return { j, iso: /^\d{8}$/.test(dd) ? `${dd.slice(0, 4)}-${dd.slice(4, 6)}-${dd.slice(6)}` : iso };
      }
    } catch (e) { console.warn('  retry', e.message); }
    await sleep(1200); // 證交所有頻率限制，慢一點
  }
  throw new Error('找不到最近交易日資料');
}

// Yahoo Finance：取最後兩個收盤
async function yahoo(symbol, range = '10d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const j = await getJSON(url);
  const r = j.chart.result[0];
  const ts = r.timestamp, c = r.indicators.quote[0].close;
  const pts = ts.map((t, i) => [t, c[i]]).filter(p => p[1] != null);
  const [tLast, last] = pts[pts.length - 1], [, prev] = pts[pts.length - 2];
  return { last, prev, chg: last - prev, pct: (last / prev - 1) * 100, date: new Date(tLast * 1000).toISOString().slice(0, 10), closes: pts.map(p => p[1]) };
}

async function main() {
  let data = { items: {}, history: {} };
  try { data = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* 第一次執行 */ }
  data.items ||= {}; data.history ||= {};
  const ok = [], fail = [];
  const step = async (name, fn) => { try { await fn(); ok.push(name); console.log('✓', name); } catch (e) { fail.push(name); console.warn('✗', name, e.message); } };

  // 1) 加權指數＋成交金額（證交所 每日市場成交資訊）
  await step('加權指數/成交金額', async () => {
    const { j } = await twseLatest(d => `https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${d}&response=json`, j => j.data?.length);
    let rows = j.data;
    // 補上個月資料，才算得出 20 日平均成交金額
    { const d = new Date(rocToIso(rows[0][0])); d.setDate(0);
      try { await sleep(1200); const p = await getJSON(`https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${ymd(d.toISOString().slice(0, 10))}&response=json`); rows = [...(p.data || []), ...rows]; } catch {} }
    const amts = rows.map(r => num(r[2]) / 1e8);
    const last20 = amts.slice(-20); data.calc ||= {}; data.calc.volAvg20 = round(last20.reduce((a, b) => a + b, 0) / last20.length);
    const L = rows[rows.length - 1], P = rows[rows.length - 2];
    const val = num(L[4]), chg = num(L[5]), amt = num(L[2]) / 1e8, prevAmt = P ? num(P[2]) / 1e8 : null;
    const pct = chg / (val - chg) * 100, date = rocToIso(L[0]);
    const old = data.items.taiex?.v || {};
    data.items.taiex = { date, v: { val, chg: round(chg), pct: round(pct), hi: old.hi ?? null, lo: old.lo ?? null } };
    data.items.vol = { date, v: { val: round(amt), pct: prevAmt ? round((amt / prevAmt - 1) * 100) : null, idx: round(pct) } };
  });
  await sleep(1500);

  // 2) 52 週高低（Yahoo，用收盤價）
  await step('52週高低', async () => {
    const y = await yahoo('^TWII', '1y');
    const t = data.items.taiex; if (!t) throw new Error('沒有加權指數');
    t.v.hi = round(Math.max(...y.closes)); t.v.lo = round(Math.min(...y.closes));
    t.v.hi = Math.max(t.v.hi, t.v.val); t.v.lo = Math.min(t.v.lo, t.v.val);
    const c125 = y.closes.slice(-125); data.calc ||= {}; data.calc.ma125 = round(c125.reduce((a, b) => a + b, 0) / c125.length);
  });

  // 3) 三大法人（證交所 BFI82U）
  await step('三大法人', async () => {
    const { j, iso } = await twseLatest(d => `https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&dayDate=${d}&response=json`, j => j.data?.length);
    const find = k => j.data.find(r => String(r[0]).includes(k));
    const f = find('外資及陸資'), it = find('投信'), tot = find('合計');
    const dealer = j.data.filter(r => String(r[0]).startsWith('自營商')).reduce((s, r) => s + num(r[3]), 0);
    const val = round(num(f[3]) / 1e8);
    // 連買／連賣天數
    const h = (data.history.foreign ||= []).filter(x => x.date !== iso);
    h.push({ date: iso, val }); h.sort((a, b) => a.date.localeCompare(b.date)); data.history.foreign = h.slice(-30);
    let n = 0; const sign = Math.sign(val);
    for (let i = h.length - 1; i >= 0 && Math.sign(h[i].val) === sign && sign !== 0; i--) n++;
    const streak = sign === 0 ? '' : `連 ${n} ${sign > 0 ? '買' : '賣'}${n >= h.length ? '（以上）' : ''}`;
    const extra = `投信 ${num(it[3]) >= 0 ? '+' : ''}${round(num(it[3]) / 1e8)}億・自營商 ${dealer >= 0 ? '+' : ''}${round(dealer / 1e8)}億・合計 ${round(num(tot[3]) / 1e8)}億`;
    data.items.foreign = { date: iso, v: { val, note: streak, extra } };
  });
  await sleep(1500);

  // 4) 融資餘額（證交所 MI_MARGN 信用交易統計）
  await step('融資餘額', async () => {
    const { j, iso } = await twseLatest(d => `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${d}&selectType=MS&response=json`,
      j => allRows(j).some(r => String(r[0]).includes('融資金額')));
    const r = allRows(j).find(r => String(r[0]).includes('融資金額'));
    const prev = num(r[r.length - 2]), today = num(r[r.length - 1]); // 單位：仟元
    const old = data.items.margin?.date === iso ? data.items.margin.v.keep : null;
    data.items.margin = { date: iso, v: { val: round(today / 1e5), chg: round((today - prev) / 1e5), keep: old } };
    data.calc ||= {}; data.calc.marginK = today; // 仟元
    pushHist(data, 'margin', iso, round(today / 1e5));
  });
  await sleep(1500);

  // 4b) 大盤融資維持率（自己算）＝ Σ(個股融資餘額張數 × 1000 × 收盤價) ÷ 融資金額
  await step('融資維持率', async () => {
    const iso = data.items.margin?.date; if (!iso || !data.calc?.marginK) throw new Error('沒有融資金額');
    const mj = await getJSON(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${ymd(iso)}&selectType=ALL&response=json`);
    const mt = findTable(mj, f => f.some(x => x.includes('代號')) && f.includes('今日餘額'));
    if (!mt) throw new Error('找不到個股融資表');
    const iBal = mt[0].map(String).indexOf('今日餘額'); // 第一個「今日餘額」＝融資
    await sleep(1500);
    const pj = await getJSON(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd(iso)}&type=ALLBUT0999&response=json`);
    const pt = findTable(pj, f => f.includes('證券代號') && f.includes('收盤價'));
    if (!pt) throw new Error('找不到收盤價表');
    const fc = pt[0].map(String), iCode = fc.indexOf('證券代號'), iClose = fc.indexOf('收盤價');
    const price = new Map(pt[1].map(r => [String(r[iCode]).trim(), num(r[iClose])]));
    let mv = 0, miss = 0;
    for (const r of mt[1]) {
      const lots = num(r[iBal]); if (!lots) continue;
      const p = price.get(String(r[0]).trim());
      if (p) mv += lots * 1000 * p; else miss++;
    }
    const keep = mv / (data.calc.marginK * 1000) * 100;
    if (!(keep > 80 && keep < 400)) throw new Error('算出來的數字不合理：' + keep);
    data.items.margin.v.keep = round(keep);
    console.log(`  維持率 ${round(keep)}%（${miss} 檔沒有收盤價，略過）`);
  });
  await sleep(1500);

  // 5) 台積電 2330（證交所 個股日成交）
  await step('台積電', async () => {
    // STOCK_DAY 回傳整個月；月初還沒交易時改抓上個月
    let j = null;
    for (const off of [0, 20]) {
      try { const r = await getJSON(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${ymd(taipeiDate(off))}&stockNo=2330&response=json`); if (r.stat === 'OK' && r.data?.length) { j = r; break; } } catch (e) { console.warn('  retry', e.message); }
      await sleep(1200);
    }
    if (!j) throw new Error('沒有台積電資料');
    const L = j.data[j.data.length - 1];
    const close = num(L[6]), chg = num(String(L[7]).replace('+', ''));
    data.items.tsmc = { date: rocToIso(L[0]), v: { val: close, chg, pct: round(chg / (close - chg) * 100) } };
  });

  // 5b) 台指 VIX：① 期交所每月資料檔 ② FinMind 開放資料 ③ 期交所網頁
  await step('台指VIX', async () => {
    const found = []; // [iso, value]
    const scan = txt => {
      const re = /(20\d{2})[\/\-]?(\d{2})[\/\-]?(\d{2})(?:[\sT]+\d{1,2}:?\d{2}:?\d{2}(?:\.\d+)?)?[\s,|\t]+(\d{1,3}\.\d{1,4})/g;
      let m; while ((m = re.exec(txt))) { const v = parseFloat(m[4]); if (v > 3 && v < 150) found.push([`${m[1]}-${m[2]}-${m[3]}`, v]); }
    };
    // ① 期交所每月檔（本月＋上月；英文版與中文版路徑都試）
    const months = [taipeiDate(0), taipeiDate(28)].map(d => d.slice(0, 7).replace('-', ''));
    for (const ym of [...new Set(months)].reverse()) {
      for (const dir of ['log2data_eng', 'log2data']) {
        const u = `https://www.taifex.com.tw/file/taifex/Dailydownload/vix/${dir}/${ym}new.txt`;
        try { const t = await getText(u); const n0 = found.length; scan(t); console.log(`  ${u} → ${found.length - n0} 筆`); if (found.length > n0) break; }
        catch (e) { console.warn('  ', e.message); }
        await sleep(800);
      }
    }
    // ② FinMind（免註冊，有次數限制）
    if (!found.length) {
      try {
        const u = `https://api.finmindtrade.com/api/v4/data?dataset=TaiwanOptionVix&start_date=${taipeiDate(20)}`;
        const j = await getJSON(u);
        for (const r of j.data || []) {
          const d = String(r.date || r.Date || '').slice(0, 10);
          const k = ['vix', 'VIX', 'value', 'option_vix', 'close', 'Close'].find(k => r[k] != null);
          const v = k ? Number(r[k]) : NaN;
          if (/^\d{4}-\d{2}-\d{2}$/.test(d) && v > 3 && v < 150) found.push([d, v]);
        }
        console.log(`  FinMind → ${found.length} 筆`);
      } catch (e) { console.warn('  FinMind', e.message); }
    }
    // ③ 期交所網頁（最後手段）
    if (!found.length) {
      try { scan((await getText('https://www.taifex.com.tw/cht/7/vixDaily3MNew')).replace(/<[^>]+>/g, ' ')); } catch (e) { console.warn('  ', e.message); }
    }
    if (!found.length) throw new Error('三個來源都找不到 VIX 數字，請把 log 貼給 Claude');
    found.sort((a, b) => a[0].localeCompare(b[0]));
    const [date, val] = found[found.length - 1]; // 最新日期的最後一筆（分鐘資料＝收盤值）
    const before = found.filter(f => f[0] < date);
    const h = pushHist(data, 'vix', date, val);
    const prev = before.length ? before[before.length - 1][1] : h.length > 1 ? h[h.length - 2].val : null;
    data.items.vix = { date, v: { val: round(val), chg: prev != null ? round(val - prev) : null } };
  });

  // 6) 國際與櫃買（Yahoo）
  // 櫃買指數：櫃買中心官方 OpenAPI（Yahoo 已下架 ^TWOII）
  await step('櫃買指數', async () => {
    const j = await getJSON('https://www.tpex.org.tw/openapi/v1/tpex_index');
    const rows = (Array.isArray(j) ? j : j.data || []).map(r => {
      const key = re => Object.keys(r).find(k => re.test(k));
      let d = String(r[key(/date/i)] ?? '').replace(/\D/g, '');
      if (d.length === 7) d = String(+d.slice(0, 3) + 1911) + d.slice(3); // 民國 1151113 → 20261113
      return { date: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : null, close: num(r[key(/^close$|closingindex|收盤/i)]), chg: num(r[key(/^change$|漲跌點|^chg/i)]) };
    }).filter(r => r.date && r.close).sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) throw new Error('櫃買 API 沒有資料：' + JSON.stringify(j).slice(0, 200));
    const L = rows[rows.length - 1], P = rows[rows.length - 2];
    const chg = L.chg ?? (P ? L.close - P.close : null);
    data.items.otc = { date: L.date, v: { val: round(L.close), chg: round(chg), pct: chg != null ? round(chg / (L.close - chg) * 100) : null } };
  });
  await step('費城半導體', async () => { const y = await yahoo('^SOX'); data.items.sox = { date: y.date, v: { val: round(y.last), chg: round(y.chg), pct: round(y.pct) } }; });
  let twd = null;
  await step('新台幣匯率', async () => { const y = await yahoo('TWD=X'); twd = y.last; data.items.fx = { date: y.date, v: { val: round(y.last, 3), chg: round(y.chg, 3) } }; });
  await step('台積電ADR', async () => {
    const y = await yahoo('TSM');
    const rate = twd ?? data.items.fx?.v?.val;
    data.items.adr = { date: y.date, v: { val: round(y.last), chg: round(y.chg), pct: round(y.pct), tw: rate ? round(y.last * rate / 5) : null } };
  });

  // 7) 自算「台股情緒分數」0–100（越低越恐懼）
  await step('情緒分數', async () => {
    const it = data.items, c = data.calc || {}, parts = [];
    const add = (name, score, raw) => { if (score != null && Number.isFinite(score)) parts.push({ name, score: Math.round(score), raw }); };
    const t = it.taiex?.v;
    if (t && c.ma125) { const d = (t.val / c.ma125 - 1) * 100; add('股價動能', lin(d, -10, 10), `指數比 125 日均線 ${d >= 0 ? '+' : ''}${round(d, 1)}%`); }
    if (t?.hi) { const dd = (t.val / t.hi - 1) * 100; add('距 52 週高點', lin(dd, -20, 0), `${round(dd, 1)}%`); }
    if (it.vix?.v?.val != null) add('台指 VIX', lin(it.vix.v.val, 40, 15), `${it.vix.v.val}`);
    if (it.vol?.v && c.volAvg20) { const x = clamp(it.vol.v.val / c.volAvg20 - 1, -0.5, 0.5); const s = Math.sign(it.vol.v.idx || 0) || 0;
      add('量價', 50 + x * 100 * s, `成交額是 20 日均量的 ${round(it.vol.v.val / c.volAvg20 * 100, 0)}%，指數${s > 0 ? '漲' : s < 0 ? '跌' : '平'}`); }
    const mh = data.history.margin || [];
    if (mh.length >= 2) { const a = mh[Math.max(0, mh.length - 6)].val, b = mh[mh.length - 1].val; const p = (b / a - 1) * 100;
      add('融資增減', lin(p, -5, 5), `近 ${Math.min(5, mh.length - 1)} 日 ${p >= 0 ? '+' : ''}${round(p, 1)}%`); }
    const fh = (data.history.foreign || []).slice(-5);
    if (fh.length) { const sum = fh.reduce((s, x) => s + x.val, 0); add('外資買賣', lin(sum, -1000, 1000), `近 ${fh.length} 日合計 ${sum >= 0 ? '+' : ''}${round(sum, 0)} 億`); }
    if (parts.length < 3) throw new Error('可用資料不足 3 項');
    const val = round(parts.reduce((s, p) => s + p.score, 0) / parts.length, 1);
    const h = pushHist(data, 'mood', it.taiex?.date || taipeiDate(), val);
    const prev = h.length > 1 ? h[h.length - 2].val : null;
    data.items.mood = { date: it.taiex?.date, v: { val, chg: prev != null ? round(val - prev, 1) : null, parts } };
  });

  data.updatedAt = new Date().toISOString();
  data.lastRun = { ok, fail };
  await writeFile(OUT, JSON.stringify(data, null, 2) + '\n');
  console.log(`\n完成：成功 ${ok.length}、失敗 ${fail.length}`, fail.length ? fail : '');
  if (!ok.length) process.exit(1); // 全部失敗才讓 Action 顯示紅色
}
main();
