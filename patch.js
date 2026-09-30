#!/usr/bin/env node
/*
 * RE2CabbyCodes 汉化补丁工具  (Resident Evil 2 / BIOHAZARD RE:2 2019)
 * ==================================================================
 * 做什么
 *   读取原版 steam_api64.dll（RE2CabbyCodes 1.0.6 的代理 DLL），
 *   1) 把面板界面上硬编码的英文文本替换成中文（词条见 translations/ 目录）；
 *   2) 注入一小段代码，让 ImGui 改用系统中文字体（微软雅黑等）绘制界面，
 *      并把中文字形并入默认字体。
 *   原 DLL 内置的是 ImGui 自带的 ProggyClean 字体，只有 ASCII 字形，
 *   不注入中文字体的话中文只会显示成问号。
 *
 * 用法
 *   node patch.js                                  全部默认（推荐）
 *   node patch.js --in <dll> --out <dll>
 *   node patch.js --dry-run                        只校验，不写文件
 *   node patch.js --no-font                        只换文本，不注入字体
 *   node patch.js --font-size 18
 *   node patch.js --fonts "C:\\Windows\\Fonts\\msyh.ttc,/usr/share/fonts/..."
 *   node patch.js --list                           列出所有词条及引用情况
 *
 * 本工具不会修改输入文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ================================================================ 参数

function parseArgs(argv) {
  const a = {
    in: null, out: null, translations: null, fontSize: 16,
    font: true, dryRun: false, fonts: null, list: false, mark: '',
    // 默认走「最简字体加载」（104 字节 trampoline）：
    // 不构造 ImFontConfig、也不用 GetFileAttributesA 预筛，实测可用。
    fontSimple: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--in') a.in = v();
    else if (k === '--out') a.out = v();
    else if (k === '--translations') a.translations = v();
    else if (k === '--font-size') a.fontSize = parseFloat(v());
    else if (k === '--no-font') a.font = false;
    else if (k === '--fonts') a.fonts = v().split(',').map(s => s.trim()).filter(Boolean);
    else if (k === '--font-min') a.fontMin = true;      // 诊断用：只转发 AddFontDefault
    else if (k === '--font-simple') a.fontSimple = true; // 最简字体加载（现在的默认）
    else if (k === '--font-full') a.fontSimple = false;  // 旧的完整 trampoline（含 ImFontConfig 构造 + GetFileAttributesA）
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--list') a.list = true;
    else if (k === '--mark') a.mark = v();
    else if (k === '-h' || k === '--help') { console.log(HELP); process.exit(0); }
    else { console.error('未知参数: ' + k + '  (--help 查看用法)'); process.exit(2); }
  }
  return a;
}

const HELP = [
  'RE2CabbyCodes 汉化补丁工具',
  '  --in <dll>            原版 steam_api64.dll（默认依次找 ./steam_api64.dll、./original/、../）',
  '  --out <dll>           输出路径（默认 ./out/steam_api64.dll）',
  '  --translations <dir>  词条目录（默认 ./translations）',
  '  --fonts <p1,p2,...>   中文字体候选路径，按顺序尝试',
  '  --font-size <px>      界面字号，默认 16',
  '  --no-font             不注入中文字体（中文会显示为问号）',
  '  --font-min            诊断用：注入一个只转发 AddFontDefault 的极简 trampoline',
  '  --font-full           改用旧的完整 trampoline（会构造 ImFontConfig 并用 GetFileAttributesA',
  '  --dry-run             只校验并统计，不写文件',
  '  --list                列出所有词条、引用与长度情况',
].join('\n');

const ARGS = parseArgs(process.argv);
const HERE = __dirname;

/**
 * 找原版 steam_api64.dll：优先用 --in，其次在几个常见位置里挑第一个存在的。
 *   1) 仓库根目录 ./steam_api64.dll   —— 推荐把原版 DLL 放这里
 *   2) ./original/steam_api64.dll    —— 想分开存放时
 *   3) ../steam_api64.dll            —— 兼容「脚本放在子目录里」的老用法
 */
function pickInputDll() {
  if (ARGS.in) return ARGS.in;
  const cands = [
    path.join(HERE, 'steam_api64.dll'),
    path.join(HERE, 'original', 'steam_api64.dll'),
    path.join(HERE, '..', 'steam_api64.dll'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return cands[0];
}
const IN_DLL = pickInputDll();
const OUT_DLL = ARGS.out || path.join(HERE, 'out', 'steam_api64.dll');
const TR_DIR = ARGS.translations || path.join(HERE, 'translations');

// ================================================================ PE

function parsePE(buf) {
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('不是 PE 文件（缺少 MZ）');
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('不是 PE 文件（缺少 PE\\0\\0）');
  const machine = buf.readUInt16LE(peOff + 4);
  if (machine !== 0x8664) throw new Error('只支持 x86-64 的 PE（machine=0x' + machine.toString(16) + '）');
  const nSec = buf.readUInt16LE(peOff + 6);
  const optSize = buf.readUInt16LE(peOff + 20);
  const optOff = peOff + 24;
  const magic = buf.readUInt16LE(optOff);
  if (magic !== 0x20b) throw new Error('只支持 PE32+（magic=0x' + magic.toString(16) + '）');
  const sections = [];
  let o = optOff + optSize;
  for (let i = 0; i < nSec; i++) {
    const h = o + i * 40;
    sections.push({
      index: i + 1, headerOff: h,
      name: buf.slice(h, h + 8).toString('latin1').replace(/\0+$/, ''),
      vsize: buf.readUInt32LE(h + 8),
      va: buf.readUInt32LE(h + 12),
      rawSize: buf.readUInt32LE(h + 16),
      raw: buf.readUInt32LE(h + 20),
      chars: buf.readUInt32LE(h + 36),
    });
  }
  return {
    buf, peOff, optOff, optSize, nSec, sections,
    imageBase: buf.readBigUInt64LE(optOff + 24),
    sectionAlign: buf.readUInt32LE(optOff + 32),
    fileAlign: buf.readUInt32LE(optOff + 36),
    sizeOfImage: buf.readUInt32LE(optOff + 56),
    sizeOfHeaders: buf.readUInt32LE(optOff + 60),
    numberOfSectionsOff: peOff + 6,
    sizeOfImageOff: optOff + 56,
  };
}

const align = (v, a) => (v + a - 1) & ~(a - 1);

/**
 * 生成 ImGui 的字形范围数组（ImWchar[]，以 0 结尾）。
 * 组成 = 基础区 + ImGui 自带的 2500 常用汉字 + 本补丁译文里实际出现的每一个字。
 * 只列出真正需要的码位，字体图集因此保持很小；同时不会缺字。
 */
function buildGlyphRanges(pe, H, syms, translations) {
  const set = new Set();
  const add = (a, b) => { for (let c = a; c <= b && c <= 0xffff; c++) set.add(c); };
  add(0x0020, 0x00ff);          // 基本拉丁 + 拉丁补充
  add(0x2000, 0x206f);          // 常用标点（— “ ” …）
  add(0x2190, 0x21ff);          // 箭头（→）
  add(0x2460, 0x24ff);          // 圈号
  add(0x3000, 0x30ff);          // CJK 标点、平假名、片假名
  add(0x31f0, 0x31ff);          // 片假名扩展
  add(0xff00, 0xffef);          // 全角字符（（） 等）
  set.add(0xfffd);

  // ImGui 自带的 2500 常用汉字：从 DLL 里读累加偏移表重建
  const rva = syms.get('_ZZN11ImFontAtlas37GetGlyphRangesChineseSimplifiedCommonEvE32accumulative_offsets_from_0x4E00');
  if (rva !== undefined) {
    const off = H.rvaToOff(rva);
    if (off !== null) {
      let c = 0x4e00;
      for (let i = 0; i < 2500; i++) {
        c += pe.buf.readUInt16LE(off + i * 2);
        if (c > 0xffff) break;
        set.add(c);
      }
    }
  }

  // 本补丁译文里出现的所有非 ASCII 字符
  for (const e of translations.values()) {
    for (const ch of e.zh) {
      const cp = ch.codePointAt(0);
      if (cp > 0x7f && cp <= 0xffff) set.add(cp);
    }
  }

  // 排序并合并成 [start, end, ...] 形式
  const list = [...set].sort((a, b) => a - b);
  const ranges = [];
  let s = list[0], p = list[0];
  for (let i = 1; i < list.length; i++) {
    if (list[i] === p + 1) { p = list[i]; continue; }
    ranges.push(s, p); s = p = list[i];
  }
  ranges.push(s, p, 0);
  return ranges;
}

function helpersFor(pe) {
  const s = pe.sections;
  const rvaToOff = (rva) => {
    for (const x of s) if (x.rawSize && rva >= x.va && rva < x.va + x.rawSize) return x.raw + (rva - x.va);
    return null;
  };
  const sectionOf = (rva) => s.find(x => rva >= x.va && rva < x.va + Math.max(x.vsize, x.rawSize));
  return { rvaToOff, sectionOf };
}

// ================================================================ COFF 符号表

function readSymbols(pe) {
  const b = pe.buf;
  const symPtr = b.readUInt32LE(pe.peOff + 12);
  const numSym = b.readUInt32LE(pe.peOff + 16);
  const map = new Map();
  if (!symPtr || !numSym) return map;
  const strTab = symPtr + numSym * 18;
  const nameOf = (o) => {
    if (b.readUInt32LE(o) === 0) {
      const off = strTab + b.readUInt32LE(o + 4);
      let e = off; while (b[e]) e++;
      return b.slice(off, e).toString('latin1');
    }
    return b.slice(o, o + 8).toString('latin1').replace(/\0+$/, '');
  };
  for (let i = 0; i < numSym; i++) {
    const o = symPtr + i * 18;
    const nm = nameOf(o);
    const secNum = b.readInt16LE(o + 12);
    if (secNum > 0 && secNum <= pe.sections.length && !map.has(nm)) {
      map.set(nm, pe.sections[secNum - 1].va + b.readUInt32LE(o + 8));
    }
    i += b.readUInt8(o + 17);
  }
  return map;
}

// ================================================================ 导入表

function readImports(pe, H) {
  const b = pe.buf;
  const dd = pe.optOff + 112 + 1 * 8;
  const impRVA = b.readUInt32LE(dd);
  const out = new Map();
  if (!impRVA) return out;
  let o = H.rvaToOff(impRVA);
  if (o === null) return out;
  for (;;) {
    const origFirstThunk = b.readUInt32LE(o + 0);
    const nameRVA = b.readUInt32LE(o + 12);
    const firstThunk = b.readUInt32LE(o + 16);
    if (!nameRVA) break;
    const no = H.rvaToOff(nameRVA);
    let e = no; while (b[e]) e++;
    const dll = b.slice(no, e).toString('latin1');
    const t = H.rvaToOff(origFirstThunk || firstThunk);
    if (t !== null) {
      for (let k = 0; ; k++) {
        const tOff = t + k * 8;
        if (tOff + 8 > b.length) break;
        const v = b.readBigUInt64LE(tOff);
        if (v === 0n) break;
        if ((v & 0x8000000000000000n) === 0n) {
          const nm = H.rvaToOff(Number(v & 0x7fffffffn) + 2);
          if (nm !== null) {
            let q = nm; while (b[q]) q++;
            out.set(b.slice(nm, q).toString('latin1'), { dll, iatRVA: firstThunk + k * 8 });
          }
        }
      }
    }
    o += 20;
  }
  return out;
}

// ================================================================ 重定位表

function readRelocs(pe, H) {
  const b = pe.buf;
  const dd = pe.optOff + 112 + 5 * 8;
  const relRVA = b.readUInt32LE(dd);
  const relSize = b.readUInt32LE(dd + 4);
  const set = new Set();
  if (!relRVA || !relSize) return set;
  const base = H.rvaToOff(relRVA);
  if (base === null) return set;
  let o = base;
  const end = Math.min(base + relSize, b.length);
  while (o + 8 <= end) {
    const page = b.readUInt32LE(o);
    const size = b.readUInt32LE(o + 4);
    if (size < 8) break;
    const n = (size - 8) / 2;
    for (let i = 0; i < n; i++) {
      const w = b.readUInt16LE(o + 8 + i * 2);
      const type = w >> 12, off = w & 0xfff;
      if (type === 10 || type === 3) set.add(page + off);
    }
    o += size;
  }
  return set;
}

// ================================================================ 引用扫描

function findLeaRefs(pe) {
  const b = pe.buf;
  const text = pe.sections.find(s => s.name === '.text');
  if (!text) throw new Error('找不到 .text 节区');
  const map = new Map();
  const end = text.raw + Math.min(text.vsize, text.rawSize) - 10;
  for (let off = text.raw; off < end; off++) {
    const rex = b[off];
    if (rex < 0x48 || rex > 0x4f) continue;
    const op = b[off + 1];
    if (op !== 0x8d && op !== 0x8b && op !== 0x3b) continue;
    if ((b[off + 2] & 0xc7) !== 0x05) continue;
    const rva = text.va + (off - text.raw);
    const target = (rva + 7 + b.readInt32LE(off + 3)) >>> 0;
    if (!map.has(target)) map.set(target, []);
    map.get(target).push({ off, rva, len: 7 });
  }
  return map;
}

function findDataPtrs(pe) {
  const b = pe.buf;
  const map = new Map();
  for (const s of pe.sections) {
    if (s.name !== '.data' && s.name !== '.rdata') continue;
    for (let off = s.raw; off + 8 <= s.raw + s.rawSize; off += 8) {
      const p = b.readBigUInt64LE(off);
      if (p < pe.imageBase || p >= pe.imageBase + 0x400000n) continue;
      const r = Number(p - pe.imageBase);
      if (!map.has(r)) map.set(r, []);
      map.get(r).push({ off, rva: s.va + (off - s.raw) });
    }
  }
  return map;
}

function findCallSites(pe, targetRVA) {
  const b = pe.buf;
  const text = pe.sections.find(s => s.name === '.text');
  const out = [];
  const end = text.raw + Math.min(text.vsize, text.rawSize);
  for (let off = text.raw; off + 5 <= end; off++) {
    if (b[off] !== 0xe8) continue;
    const rva = text.va + (off - text.raw);
    if (((rva + 5 + b.readInt32LE(off + 1)) >>> 0) === targetRVA) out.push({ off, rva });
  }
  return out;
}

// ================================================================ 汇编器

class Asm {
  constructor() { this.b = []; this.labels = new Map(); this.fix = []; }
  get pc() { return this.b.length; }
  db(...v) { for (const x of v) this.b.push(x & 0xff); }
  label(n) { this.labels.set(n, this.pc); }
  /** 4 字节 RIP 相对占位。target: 绝对 RVA(数字) 或 标签名(字符串) */
  rel(target) { const at = this.pc; this.db(0, 0, 0, 0); this.fix.push({ at, target }); }
  /** codeRVA: 该段代码的绝对 RVA */
  resolve(codeRVA) {
    for (const f of this.fix) {
      const t = (typeof f.target === 'number')
        ? f.target
        : codeRVA + this.labels.get(f.target);
      if (t === undefined) throw new Error('未定义的汇编标签: ' + f.target);
      const disp = (t - (codeRVA + f.at + 4)) | 0;
      this.b[f.at] = disp & 0xff;
      this.b[f.at + 1] = (disp >>> 8) & 0xff;
      this.b[f.at + 2] = (disp >>> 16) & 0xff;
      this.b[f.at + 3] = (disp >>> 24) & 0xff;
    }
    this.fix = [];
    return this.b;
  }
}

// ================================================================ 词条

/**
 * 严格解析 printf 转换说明符（%s/%d/%02lld/%.1f/…）。
 * 译文必须与原文有**完全相同、同顺序**的说明符列表 —— vsnprintf 是按位置取参数的，
 * 个数或顺序一变，就会把指针当整数读（典型症状：reading address FFFFFFFFFFFFFFFF）、
 * 或把整数当指针解引用，直接让游戏崩掉。
 */
function printfSpecs(s) {
  const specs = [], bad = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '%') continue;
    if (s[i + 1] === '%') { i++; continue; }
    let j = i + 1;
    while (j < s.length && ' -+0#'.includes(s[j])) j++;
    while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
    if (s[j] === '.') { j++; while (j < s.length && s[j] >= '0' && s[j] <= '9') j++; }
    while (j < s.length && 'hlLjzt'.includes(s[j])) j++;
    const conv = s[j];
    if (!conv || !'diouxXeEfFgGaAcspn'.includes(conv)) { bad.push(s.slice(i, i + 6)); continue; }
    specs.push(s.slice(i, j + 1));
    i = j;
  }
  return { specs, bad };
}

function checkPrintfSpecs(file, key, en, zh) {
  if (en !== '' && zh === '') {
    throw new Error(file + ': 0x' + key + ' 的译文是空字符串（这会让游戏弹出 ImGui 断言并中止）：\n' +
                    '    ImGui 拿这些字符串当控件 / 窗口的 label，空 label 会让 GetID("") 等于窗口自己的 ID，\n' +
                    '    从而触发 ItemAdd() 里的 IM_ASSERT(id != window->ID)。\n' +
                    '    若原文只是英文复数后缀、中文里不该显示任何东西，请改用 "\\u200b"（零宽空格）：\n' +
                    '    它同样不可见，但能让 ID 非空。\n' +
                    '    原文 ' + JSON.stringify(en));
  }
  const A = printfSpecs(en), B = printfSpecs(zh);
  if (B.bad.length) {
    throw new Error(file + ': 0x' + key + ' 译文里有非法的 % 序列 ' + JSON.stringify(B.bad) +
                    '：\n    译文 ' + JSON.stringify(zh));
  }
  if (A.specs.join('|') !== B.specs.join('|')) {
    throw new Error(file + ': 0x' + key + ' 译文与原文的格式化参数不一致（这会让游戏崩溃）：\n' +
                    '    原文 ' + JSON.stringify(en) + '\n      -> ' + A.specs.join(' ') + '\n' +
                    '    译文 ' + JSON.stringify(zh) + '\n      -> ' + B.specs.join(' ') + '\n' +
                    '    请调整译文，使 % 说明符的**个数与顺序**与原文完全一致。');
  }
}

function loadTranslations(dir) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const out = new Map();
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const [k, v] of Object.entries(j)) {
      if (k.startsWith('_')) continue;
      const rva = parseInt(k, 16);
      if (!Number.isFinite(rva)) throw new Error(f + ': 非法的 RVA 键 ' + k);
      if (!v || typeof v.zh !== 'string') throw new Error(f + ': ' + k + ' 缺少 zh');
      if (typeof v.en !== 'string') throw new Error(f + ': ' + k + ' 缺少 en（校验用原文）');
      checkPrintfSpecs(f, k, v.en, v.zh);
      if (out.has(rva)) {
        const prev = out.get(rva);
        if (prev.zh !== v.zh || prev.en !== v.en) {
          throw new Error('词条 0x' + k + ' 在多个文件里译文不一致 (' + prev.file + ' / ' + f + ')');
        }
        continue;                                  // 完全相同的重复，忽略
      }
      out.set(rva, { en: v.en, zh: v.zh, file: f });
    }
  }
  return out;
}

// ================================================================ 主流程

function main() {
  if (!fs.existsSync(IN_DLL)) {
    console.error('');
    console.error('错误：找不到原版 steam_api64.dll');
    console.error('  已查找：' + IN_DLL);
    console.error('');
    console.error('请下载 RE2CabbyCodes 1.0.6 的原版发布包，把它里面的 steam_api64.dll');
    console.error('复制到本脚本所在目录（和 patch.js 放在一起），然后重新运行；');
    console.error('也可以用 --in <路径> 直接指定文件位置。');
    console.error('');
    process.exit(1);
  }
  const orig = fs.readFileSync(IN_DLL);
  const pe = parsePE(orig);
  const H = helpersFor(pe);
  const log = console.log;

  log('');
  log('RE2CabbyCodes 汉化补丁');
  log('  输入   : ' + IN_DLL + '  (' + orig.length + ' 字节)');
  log('  输出   : ' + (ARGS.dryRun ? '(dry-run，不写文件)' : OUT_DLL));
  log('  版本印记: ' + (orig.includes(Buffer.from('RE2CabbyCodes 1.0.6 loaded', 'latin1')) ? 'RE2CabbyCodes 1.0.6' : '未知（继续）'));

  // ---- 符号
  const syms = readSymbols(pe);
  const sym = (n) => {
    const v = syms.get(n);
    if (v === undefined) throw new Error('符号表中找不到 ' + n + '，无法安全打补丁');
    return v;
  };
  const RVA_FFT = sym('_ZN11ImFontAtlas18AddFontFromFileTTFEPKcfPK12ImFontConfigPKt');
  const RVA_FDEF = sym('_ZN11ImFontAtlas14AddFontDefaultEPK12ImFontConfig');
  const RVA_CJK = sym('_ZN11ImFontAtlas37GetGlyphRangesChineseSimplifiedCommonEv');
  const RVA_CFGCTOR = sym('_ZN12ImFontConfigC1Ev');
  if (ARGS.font) {
    log('  ImGui   : AddFontFromFileTTF @0x' + RVA_FFT.toString(16) +
        ', AddFontDefault @0x' + RVA_FDEF.toString(16) +
        ', GetGlyphRangesChineseSimplifiedCommon @0x' + RVA_CJK.toString(16) +
        ', ImFontConfig::ImFontConfig @0x' + RVA_CFGCTOR.toString(16));
  }
  const fontCalls = findCallSites(pe, RVA_FDEF);
  if (ARGS.font && fontCalls.length !== 1) {
    throw new Error('预期恰好 1 处 AddFontDefault 调用点，实际 ' + fontCalls.length + ' 处 —— 拒绝修改');
  }
  const fontCall = fontCalls[0];
  if (ARGS.font) log('  调用点 : AddFontDefault @0x' + fontCall.rva.toString(16));

  const imports = readImports(pe, H);
  const gfa = imports.get('GetFileAttributesA');
  if (ARGS.font && !gfa) throw new Error('导入表中找不到 GetFileAttributesA');

  // ---- 词条
  const tr = loadTranslations(TR_DIR);
  log('  词条   : ' + tr.size + ' 条，来自 ' + TR_DIR);

  // --mark：把可识别标记写进启动日志那一行，便于从 RE2CabbyCodes.log 判断装的是哪个变体。
  // 即使词条目录是空的（只注入字体、不换文本）也会强制注入这一条。
  if (ARGS.mark) {
    const KEY = 0x161a78;
    const e = tr.get(KEY) || {
      en: 'RE2CabbyCodes 1.0.6 loaded (steam_api64.dll proxy), dir=%s pid=%lu thread=%lu',
      zh: 'RE2CabbyCodes 1.0.6 loaded (steam_api64.dll proxy), dir=%s pid=%lu thread=%lu',
      file: '(mark)',
    };
    e.zh = e.zh.replace(/\s*\[汉化 [^\]]*\]/, '')
                .replace('proxy)', 'proxy) [汉化 ' + ARGS.mark + ']');
    tr.set(KEY, e);
    log('  日志标记: [汉化 ' + ARGS.mark + ']');
  }

  // ---- 引用
  const leaRefs = findLeaRefs(pe);
  const ptrRefs = findDataPtrs(pe);
  const relocs = readRelocs(pe, H);

  const inPlace = [], move = [], problems = [], skipped = [];
  for (const [rva, e] of [...tr.entries()].sort((a, b) => a[0] - b[0])) {
    const off = H.rvaToOff(rva);
    if (off === null) { problems.push('0x' + rva.toString(16) + ' 不在任何节区内'); continue; }
    const raw = orig.slice(off, off + e.en.length).toString('latin1');
    if (raw !== e.en) {
      problems.push('0x' + rva.toString(16) + ' 原文不符\n      期望 ' + JSON.stringify(e.en) + '\n      实际 ' + JSON.stringify(raw));
      continue;
    }
    if (orig[off + e.en.length] !== 0) { problems.push('0x' + rva.toString(16) + ' 原文未以 NUL 结尾'); continue; }
    const bytes = Buffer.from(e.zh, 'utf8');
    const lea = leaRefs.get(rva) || [];
    const ptr = ptrRefs.get(rva) || [];
    if (bytes.length <= e.en.length) {
      inPlace.push({ rva, zh: e.zh, bytes, room: e.en.length, refs: lea.length + ptr.length });
    } else {
      if (!lea.length && !ptr.length) { skipped.push({ rva, en: e.en, zh: e.zh, reason: '译文过长且无引用可改写' }); continue; }
      let bad = false;
      for (const p of ptr) {
        if (!relocs.has(p.rva)) {
          problems.push('0x' + rva.toString(16) + ' 的指针 0x' + p.rva.toString(16) + ' 没有重定位项，改写后可能失效');
          bad = true;
        }
      }
      if (bad) continue;
      move.push({ rva, zh: e.zh, bytes, lea, ptr });
    }
  }

  if (problems.length) {
    console.error('\n发现 ' + problems.length + ' 个问题，未做任何修改：\n');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  if (skipped.length) {
    log('\n  [!] ' + skipped.length + ' 条译文放不下又没有引用可改写，保持英文：');
    for (const s of skipped) log('      0x' + s.rva.toString(16) + '  ' + JSON.stringify(s.en) + '  译文 ' + JSON.stringify(s.zh) + ' (' + Buffer.byteLength(s.zh, 'utf8') + ' > ' + Buffer.byteLength(s.en, 'utf8') + ')');
  }
  log('  原地替换: ' + inPlace.length + ' 条（原文足够长）');
  log('  重定位  : ' + move.length + ' 条（译文更长，写入新节区并改写引用）');

  if (ARGS.list) {
    log('\n--- 词条明细 ---');
    const rows = [...inPlace.map(x => [x.rva, x.en || '', x.zh, x.bytes.length, x.room, 'inplace', x.refs]),
                  ...move.map(x => [x.rva, '', x.zh, x.bytes.length, 0, 'move', x.lea.length + x.ptr.length])];
    rows.sort((a, b) => a[0] - b[0]);
    for (const r of rows) log('  0x' + r[0].toString(16).padStart(6, '0') + '  ' + String(r[3]).padStart(4) + 'B  ' + r[5] + '  ' + JSON.stringify(r[2]));
    return;
  }

  // ---- 新节区布局
  const last = pe.sections[pe.sections.length - 1];
  const secRVA = align(last.va + Math.max(last.vsize, last.rawSize), pe.sectionAlign);
  const rawOff = align(orig.length, pe.fileAlign);
  const secName = '.re2zh';

  const headerOff = pe.optOff + pe.optSize + pe.nSec * 40;
  if (headerOff + 40 > pe.sizeOfHeaders) throw new Error('PE 头部空间不足，无法新增节区头');
  for (let i = headerOff; i < headerOff + 40; i++) {
    if (orig[i] !== 0) throw new Error('新节区头位置 0x' + i.toString(16) + ' 非空，拒绝修改');
  }

  const defaultFonts = ARGS.fonts || [
    'C:\\Windows\\Fonts\\msyh.ttc',
    'C:\\Windows\\Fonts\\msyh.ttf',
    'C:\\Windows\\Fonts\\msyhl.ttc',
    'C:\\Windows\\Fonts\\simhei.ttf',
    'C:\\Windows\\Fonts\\Deng.ttf',
    'C:\\Windows\\Fonts\\simsun.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  ];

  // ---- 字形范围（基础区 + ImGui 2500 常用字 + 本补丁译文用字）
  const glyphRanges = ARGS.font && !ARGS.fontMin ? buildGlyphRanges(pe, H, syms, tr) : [];

  // 数据区（放在代码之前，这样生成代码时数据偏移已知）
  let sizeOff = 0, glyphOff = 0, pathTableOff = 0, codeOff = 0;
  const pathOffs = [];
  if (ARGS.font && !ARGS.fontMin) {
    sizeOff = 0;                                        // float 字号
    glyphOff = 8;                                       // ImWchar[] 字形范围
    let cursor = glyphOff + glyphRanges.length * 2;
    cursor = align(cursor, 8);
    pathTableOff = cursor;                              // int32 相对偏移表，以 -1 结尾
    cursor += defaultFonts.length * 4 + 4;
    for (const p of defaultFonts) { pathOffs.push(cursor); cursor += Buffer.byteLength(p, 'utf8') + 1; }
    codeOff = align(cursor, 16);
  }
  const codeRVA = secRVA + codeOff;

  // ---- trampoline 机器码（仅在注入字体时生成）
  //
  // 重要：整个 trampoline 只用 RIP 相对寻址，新节区里不放任何绝对地址。
  // DLL 带 DYNAMIC_BASE（会被 ASLR 重定位），而新节区没有重定位项，放绝对指针
  // 会失效；失效会让 AddFontFromFileTTF 加载失败，进而触发 ImGui 的断言
  // （本 MOD 没定义 NDEBUG，assert 是开着的）而中止进程。
  let codeBytes = [];
  if (ARGS.font) {
    const CFG = 0x30;                                   // 栈上的 ImFontConfig（0x90 字节）
    const a = new Asm();
    if (ARGS.fontMin) {
      // 极简模式（--font-min）：只把 AddFontDefault 转发出去，不构造 ImFontConfig、
      // 不读任何文件、不引用任何数据。用来把「调用新节区里的代码」这件事本身
      // 和「我额外加的那几个调用」分开定位。
      a.db(0x53, 0x55, 0x41, 0x54);                     // push rbx / rbp / r12
      a.db(0x48, 0x83, 0xec, CFG);                      // sub rsp, 0x30
      a.db(0x48, 0x89, 0xcb);                           // mov rbx, rcx
      a.db(0xe8); a.rel(RVA_FDEF);                      // call AddFontDefault
      a.db(0x48, 0x83, 0xc4, CFG, 0x41, 0x5c, 0x5d, 0x5b, 0xc3); // add rsp,0x30; pop r12/rbp/rbx; ret
      codeBytes = a.resolve(codeRVA);
    } else if (ARGS.fontSimple) {
      // 最小字体加载（--font-simple）：依次直接试候选路径，不用 GetFileAttributesA
      // 预筛、也不构造 ImFontConfig（font_cfg 传 NULL，由 AddFontFromFileTTF 自己
      // 取默认配置）。AddFontFromFileTTF 失败只会返回 NULL，不会中止进程。
      a.db(0x53, 0x55, 0x41, 0x54);                     // push rbx / rbp / r12
      a.db(0x48, 0x83, 0xec, 0x40);                     // sub rsp, 0x40
      a.db(0x48, 0x89, 0xcb);                           // mov rbx, rcx          (ImFontAtlas*)
      a.db(0x48, 0x8d, 0x05); a.rel(secRVA + glyphOff); // lea rax, [rip + glyphRanges]
      a.db(0x48, 0x89, 0x44, 0x24, 0x20);               // mov [rsp+0x20], rax   (第 5 个参数)
      a.db(0x4c, 0x8d, 0x25); a.rel(secRVA + pathTableOff); // lea r12, [rip + pathTable]
      a.label('loop');
      a.db(0x49, 0x63, 0x04, 0x24);                     // movsxd rax, dword [r12]
      a.db(0x83, 0xf8, 0xff);                           // cmp eax, -1
      a.db(0x0f, 0x84); a.rel('fallback');              // je fallback
      a.db(0x49, 0x8d, 0x14, 0x04);                     // lea rdx, [r12+rax]    (路径)
      a.db(0x48, 0x89, 0xd5);                           // mov rbp, rdx
      a.db(0x48, 0x89, 0xd9);                           // mov rcx, rbx
      a.db(0xf3, 0x0f, 0x10, 0x15); a.rel(secRVA + sizeOff); // movss xmm2, [rip + size]
      a.db(0x45, 0x31, 0xc9);                           // xor r9d, r9d          (font_cfg = NULL)
      a.db(0xe8); a.rel(RVA_FFT);                       // call AddFontFromFileTTF
      a.db(0x48, 0x85, 0xc0);                           // test rax, rax
      a.db(0x0f, 0x85); a.rel('done');                  // jnz done
      a.db(0x49, 0x83, 0xc4, 0x04);                     // add r12, 4
      a.db(0xe9); a.rel('loop');                        // jmp loop
      a.label('fallback');
      a.db(0x48, 0x89, 0xd9);                           // mov rcx, rbx
      a.db(0xe8); a.rel(RVA_FDEF);                      // call AddFontDefault
      a.label('done');
      a.db(0x48, 0x83, 0xc4, 0x40, 0x41, 0x5c, 0x5d, 0x5b, 0xc3); // add rsp,0x40; pop r12/rbp/rbx; ret
      codeBytes = a.resolve(codeRVA);
    } else {
    a.db(0x53, 0x55, 0x41, 0x54);                       // push rbx / rbp / r12
    a.db(0x48, 0x83, 0xec, 0xc0);                       // sub rsp, 0xc0
    a.db(0x48, 0x89, 0xcb);                             // mov rbx, rcx           (ImFontAtlas*)
    a.db(0x48, 0x8d, 0x4c, 0x24, CFG);                  // lea rcx, [rsp+0x30]
    a.db(0xe8); a.rel(RVA_CFGCTOR);                     // call ImFontConfig::ImFontConfig()
    a.db(0x83, 0x8c, 0x24, CFG + 0x74, 0x00, 0x00, 0x00, 0x02); // or dword [rsp+0xa4], 2  (Flags |= ImFontFlags_NoLoadError)
    a.db(0x48, 0x8d, 0x05); a.rel(secRVA + glyphOff);   // lea rax, [rip + glyphRanges]
    a.db(0x48, 0x89, 0x44, 0x24, 0x20);                 // mov [rsp+0x20], rax    (glyph_ranges，第 5 个参数)
    a.db(0x4c, 0x8d, 0x25); a.rel(secRVA + pathTableOff); // lea r12, [rip + pathTable]
    a.label('loop');
    a.db(0x49, 0x63, 0x04, 0x24);                       // movsxd rax, dword [r12]
    a.db(0x83, 0xf8, 0xff);                             // cmp eax, -1
    a.db(0x0f, 0x84); a.rel('fallback');                // je fallback
    a.db(0x49, 0x8d, 0x14, 0x04);                       // lea rdx, [r12+rax]     (路径 = 表基址 + 相对偏移)
    a.db(0x48, 0x89, 0xd5);                             // mov rbp, rdx
    a.db(0x48, 0x89, 0xd1);                             // mov rcx, rdx
    a.db(0xff, 0x15); a.rel(gfa.iatRVA);                // call qword [GetFileAttributesA]
    a.db(0x83, 0xf8, 0xff);                             // cmp eax, -1 (INVALID_FILE_ATTRIBUTES)
    a.db(0x0f, 0x84); a.rel('next');                    // je next
    a.db(0xa9, 0x10, 0x00, 0x00, 0x00);                 // test eax, FILE_ATTRIBUTE_DIRECTORY
    a.db(0x0f, 0x85); a.rel('next');                    // jnz next
    a.db(0x48, 0x89, 0xd9);                             // mov rcx, rbx
    a.db(0x48, 0x89, 0xea);                             // mov rdx, rbp
    a.db(0xf3, 0x0f, 0x10, 0x15); a.rel(secRVA + sizeOff); // movss xmm2, [rip + size]
    a.db(0x4c, 0x8d, 0x4c, 0x24, CFG);                  // lea r9, [rsp+0x30]     (font_cfg)
    a.db(0xe8); a.rel(RVA_FFT);                         // call AddFontFromFileTTF
    a.db(0x48, 0x85, 0xc0);                             // test rax, rax
    a.db(0x0f, 0x85); a.rel('done');                    // jnz done
    a.label('next');
    a.db(0x49, 0x83, 0xc4, 0x04);                       // add r12, 4
    a.db(0xe9); a.rel('loop');                          // jmp loop
    a.label('fallback');
    a.db(0x48, 0x89, 0xd9);                             // mov rcx, rbx
    a.db(0xe8); a.rel(RVA_FDEF);                        // call AddFontDefault
    a.label('done');
    a.db(0x48, 0x83, 0xc4, 0xc0, 0x41, 0x5c, 0x5d, 0x5b, 0xc3); // add rsp,0xc0; pop r12; pop rbp; pop rbx; ret
    codeBytes = a.resolve(codeRVA);
    }
  }
  const codeSize = codeBytes.length;

  // 译文重定位区
  let strOff = align(codeOff + codeSize, 8);
  const moveNewRVA = new Map();
  for (const m of move) { moveNewRVA.set(m.rva, secRVA + strOff); strOff += m.bytes.length + 1; }
  const secVSize = strOff;
  const secRawSize = align(secVSize, pe.fileAlign);
  const newSizeOfImage = align(secRVA + secVSize, pe.sectionAlign);

  log('  新节区 : ' + secName + '  RVA 0x' + secRVA.toString(16) + '  虚拟大小 0x' + secVSize.toString(16) +
      '  文件偏移 0x' + rawOff.toString(16));
  log('  trampoline: ' + (ARGS.font
    ? codeSize + ' 字节 @ 0x' + codeRVA.toString(16) +
      (ARGS.fontMin ? '（极简：只转发 AddFontDefault）'
                    : '（' + defaultFonts.length + ' 个候选字体, ' + ARGS.fontSize + 'px）')
    : '未生成（--no-font）'));
  if (ARGS.font && glyphRanges.length) {
    let chars = 0;
    for (let i = 0; i < glyphRanges.length - 1; i += 2) chars += glyphRanges[i + 1] - glyphRanges[i] + 1;
    log('  字形范围: ' + ((glyphRanges.length - 1) / 2) + ' 段 / ' + chars + ' 个码位（常用字 + 本补丁译文用字）');
  }

  if (ARGS.dryRun) { log('\n[dry-run] 全部检查通过，未写文件。'); return; }

  // ---- 组装
  const out = Buffer.from(orig);
  const sec = Buffer.alloc(secRawSize);

  // 数据区 + 代码（仅在注入字体时）
  if (ARGS.font && !ARGS.fontMin) {
    sec.writeFloatLE(ARGS.fontSize, sizeOff);
    glyphRanges.forEach((v, i) => sec.writeUInt16LE(v, glyphOff + i * 2));
    // 字体路径表：int32 相对偏移（相对表自身起点），以 -1 结尾。
    // 不放绝对地址 —— 新节区没有重定位项，绝对地址在 ASLR 下会失效。
    defaultFonts.forEach((p, i) => {
      sec.write(p + '\0', pathOffs[i], 'latin1');
      sec.writeInt32LE(pathOffs[i] - pathTableOff, pathTableOff + i * 4);
    });
    sec.writeInt32LE(-1, pathTableOff + defaultFonts.length * 4);
  }
  if (ARGS.font) codeBytes.forEach((v, i) => sec[codeOff + i] = v);
  // 重定位的译文
  for (const m of move) sec.write(m.bytes.toString('utf8'), moveNewRVA.get(m.rva) - secRVA, 'utf8');

  // 原地替换
  for (const w of inPlace) {
    const off = H.rvaToOff(w.rva);
    out.fill(0, off, off + w.room + 1);
    out.write(w.zh, off, 'utf8');
  }
  // 改写引用
  for (const m of move) {
    const nrva = moveNewRVA.get(m.rva);
    for (const r of m.lea) out.writeInt32LE((nrva - (r.rva + r.len)) | 0, r.off + 3);
    for (const p of m.ptr) out.writeBigUInt64LE(pe.imageBase + BigInt(nrva), p.off);
  }
  // 字体调用点
  if (ARGS.font) {
    out.writeUInt8(0xe8, fontCall.off);
    out.writeInt32LE((codeRVA - (fontCall.rva + 5)) | 0, fontCall.off + 1);
  }

  // 追加新节区
  const gap = Buffer.alloc(rawOff - out.length);
  const grown = Buffer.concat([out, gap, sec]);
  // 新节表项
  const hdr = Buffer.alloc(40);
  hdr.write(secName, 0, 'latin1');
  hdr.writeUInt32LE(secVSize, 8);
  hdr.writeUInt32LE(secRVA, 12);
  hdr.writeUInt32LE(secRawSize, 16);
  hdr.writeUInt32LE(rawOff, 20);
  hdr.writeUInt32LE(0, 24);
  hdr.writeUInt32LE(0, 28);
  hdr.writeUInt16LE(0, 32);
  hdr.writeUInt16LE(0, 34);
  hdr.writeUInt32LE(0x60000020, 36);                     // CNT_CODE | MEM_EXECUTE | MEM_READ
  hdr.copy(grown, headerOff);
  grown.writeUInt16LE(pe.nSec + 1, pe.numberOfSectionsOff);
  grown.writeUInt32LE(newSizeOfImage, pe.sizeOfImageOff);

  fs.mkdirSync(path.dirname(OUT_DLL), { recursive: true });
  fs.writeFileSync(OUT_DLL, grown);
  log('\n已写出 : ' + OUT_DLL);
  log('  大小   : ' + orig.length + ' -> ' + grown.length + '  (+' + (grown.length - orig.length) + ')');

  verify(grown, { pe, inPlace, move, moveNewRVA, secRVA, secName, fontCall, font: ARGS.font, fontMin: !!ARGS.fontMin, fontSimple: !!ARGS.fontSimple,
                  codeOff, codeSize, codeRVA, RVA_FFT, RVA_FDEF, RVA_CFGCTOR, gfa,
                  glyphOff, glyphRanges, secVSize, pathTableOff, fontPaths: defaultFonts });
}

// ================================================================ 自检

function verify(buf, c) {
  const errors = [];
  const ok = (cond, msg) => { if (!cond) errors.push(msg); };
  let pe, H;
  try { pe = parsePE(buf); H = helpersFor(pe); } catch (e) { console.error('自检: PE 结构已损坏: ' + e.message); process.exit(1); }

  ok(pe.nSec === c.pe.nSec + 1, '节区数量未 +1');
  const sec = pe.sections.find(s => s.name === c.secName);
  ok(!!sec, '新节区不在节表中');
  if (sec) {
    ok(sec.va === c.secRVA, '新节区 RVA 不符');
    ok((sec.chars & 0x20000000) !== 0 && (sec.chars & 0x40000000) !== 0, '新节区缺少 EXECUTE/READ 属性');
  }
  ok(pe.sizeOfImage >= c.secRVA + c.codeSize, 'SizeOfImage 未覆盖新节区');

  for (const w of c.inPlace) {
    const off = H.rvaToOff(w.rva);
    ok(off !== null, '原地替换 RVA 无法映射 @0x' + w.rva.toString(16));
    if (off === null) continue;
    ok(buf.slice(off, off + w.bytes.length).toString('utf8') === w.zh, '原地替换内容不符 @0x' + w.rva.toString(16));
    ok(buf[off + w.bytes.length] === 0, '原地替换未以 NUL 结尾 @0x' + w.rva.toString(16));
    ok(w.bytes.length <= w.room, '原地替换越界 @0x' + w.rva.toString(16));
  }

  for (const m of c.move) {
    const nrva = c.moveNewRVA.get(m.rva);
    const off = H.rvaToOff(nrva);
    ok(off !== null, '重定位 RVA 无法映射 @0x' + m.rva.toString(16));
    if (off !== null) {
      ok(buf.slice(off, off + m.bytes.length).toString('utf8') === m.zh, '重定位内容不符 @0x' + m.rva.toString(16));
      ok(buf[off + m.bytes.length] === 0, '重定位未以 NUL 结尾 @0x' + m.rva.toString(16));
    }
    for (const r of m.lea) {
      ok(((r.rva + 7 + buf.readInt32LE(r.off + 3)) >>> 0) === nrva, 'lea 回填错误 @0x' + r.rva.toString(16));
    }
    for (const p of m.ptr) {
      ok(Number(buf.readBigUInt64LE(p.off) - pe.imageBase) === nrva, '数据指针回填错误 @0x' + p.rva.toString(16));
    }
  }

  // trampoline 内的 call / IAT 调用 / 数据引用
  if (c.font) {
    ok(((c.fontCall.rva + 5 + buf.readInt32LE(c.fontCall.off + 1)) >>> 0) === c.codeRVA, '字体调用点未指向 trampoline');
    const found = new Set();
    for (let i = 0; i + 5 <= c.codeSize; i++) {
      const off = H.rvaToOff(c.codeRVA + i);
      if (off === null || buf[off] !== 0xe8) continue;
      const target = (c.codeRVA + i + 5 + buf.readInt32LE(off + 1)) >>> 0;
      if (target === c.RVA_FFT || target === c.RVA_FDEF || target === c.RVA_CFGCTOR) found.add(target);
    }
    if (c.fontMin) {
      ok(found.size === 1 && found.has(c.RVA_FDEF), '极简 trampoline 应当只调用 AddFontDefault（找到 ' + found.size + ' 个 call）');
    } else {
    ok(found.size === (c.fontSimple ? 2 : 3),
       'trampoline 的 call 目标不正确（找到 ' + found.size + '/' + (c.fontSimple ? 2 : 3) + '）');
    if (!c.fontSimple) {
    // GetFileAttributesA 间接调用
    let okGfa = false;
    for (let i = 0; i + 6 <= c.codeSize; i++) {
      const off = H.rvaToOff(c.codeRVA + i);
      if (buf[off] === 0xff && buf[off + 1] === 0x15) {
        const target = (c.codeRVA + i + 6 + buf.readInt32LE(off + 2)) >>> 0;
        if (target === c.gfa.iatRVA) okGfa = true;
      }
    }
    ok(okGfa, 'trampoline 未引用 GetFileAttributesA 的 IAT 槽');
    }
    // 字形范围数组逐项核对
    const gOff = H.rvaToOff(c.secRVA + c.glyphOff);
    let okGlyphData = gOff !== null;
    if (okGlyphData) {
      for (let i = 0; i < c.glyphRanges.length; i++) {
        if (buf.readUInt16LE(gOff + i * 2) !== c.glyphRanges[i]) { okGlyphData = false; break; }
      }
      ok(buf.readUInt16LE(gOff + (c.glyphRanges.length - 1) * 2) === 0, '字形范围数组未以 0 结尾');
    }
    ok(okGlyphData, '字形范围数据未写入新节区');
    // 字体路径表：int32 相对偏移，以 -1 结尾，每项都要指回正确的路径
    const ptOff = H.rvaToOff(c.secRVA + c.pathTableOff);
    ok(ptOff !== null, '字体路径表不在新节区里');
    if (ptOff !== null) {
      let n = 0;
      for (; n < 64; n++) {
        const rel = buf.readInt32LE(ptOff + n * 4);
        if (rel === -1) break;
        const so = ptOff + rel;
        let e = so; while (e < buf.length && buf[e] !== 0) e++;
        const s = buf.slice(so, e).toString('latin1');
        ok(n < c.fontPaths.length && s === c.fontPaths[n], '字体路径表第 ' + n + ' 项不合法: ' + JSON.stringify(s));
      }
      ok(n === c.fontPaths.length, '字体路径表项数不符（' + n + ' / ' + c.fontPaths.length + '）');
    }
    }
    // 关键：新节区里不允许存在任何指向本模块的绝对地址
    //（新节区没有重定位项，DLL 又带 DYNAMIC_BASE，绝对地址在 ASLR 下必然失效）
    let abs = 0, firstAbs = '';
    for (let i = 0; i + 8 <= c.secVSize; i++) {
      const off = H.rvaToOff(c.secRVA + i);
      if (off === null) continue;
      const v = buf.readBigUInt64LE(off);
      if (v >= c.pe.imageBase && v < c.pe.imageBase + 0x400000n) {
        abs++;
        if (!firstAbs) firstAbs = ' +0x' + i.toString(16) + ' = 0x' + v.toString(16);
      }
    }
    ok(abs === 0, '新节区里有 ' + abs + ' 个绝对地址（ASLR 下会失效）' + firstAbs);
  }

  if (errors.length) {
    console.error('\n自检失败：');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('自检通过：节区 / 词条 / 引用回填 / trampoline 全部正常。');
}

try {
  main();
} catch (e) {
  console.error('\n错误: ' + e.message);
  if (process.env.RE2ZH_DEBUG) console.error(e.stack);
  process.exit(1);
}
