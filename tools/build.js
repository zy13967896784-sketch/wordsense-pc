/* 构建词库：把 data/raw/*.json 合并成浏览器可直接加载的 data/words.js
   用法：node tools/build.js
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RAW = path.join(ROOT, 'data', 'raw');
const OUT = path.join(ROOT, 'data', 'words.js');

const cet4Files = fs.readdirSync(RAW).filter((f) => /^cet4_.*\.json$/i.test(f)).sort();
const cet6Files = cet4Files.concat(fs.readdirSync(RAW).filter((f) => /^cet6.*\.json$/i.test(f)).sort());
const extraFiles = (prefix) => fs.readdirSync(RAW).filter((f) => new RegExp('^' + prefix + '.*\\.json$', 'i').test(f)).sort();

const BANKS = [
  { id: 'cet4',   name: '四级词书', sub: 'CET-4',   color: '#0f8f6f', files: cet4Files },
  { id: 'cet4core', name: '四级核心词', sub: 'CET-4 核心', color: '#d9480f', files: ['core_cet4.json'] },
  { id: 'cet6',   name: '六级词书', sub: 'CET-6',   color: '#3f6f9c', files: cet6Files },
  { id: 'kaoyan', name: '考研词汇', sub: '考研英语', color: '#b8802a', files: cet6Files.concat(extraFiles('kaoyan')) },
  { id: 'ielts',  name: '雅思词汇', sub: 'IELTS',   color: '#9a5fb0', files: cet6Files.concat(extraFiles('ielts')) },
  { id: 'toefl',  name: '托福词汇', sub: 'TOEFL',   color: '#c26a4a', files: cet6Files.concat(extraFiles('toefl')) }
];

function readBank(bank) {
  const words = [];
  const seen = new Set();
  const issues = [];
  let dupes = 0;
  bank.files.forEach((file) => {
    const p = path.join(RAW, file);
    if (!fs.existsSync(p)) { issues.push(`缺少文件 ${file}`); return; }
    let arr;
    try {
      arr = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    } catch (e) {
      issues.push(`${file} JSON 解析失败：${e.message}`); return;
    }
    if (!Array.isArray(arr)) { issues.push(`${file} 不是数组`); return; }
    arr.forEach((raw, i) => {
      const w = String(raw.w || '').trim();
      const zh = String(raw.zh || '').trim();
      if (!w || !/^[a-zA-Z][a-zA-Z' -]*$/.test(w)) { issues.push(`${file}[${i}] 单词非法：${w}`); return; }
      if (!zh || !/[\u4e00-\u9fa5]/.test(zh)) { issues.push(`${file}[${i}] 缺少中文释义：${w}`); return; }
      const key = w.toLowerCase();
      if (seen.has(key)) { dupes += 1; return; }
      seen.add(key);
      words.push({
        id: `${bank.id}:${key}`,
        w: w.toLowerCase(),
        ph: String(raw.ph || '').replace(/^\/+|\/+$/g, '').trim(),
        pos: String(raw.pos || '').trim(),
        zh: zh,
        ex: String(raw.ex || '').trim(),
        exzh: String(raw.exzh || '').trim()
      });
    });
  });
  words.sort((a, b) => a.w.localeCompare(b.w));
  return { bank, words, issues, dupes };
}

const result = [];
let allIssues = [];
const uniqueWords = new Set();
let bankEntries = 0;

BANKS.forEach((bank) => {
  const r = readBank(bank);
  bankEntries += r.words.length;
  r.words.forEach((w) => uniqueWords.add(w.w.toLowerCase()));
  allIssues = allIssues.concat(r.issues.map((x) => `${bank.id}: ${x}`));
  if (r.words.length) {
    result.push({
      id: bank.id,
      name: bank.name,
      sub: bank.sub,
      desc: `${bank.name} · ${r.words.length} 词`,
      color: bank.color,
      words: r.words
    });
  }
  console.log(`${bank.id.padEnd(7)} ${String(r.words.length).padStart(4)} 词${r.dupes ? '  跳过重复 ' + r.dupes : ''}${r.issues.length ? '  ⚠ ' + r.issues.length + ' 条问题' : ''}`);
});

// 基础词释义（只用于句子中点击普通单词查义，不算学习词条）
let glosses = [];
const seenGloss = new Set();
['basic.json', 'basic2.json'].forEach((name) => {
  const glossPath = path.join(RAW, name);
  if (!fs.existsSync(glossPath)) return;
  try {
    const arr = JSON.parse(fs.readFileSync(glossPath, 'utf8').replace(/^\uFEFF/, ''));
    arr.forEach((g) => {
      const w = String(g.w || '').trim().toLowerCase();
      const zh = String(g.zh || '').trim();
      if (!w || !/^[a-z][a-z' -]*$/.test(w) || !zh || !/[\u4e00-\u9fa5]/.test(zh)) return;
      if (seenGloss.has(w)) return;
      seenGloss.add(w);
      glosses.push({ w, pos: String(g.pos || '').trim(), zh });
    });
  } catch (e) {
    allIssues.push(`${name} 解析失败：` + e.message);
  }
});
glosses.sort((a, b) => a.w.localeCompare(b.w));
if (glosses.length) console.log(`basic   ${String(glosses.length).padStart(4)} 条基础词释义`);

const payload = { generatedAt: new Date().toISOString(), count: uniqueWords.size, bankEntries, banks: result, glosses };
const banner = '/* 由 tools/build.js 自动生成，请勿手工编辑；原始数据在 data/raw/ */\n';
fs.writeFileSync(OUT, banner + 'window.VOCAB_DATA = ' + JSON.stringify(payload) + ';\n', 'utf8');

console.log(`\n去重后 ${uniqueWords.size} 个单词；各词库合计 ${bankEntries} 条，输出 ${path.relative(ROOT, OUT)}（${(fs.statSync(OUT).size / 1024).toFixed(1)} KB）`);
if (allIssues.length) {
  console.log('\n问题清单：');
  allIssues.slice(0, 40).forEach((x) => console.log(' - ' + x));
  if (allIssues.length > 40) console.log(` ... 以及另外 ${allIssues.length - 40} 条`);
} else {
  console.log('数据校验通过：无非法/重复词条。');
}
