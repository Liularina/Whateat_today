/**
 * 语音解析器验证（阶段0-功能A）
 * 独立 JS 测试，不依赖 TS 编译。
 */
'use strict';

const UNITS = ['g', 'kg', '个', '袋', '盒'];

// ====== Parser Core ======

const CN_DIGITS = { 零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,百:100,千:1000,万:10000 };
function parseChineseNumber(text) {
  if (!text) return null; if (text==='半') return 0.5;
  let result=0,section=0;
  for (let i=0;i<text.length;i++) { const v=CN_DIGITS[text[i]]; if (v===undefined) return null;
    if (v>=10) { if (section===0) section=1; if (v===10000) { result+=section*10000; section=0; }
      else { section*=v; } } else { section+=v; } } result+=section; return result>0?result:null; }

function parseSpecialQuantity(text) {
  const OH = /^(一)(斤半)(\S*)$/; let m = text.match(OH); if (m) return {qty:1.5,unit:'斤',suffix:m[3]};
  m = /^(半)(斤)$/.exec(text); if (m) return {qty:0.5,unit:m[2],suffix:''};
  m = /^(一(?:斤)半)$/.exec(text); if (m) return {qty:1.5,unit:'斤',suffix:''};
  return null; }

const CNQ = /^([零一二两三四五六七八九十百千万半]+)(斤半?|克|千克|公斤|两|个|只|根|颗|把|袋|盒|瓶|包|份|条|块|片|碗|盘|串|升|毫升)(\S*)$/;
function parseCN(text) { const m=text.match(CNQ); if (!m) return null; const q=parseChineseNumber(m[1]); return q===null?null:{qty:q,unit:m[2],suffix:m[3]||''}; }

const ARQ = /^(\d+(?:\.\d+)?)\s*(克|千克|公斤|kg|斤|两|个|只|根|颗|把|袋|盒|瓶|包|份|条|块|片|碗|盘|串|升|毫升|ml|L)(\S*)$/i;
function parseAR(text) { const m=text.match(ARQ); if (!m) return null; const q=Number(m[1]); if (!Number.isFinite(q)||q<=0) return null; return {qty:q,unit:m[2],suffix:m[3]||''}; }

function extractQuantity(text) {
  if (!text) return {qty:null,unit:null,rest:''};
  const sp=parseSpecialQuantity(text); if (sp) return {qty:sp.qty,unit:sp.unit,rest:sp.suffix};
  const cn=parseCN(text); if (cn) return {qty:cn.qty,unit:cn.unit,rest:cn.suffix};
  const ar=parseAR(text); if (ar) return {qty:ar.qty,unit:ar.unit,rest:ar.suffix};
  // 后缀式："鸡蛋六个"、"土豆3个"
  { const m=text.match(/(.+?)([零一二两三四五六七八九十百千万半]+)(个|只|根|颗|把|袋|盒|瓶|包|份|条|块|片|碗|盘|串|斤|两|克|千克)$/); if (m) { const q=parseChineseNumber(m[2]); if (q!==null) return {qty:q,unit:m[3],rest:m[1].trim()}; } }
  { const m=text.match(/(.+?)(\d+(?:\.\d+)?)\s*(个|只|根|颗|把|袋|盒|瓶|包|份|条|块|片|碗|盘|串|斤|两|克|千克)$/); if (m) { const q=Number(m[2]); if (Number.isFinite(q)&&q>0) return {qty:q,unit:m[3],rest:m[1].trim()}; } }
  return {qty:null,unit:null,rest:text}; }

const SPLIT_RE = /[、,，\s]+|和|还有|以及|再买?|然后|接着|再加上?/g;
const PREFIX_CLEAN = /^(我(?:买了?|有|想买)|今天(?:买了?)?|已经?|买了?|家里有|买点)\s*/;

function parseVoiceText(raw) {
  let t=raw.replace(PREFIX_CLEAN,'').replace(/。/g,'、').replace(/[！？]/g,'').trim();
  if (!t) return [];
  const parts=t.split(SPLIT_RE).map(s=>s.trim()).filter(Boolean);
  if (parts.length<=1) {
    const {qty,unit,rest}=extractQuantity(t);
    let name=rest.trim()||t.trim();
    if (/^\d+(\.\d+)?$/.test(name)) return [];
    if (/^[零一二两三四五六七八九十百千万半]+$/.test(name)) return [];
    if (qty===null&&unit===null&&!name) return [];
    return [{name,qty,unit,start:0,end:t.length}];
  }
  let pos=0;
  const r=[];
  for (const p of parts) {
    const idx=t.indexOf(p,pos), start=idx>=0?idx:pos, end=start+p.length; pos=end;
    const {qty,unit,rest}=extractQuantity(p);
    let name=rest.trim()||p.trim();
    if (/^\d+(\.\d+)?$/.test(name)) continue;
    if (/^[零一二两三四五六七八九十百千万半]+$/.test(name)) continue;
    if (qty===null&&unit===null&&!name) continue;
    r.push({name,qty,unit,start,end});
  }
  return r;
}

// ====== Tests ======
let pass=0,fail=0;
function eq(a,b,l) { const sa=JSON.stringify(a),sb=JSON.stringify(b);
  if (sa===sb) { console.log('  [PASS] '+l); return true; }
  console.log('  [FAIL] '+l+'\n    got  '+sa+'\n    want '+sb); return false; }
function check(a,b,l) { eq(a,b,l)?pass++:fail++; }
function qtyEq(got,want,l) { check(got?got.qty:null,want.qty,'qty-'+l); check(got?got.unit:null,want.unit,'unit-'+l); check(got?got.name:null,want.name,'name-'+l); }

console.log('\n=== 语音解析器测试 ===\n');

// 单条 - 单位在前
check(parseVoiceText('两个西红柿'),[{name:'西红柿',qty:2,unit:'个',start:0,end:5}],'两个西红柿');
check(parseVoiceText('一斤青菜'),[{name:'青菜',qty:1,unit:'斤',start:0,end:4}],'一斤青菜');
check(parseVoiceText('三盒牛奶'),[{name:'牛奶',qty:3,unit:'盒',start:0,end:4}],'三盒牛奶');
check(parseVoiceText('500克鸡胸肉'),[{name:'鸡胸肉',qty:500,unit:'克',start:0,end:7}],'500克鸡胸肉');
check(parseVoiceText('半斤牛肉'),[{name:'牛肉',qty:0.5,unit:'斤',start:0,end:4}],'半斤牛肉');
check(parseVoiceText('一斤半排骨'),[{name:'排骨',qty:1.5,unit:'斤',start:0,end:5}],'一斤半排骨');
check(parseVoiceText('两斤土豆'),[{name:'土豆',qty:2,unit:'斤',start:0,end:4}],'两斤土豆');
check(parseVoiceText('3个鸡蛋'),[{name:'鸡蛋',qty:3,unit:'个',start:0,end:4}],'3个鸡蛋');
check(parseVoiceText('1.5千克排骨'),[{name:'排骨',qty:1.5,unit:'千克',start:0,end:7}],'1.5千克排骨');
check(parseVoiceText('五百克鸡胸肉'),[{name:'鸡胸肉',qty:500,unit:'克',start:0,end:6}],'五百克鸡胸肉');

// 单条 - 单位在后
check(parseVoiceText('鸡蛋六个'),[{name:'鸡蛋',qty:6,unit:'个',start:0,end:4}],'鸡蛋六个');
check(parseVoiceText('土豆2个'),[{name:'土豆',qty:2,unit:'个',start:0,end:4}],'土豆2个');
check(parseVoiceText('西红柿三斤'),[{name:'西红柿',qty:3,unit:'斤',start:0,end:5}],'西红柿三斤');

// 只说名称
check(parseVoiceText('西红柿'),[{name:'西红柿',qty:null,unit:null,start:0,end:3}],'只说名称');

// 边界
check(parseVoiceText(''),[],'空文本');
check(parseVoiceText('123'),[],'只有数字');
check(parseVoiceText('三五'),[],'中文数字');

// 多条
const multi=parseVoiceText('两个西红柿、三根黄瓜、一斤青菜');
console.log('  [INFO] 多条结果: '+JSON.stringify(multi.map(m=>({n:m.name,q:m.qty,u:m.unit}))));
check(multi.length,3,'多条数量=3');
if (multi.length>=3) {
  check(multi[0].name,'西红柿','多条-1名'); check(multi[0].qty,2,'多条-1量'); check(multi[0].unit,'个','多条-1单');
  check(multi[1].name,'黄瓜','多条-2名'); check(multi[1].qty,3,'多条-2量'); check(multi[1].unit,'根','多条-2单');
  check(multi[2].name,'青菜','多条-3名'); check(multi[2].qty,1,'多条-3量'); check(multi[2].unit,'斤','多条-3单');
}

// 口语前缀
const pfx=parseVoiceText('我买了两个西红柿');
if (pfx.length>=1) { check(pfx[0].name,'西红柿','前缀-名'); check(pfx[0].qty,2,'前缀-量'); }

// unit matching
function matchUnit(u,arr) { if (!u) return 0; const n=u.toLowerCase();
  const d=arr.findIndex(x=>x.toLowerCase()===n); if (d>=0) return d;
  const A={公斤:'kg',千克:'kg',两:'g',升:'L',毫升:'ml',只:'个',根:'个',颗:'个',条:'个',块:'个',片:'个',碗:'份',盘:'份',串:'份'};
  const m=A[u]||A[n]; if (m) { const i=arr.findIndex(x=>x.toLowerCase()===m.toLowerCase()); if (i>=0) return i; }
  return 0; }
check(matchUnit('斤',UNITS),0,'斤→g');
check(matchUnit('个',UNITS),2,'个→个');
check(matchUnit('千克',UNITS),1,'千克→kg');
check(matchUnit('克',UNITS),0,'克→g');
check(matchUnit('只',UNITS),2,'只→个');
check(matchUnit('盒',UNITS),4,'盒→盒');

console.log('\n========================================');
console.log('通过 '+pass+' 项，失败 '+fail+' 项');
console.log('========================================\n');
process.exit(fail>0?1:0);