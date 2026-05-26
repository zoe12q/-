// WBI 签名实现
// 参考: docs/misc/sign/wbi.md

const crypto = require('node:crypto');

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const getMixinKey = (orig) =>
  MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32);

// 按 encodeURIComponent 语义编码, 保证空格为 %20, 中文大写百分号编码
// 过滤掉 value 中的 "!'()*" 字符 (参考官方脚本与 docs 示例)
const encodeValue = (v) =>
  encodeURIComponent(String(v)).replace(/[!'()*]/g, '');

function encWbi(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const wts = Math.round(Date.now() / 1000);
  const merged = { ...params, wts };
  const query = Object.keys(merged)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeValue(merged[k])}`)
    .join('&');
  const w_rid = md5(query + mixinKey);
  return { query: `${query}&w_rid=${w_rid}`, wts, w_rid };
}

module.exports = { encWbi, md5 };
