// 极简断言与工具，避免为测试引入额外依赖
let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, extra = '') {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`);
  }
  return ok;
}

function equal(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  return check(name, ok, ok ? '' : `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n${title}`);
}

function summary() {
  console.log(`\n${'-'.repeat(50)}`);
  console.log(failed ? `❌ 通过 ${passed} / 失败 ${failed}：${failures.join('、')}` : `✅ 全部通过（${passed} 项）`);
  return failed === 0;
}

// 从 server.js 里抽取源码片段，保证测试跑的是真实实现而不是复制品
const fs = require('fs');
const path = require('path');
const SERVER_PATH = path.join(__dirname, '..', 'server.js');

function serverSource() {
  return fs.readFileSync(SERVER_PATH, 'utf8');
}

function extract(startMarker, endMarker) {
  const src = serverSource();
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`无法从 server.js 抽取片段：${startMarker}`);
  return src.slice(start, end);
}

function constant(name) {
  const src = serverSource();
  const re = new RegExp(`const ${name} = ([\`'])([\\s\\S]*?)\\1;`);
  const m = re.exec(src);
  if (!m) throw new Error(`未找到常量 ${name}`);
  return m[2];
}

module.exports = { check, equal, section, summary, serverSource, extract, constant };
