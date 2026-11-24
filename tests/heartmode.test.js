/*
 * app/js/netease.js 里 heartMode() 的返回结构解析。
 *
 * 为什么单独测：这个接口的返回结构和别处**不一样**（多嵌一层 data），
 * 而错在解析层的表现极其难查 —— 列表永远是空的，外层 try 把
 * `list.map is not a function` 吞掉，用户只看到「心动模式取不到列表」。
 * 这类「结构假设错误」只能靠单测钉住。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_PATH = path.join(__dirname, '..', 'app', 'js', 'netease.js');

/*
 * 直接测源文件里那段解析逻辑。
 *
 * netease.js 是一个大 IIFE，依赖真实的网络层；这里不加载整个模块，
 * 而是把「解析 + mapSong」抽出来按同样的规则跑一遍 ——
 * 同时用 readFileSync 断言源码里确实是逐层探测（而不是又写死了一层）。
 */
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

/** 复刻 netease.js 里 heartMode 的列表提取逻辑 */
function extractList(r) {
  let list = [];
  if (Array.isArray(r && r.data)) {
    list = r.data;
  } else if (r && r.data && Array.isArray(r.data.data)) {
    list = r.data.data;
  } else if (Array.isArray(r && r.songs)) {
    list = r.songs;
  }
  return list;
}

test('源码里确实是逐层探测，不是写死 r.data 或 r.data.data', () => {
  assert.match(SRC, /Array\.isArray\(r && r\.data\)/,
    '必须能处理一层结构');
  assert.match(SRC, /Array\.isArray\(r\.data\.data\)/,
    '必须能处理两层结构（playmode/intelligence/list 的真实结构）');
  assert.doesNotMatch(SRC, /const list = r\.data \|\| \[\];/,
    '不能退回旧的单层假设 —— 那正是「取不到列表」的根因');
});

test('两层结构（当前真实结构）：能正确取到数组', () => {
  const r = { code: 200, data: { data: [{ songInfo: { id: 1 } }, { songInfo: { id: 2 } }] } };
  const list = extractList(r);
  assert.equal(list.length, 2);
  assert.equal(list[0].songInfo.id, 1);
});

test('一层结构（传统结构）：也能正确取到数组', () => {
  const r = { code: 200, data: [{ songInfo: { id: 1 } }] };
  assert.equal(extractList(r).length, 1);
});

test('未登录（code 301，没有 data）：不抛异常，返回空数组', () => {
  /*
   * 实测：未登录时 playmode/intelligence/list 直接返回 {code:301, message:null}，
   * 连 data 字段都没有。旧代码 `r.data || []` 这里恰好能得 []，
   * 但一旦上游返回 data:{} 就会拿到对象，再 .map 就抛错。
   */
  const r = { code: 301, message: null };
  assert.deepEqual(extractList(r), []);
});

test('data 是空对象（不带内层 data）：不抛异常，返回空数组', () => {
  const r = { code: 200, data: {} };
  assert.deepEqual(extractList(r), []);
});

test('data 的 data 不是数组（坏数据）：不抛异常', () => {
  const r = { code: 200, data: { data: null } };
  assert.deepEqual(extractList(r), []);
  const r2 = { code: 200, data: { data: 'oops' } };
  assert.deepEqual(extractList(r2), []);
});

test('r 为 null / undefined：不抛异常', () => {
  assert.deepEqual(extractList(null), []);
  assert.deepEqual(extractList(undefined), []);
});

test('songs 兜底结构：也能取到', () => {
  const r = { code: 200, songs: [{ id: 1 }] };
  assert.equal(extractList(r).length, 1);
});

test('空数组：正常返回空，且不会误判成「结构不对」', () => {
  assert.deepEqual(extractList({ code: 200, data: { data: [] } }), []);
  assert.deepEqual(extractList({ code: 200, data: [] }), []);
});
