// Analisis statistik: apakah confluence (body×ATR, vol×, side, waktu) berkorelasi
// dengan outcome trade (WR / avg R) pada hasil ema_impulse_trail 5yr?
const fs = require('fs');

const csvPath = 'logs/trades_22coins_1825d_2026-06-10T23-02-54.csv';
const raw = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
const header = raw[0].split(',');

function parseLine(line) {
    // confluence field is quoted and may contain commas-free text but has spaces; simple split works
    // format: no,entry_date,entry_time_utc,symbol,side,entry_price,sl_price,exit_price,exit_date,exit_time_utc,final_r,end_reason,bars_held,"confluence"
    const m = line.match(/^(\d+),([\d-]+),([\d:]+),(\w+),(\w+),([\d.]+),([\d.]+),([\d.]+),([\d-]*),([\d:]*),(-?[\d.]+),(\w+),(\d+),"(.*)"$/);
    if (!m) return null;
    return {
        no: +m[1], entryDate: m[2], entryTime: m[3], symbol: m[4], side: m[5],
        entryPrice: +m[6], slPrice: +m[7], exitPrice: +m[8], exitDate: m[9], exitTime: m[10],
        finalR: +m[11], endReason: m[12], barsHeld: +m[13], confluence: m[14]
    };
}

const trades = [];
for (let i = 1; i < raw.length; i++) {
    const t = parseLine(raw[i]);
    if (!t) { console.log('PARSE FAIL:', raw[i]); continue; }
    const bm = t.confluence.match(/body=([\d.]+)×ATR/);
    const vm = t.confluence.match(/vol=([\d.]+)×/);
    t.bodyAtr = bm ? +bm[1] : null;
    t.volMult = vm ? +vm[1] : null;
    t.hour = +t.entryTime.split(':')[0];
    t.date = new Date(t.entryDate + 'T' + t.entryTime + ':00Z');
    trades.push(t);
}

console.log(`Total trades parsed: ${trades.length}\n`);

function summarize(label, group) {
    const n = group.length;
    if (n === 0) return;
    const wins = group.filter(t => t.finalR > 0).length;
    const sumR = group.reduce((s, t) => s + t.finalR, 0);
    const avgR = sumR / n;
    const wr = (wins / n) * 100;
    const avgWin = group.filter(t => t.finalR > 0).reduce((s, t) => s + t.finalR, 0) / (wins || 1);
    const losers = group.filter(t => t.finalR <= 0);
    const avgLoss = losers.reduce((s, t) => s + t.finalR, 0) / (losers.length || 1);
    console.log(`  ${label.padEnd(22)} n=${String(n).padEnd(5)} WR=${wr.toFixed(1).padStart(5)}%  avgR=${avgR.toFixed(3).padStart(7)}  sumR=${sumR.toFixed(1).padStart(8)}  avgWin=${avgWin.toFixed(2)}  avgLoss=${avgLoss.toFixed(2)}`);
}

// === 1. Body/ATR buckets ===
console.log('=== 1. Body size (×ATR) vs outcome ===');
const bodyBuckets = [
    ['1.0-1.5x', t => t.bodyAtr >= 1.0 && t.bodyAtr < 1.5],
    ['1.5-2.0x', t => t.bodyAtr >= 1.5 && t.bodyAtr < 2.0],
    ['2.0-3.0x', t => t.bodyAtr >= 2.0 && t.bodyAtr < 3.0],
    ['3.0x+',    t => t.bodyAtr >= 3.0],
];
for (const [label, fn] of bodyBuckets) summarize(label, trades.filter(fn));

// === 2. Volume multiple buckets ===
console.log('\n=== 2. Volume (×SMA20) vs outcome ===');
const volBuckets = [
    ['1.5-2.0x', t => t.volMult >= 1.5 && t.volMult < 2.0],
    ['2.0-3.0x', t => t.volMult >= 2.0 && t.volMult < 3.0],
    ['3.0-5.0x', t => t.volMult >= 3.0 && t.volMult < 5.0],
    ['5.0x+',    t => t.volMult >= 5.0],
];
for (const [label, fn] of volBuckets) summarize(label, trades.filter(fn));

// === 3. Side ===
console.log('\n=== 3. Side ===');
summarize('LONG', trades.filter(t => t.side === 'LONG'));
summarize('SHORT', trades.filter(t => t.side === 'SHORT'));

// === 4. Entry hour (UTC) ===
console.log('\n=== 4. Entry hour (UTC, 4H candles) ===');
for (const h of [0, 4, 8, 12, 16, 20]) {
    summarize(`hour=${h}`, trades.filter(t => t.hour === h));
}

// === 5. Day of week ===
console.log('\n=== 5. Day of week ===');
const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
for (let d = 0; d < 7; d++) {
    summarize(days[d], trades.filter(t => t.date.getUTCDay() === d));
}

// === 6. Cross-tab: body × vol (high/high vs low/low) ===
console.log('\n=== 6. Combined body+vol extremes ===');
summarize('body<1.5 & vol<2.0', trades.filter(t => t.bodyAtr < 1.5 && t.volMult < 2.0));
summarize('body>=2.0 & vol>=3.0', trades.filter(t => t.bodyAtr >= 2.0 && t.volMult >= 3.0));
summarize('body>=3.0 & vol>=5.0', trades.filter(t => t.bodyAtr >= 3.0 && t.volMult >= 5.0));

// === 7. Walk-forward validation: split chronologically 70/30 ===
console.log('\n=== 7. Walk-forward: cari pola di 70% data awal, validasi di 30% data akhir ===');
const sorted = [...trades].sort((a, b) => a.date - b.date);
const splitIdx = Math.floor(sorted.length * 0.7);
const train = sorted.slice(0, splitIdx);
const test = sorted.slice(splitIdx);
console.log(`Train: ${train[0].entryDate} -> ${train[train.length-1].entryDate}  (n=${train.length})`);
console.log(`Test:  ${test[0].entryDate} -> ${test[test.length-1].entryDate}  (n=${test.length})`);

console.log('\n-- TRAIN set --');
summarize('ALL (train)', train);
for (const [label, fn] of bodyBuckets) summarize('  body ' + label, train.filter(fn));
for (const [label, fn] of volBuckets) summarize('  vol ' + label, train.filter(fn));

console.log('\n-- TEST set (validasi) --');
summarize('ALL (test)', test);
for (const [label, fn] of bodyBuckets) summarize('  body ' + label, test.filter(fn));
for (const [label, fn] of volBuckets) summarize('  vol ' + label, test.filter(fn));
