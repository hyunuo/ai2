// Workflow Task 3 (코드): 기대값과 실제값을 비교해 Pass / Fail / 검토 필요 판정
//
// 사용법:
//   node code/03_judge.js [--actual <코드 1 결과>] [--out <결과 JSON>]
// 기본 입력:
//   output/actual_values.json
//   output/expected_nvme_spec.json, output/expected_spec_gap.json, output/expected_product_spec.json
//   output/eval/eval_2a.json, eval_2b.json, eval_2c.json
// 기본 출력:
//   output/judgement.json
//
// 판정 규칙 (위에서부터 먼저 걸리는 것 적용)
//   1. Gen / Eval 2회 초과 FAIL 필드            → 검토 필요 [기대값 검토 미통과]
//   2. Spec Gap 기대값이 TBD                     → 검토 필요 [기대값 미정 (TBD)]
//   3. Spec Gap과 제품 사양의 같은 항목 값이 다름 → 검토 필요 [문서 간 상충]
//   4. 적용 기대값 결정: 제품 기준(Spec Gap·제품 사양)의 확정값 + NVMe Spec 확정값
//      (Spec Gap에 행이 있는 필드는 Spec과 다른 정책이므로 NVMe Spec 기대값을 적용하지 않음)
//   5. 적용 기대값 중 하나라도 위반                → Fail
//   6. 제품 기준 확정값 없이 NVMe Spec 기대값만 있고 자동 판정할 수 없는 형태 → 검토 필요 [기대값 자동 판정 불가]
//   7. 확정 기대값이 하나도 없음: TBD가 있으면   → 검토 필요 [기대값 미정 (TBD)]
//                                없으면         → 검토 필요 [근거 문서 없음]
//   8. 그 외                                     → Pass

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAX_ITERATION = 3; // 최초 생성 1회 + 수정·재검토 최대 2회

const SOURCES = [
  { key: 'NVMe Spec', file: 'output/expected_nvme_spec.json', eval: 'output/eval/eval_2a.json', task: '2-a' },
  { key: 'Spec Gap', file: 'output/expected_spec_gap.json', eval: 'output/eval/eval_2b.json', task: '2-b' },
  { key: '제품 사양', file: 'output/expected_product_spec.json', eval: 'output/eval/eval_2c.json', task: '2-c' },
];
const PRODUCT = ['Spec Gap', '제품 사양'];

function parseArgs(argv) {
  const args = { actual: 'output/actual_values.json', out: 'output/judgement.json' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in args) || argv[i + 1] === undefined) throw new Error(`알 수 없는 인자: ${argv[i]}`);
    args[key] = argv[i + 1];
  }
  return args;
}

function readJson(rel) {
  const file = path.resolve(ROOT, rel);
  if (!fs.existsSync(file)) throw new Error(`입력 파일이 없습니다: ${rel}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const keyOf = f => `${f.structure}|${f.cli_name}`;

// ---------- 값 해석 ----------

function toBig(token) {
  if (token === undefined || token === null) return null;
  const t = String(token).trim().replace(/,/g, '');
  if (/^0x[0-9a-f]+$/i.test(t)) return BigInt(t);
  if (/^[0-9a-f]+h$/i.test(t)) return BigInt('0x' + t.slice(0, -1));
  if (/^[01]+b$/i.test(t)) return BigInt('0b' + t.slice(0, -1));
  if (/^\d+$/.test(t)) return BigInt(t);
  return null;
}

const fmt = v => (typeof v === 'bigint' ? (v > 9n ? `0x${v.toString(16)}` : v.toString()) : String(v));

// 조건부 문장(다른 필드·기능 지원 여부에 따라 달라지는 조건)은 이 필드만으로 판정할 수 없으므로 제외
const CONDITIONAL = /(이면|라면|하면|경우|때|지원 시|미지원 시|\bif\b|\bwhen\b)/i;

// 기대값 문장 → 판정 가능한 조건 목록. 해석할 수 없으면 null
function parseAssertions(text, actual) {
  const clauses = String(text || '').split(/(?<=[.。])\s+|;\s*|\n+/).map(c => c.trim()).filter(Boolean);
  const usable = clauses.filter(c => !CONDITIONAL.test(c));
  const t = usable.join('. ');
  if (!t) return null;
  const out = [];

  // Power State / LBA Format 같은 항목형 실제값
  if (actual && typeof actual === 'object') {
    // nvme-cli 표기(소문자)만 인식한다. 대문자(MP=2500 등)는 Spec 내부 인코딩 설명이라 제외
    const seen = new Set();
    for (const m of t.matchAll(/\b(mp|ms|lbads|rp|enlat|exlat|rrt|rrl|rwt|rwl)\s*[=:]\s*(\d+(?:\.\d+)?W?|0x[0-9a-f]+)/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({ kind: 'attr', key: m[1], value: m[2] });
    }
    if (/\bnon-operational\b/i.test(t)) out.push({ kind: 'attr', key: 'operational', value: false });
    else if (/\boperational\b/i.test(t)) out.push({ kind: 'attr', key: 'operational', value: true });
    if (/in[ _]use\s*(아님|아니|false|=\s*0)/i.test(t)) out.push({ kind: 'attr', key: 'in_use', value: false });
    else if (/in[ _]use/i.test(t)) out.push({ kind: 'attr', key: 'in_use', value: true });
    return out.length ? out : null;
  }

  // 비트 조건: bit7 = 0, bits[3:1](NOFS)=100b, bits 31:30 = 0
  const NUM = '0x[0-9a-f]+|[0-9a-f]+h|[01]+b|\\d[\\d,]*';
  const bitRe = new RegExp(`\\bbits?\\s*\\[?\\s*(\\d+)\\s*(?::\\s*(\\d+))?\\s*\\]?\\s*(?:\\([A-Za-z0-9_]+\\))?\\s*=\\s*(${NUM})(?:\\s*~\\s*(${NUM}))?(?![\\w.~-])`, 'gi');
  for (const m of t.matchAll(bitRe)) {
    const hi = Number(m[1]);
    const lo = m[2] !== undefined ? Number(m[2]) : hi;
    const range = { hi: Math.max(hi, lo), lo: Math.min(hi, lo) };
    if (m[4] !== undefined) out.push({ kind: 'bitsRange', ...range, min: toBig(m[3]), max: toBig(m[4]) });
    else out.push({ kind: 'bits', ...range, value: toBig(m[3]) });
  }
  // Reserved 비트 목록: Reserved 비트(30:28, 26:20, 18) = 0
  for (const m of t.matchAll(/Reserved\s*비트\s*\(([\d:,\s]+)\)\s*=\s*0(?![\w.])/gi)) {
    for (const part of m[1].split(',').map(x => x.trim()).filter(Boolean)) {
      const [hi, lo = hi] = part.split(':').map(Number);
      out.push({ kind: 'bits', hi: Math.max(hi, lo), lo: Math.min(hi, lo), value: 0n });
    }
  }
  // 필드 간 관계: HMPRE ≥ HMMIN, NUSE ≤ NCAP
  for (const m of t.matchAll(/(?<![\w.(])([A-Z][A-Z0-9]{2,})\s*(≤|≥|<=|>=)\s*([A-Z][A-Z0-9]{2,})(?![\w(]|\.[A-Za-z])/g)) {
    out.push({ kind: 'rel', left: m[1], op: m[2].replace('<=', '≤').replace('>=', '≥'), right: m[3] });
  }
  if (out.length) return out;

  // 단순 비교 (첫 문장 기준)
  const head = usable[0];
  let m;
  if ((m = head.match(new RegExp(`^(?:≤|<=)\\s*(${NUM})`, 'i')))) return [{ kind: 'le', value: toBig(m[1]) }];
  if ((m = head.match(new RegExp(`^(?:≥|>=)\\s*(${NUM})`, 'i')))) return [{ kind: 'ge', value: toBig(m[1]) }];
  if (/^(?:≠|!=)\s*0h?(?![\w.])|^0이 아닌/.test(head)) return [{ kind: 'ne', value: 0n }];
  if ((m = head.match(new RegExp(`^(${NUM})\\s*(?:~|–)\\s*(${NUM})(?![\\w.])`, 'i')))) return [{ kind: 'range', min: toBig(m[1]), max: toBig(m[2]) }];
  if ((m = head.match(new RegExp(`^(${NUM})\\s*또는\\s*(${NUM})(?![\\w.])`, 'i')))) return [{ kind: 'any', values: [toBig(m[1]), toBig(m[2])] }];
  // "0h = 미지원"처럼 값의 의미를 설명하는 문장은 기대값이 아님
  if ((m = head.match(new RegExp(`^(${NUM})(?![\\w.~-])(?!\\s*=)`, 'i')))) return [{ kind: 'eq', value: toBig(m[1]) }];

  // 문자열 값 (MN, FR, IEEE 등): 설명 없이 값만 적힌 경우
  const s = head.replace(/^"(.*)"$/, '$1');
  if (/^[\x21-\x7e][\x20-\x7e]*$/.test(s) && !/[=<>≤≥]/.test(s)) return [{ kind: 'str', value: s }];
  return null;
}

function bitsOf(v, hi, lo) {
  return (v >> BigInt(lo)) & ((1n << BigInt(hi - lo + 1)) - 1n);
}

function describe(a) {
  switch (a.kind) {
    case 'bits': return a.hi === a.lo ? `bit${a.hi} = ${fmt(a.value)}` : `bits ${a.hi}:${a.lo} = ${fmt(a.value)}`;
    case 'bitsRange': return `bits ${a.hi}:${a.lo} = ${fmt(a.min)}~${fmt(a.max)}`;
    case 'range': return `${fmt(a.min)} ~ ${fmt(a.max)}`;
    case 'eq': return fmt(a.value);
    case 'le': return `≤ ${fmt(a.value)}`;
    case 'ge': return `≥ ${fmt(a.value)}`;
    case 'ne': return '≠ 0';
    case 'any': return a.values.map(fmt).join(' 또는 ');
    case 'str': return `"${a.value}"`;
    case 'attr': return `${a.key} = ${a.value}`;
    case 'rel': return `${a.left} ${a.op} ${a.right}`;
    default: return '';
  }
}

// 조건 하나를 실제값에 적용: true(충족) / false(위반) / null(판정 불가)
// valueOf: Spec 필드 약어 → 실제값 (필드 간 관계 판정용)
function check(a, actual, valueOf = () => undefined) {
  if (a.kind === 'rel') {
    const l = toBig(valueOf(a.left));
    const r = toBig(valueOf(a.right));
    if (l === null || r === null) return null;
    return a.op === '≤' ? l <= r : l >= r;
  }
  if (a.kind === 'attr') {
    if (!actual || typeof actual !== 'object' || !(a.key in actual)) return null;
    const av = actual[a.key];
    if (typeof a.value === 'boolean') return av === a.value;
    const n = x => parseFloat(String(x).replace(/W$/, ''));
    return String(a.value).startsWith('0x') ? toBig(av) === toBig(a.value) : n(av) === n(a.value);
  }
  if (a.kind === 'str') {
    const norm = x => String(x).trim().replace(/-/g, '').toLowerCase();
    return norm(actual) === norm(a.value);
  }
  const v = toBig(actual);
  if (v === null) return null;
  switch (a.kind) {
    case 'bits': return bitsOf(v, a.hi, a.lo) === a.value;
    case 'bitsRange': { const b = bitsOf(v, a.hi, a.lo); return b >= a.min && b <= a.max; }
    case 'range': return v >= a.min && v <= a.max;
    case 'eq': return v === a.value;
    case 'le': return v <= a.value;
    case 'ge': return v >= a.value;
    case 'ne': return v !== a.value;
    case 'any': return a.values.some(x => x === v);
    default: return null;
  }
}

// 제품 기준 두 문서 사이의 상충: 같은 항목(같은 비트 범위, 같은 값 비교)에 다른 값
function conflicts(a, b) {
  const out = [];
  for (const x of a) {
    for (const y of b) {
      if (x.kind === 'bits' && y.kind === 'bits' && x.hi === y.hi && x.lo === y.lo && x.value !== y.value) out.push([x, y]);
      if (x.kind === 'eq' && y.kind === 'eq' && x.value !== y.value) out.push([x, y]);
      if (x.kind === 'str' && y.kind === 'str' && x.value !== y.value) out.push([x, y]);
      if (x.kind === 'attr' && y.kind === 'attr' && x.key === y.key && String(x.value) !== String(y.value)) out.push([x, y]);
    }
  }
  return out;
}

// ---------- 근거 표시 ----------

function shortEvidence(source, e) {
  if (!e) return source;
  const arr = v => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
  if (source === 'NVMe Spec') {
    const doc = /Command Set/i.test(e.document || '') ? 'NVM CS 1.1' : 'Base 2.1';
    return [`NVMe ${doc}`, e.section, e.figure].filter(Boolean).join(' ');
  }
  if (source === 'Spec Gap') {
    const rows = arr(e.rows);
    return `Spec Gap${rows.length ? ` ${rows.join('·')}행` : ''}${e.status ? ` (${e.status})` : ''}`;
  }
  const lines = arr(e.line);
  return `제품 사양${e.section ? ` ${e.section}` : ''}${lines.length ? ` L${lines.join('·')}` : ''}`;
}

// ---------- 판정 ----------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const actual = readJson(args.actual);

  const sources = SOURCES.map(s => {
    const data = readJson(s.file);
    const ev = readJson(s.eval);
    if (ev.result !== 'PASS' && (ev.target_iteration || 1) < MAX_ITERATION) {
      throw new Error(`${s.task}-E 결과가 FAIL입니다 (iteration ${ev.target_iteration}). Gen / Eval 반복을 먼저 끝내야 합니다.`);
    }
    const overflow = new Set(ev.result === 'PASS' ? [] : (ev.issues || []).map(i => `${i.structure}|${i.cli_name}`));
    return { ...s, data, ev, overflow, byKey: new Map(data.fields.map(f => [keyOf(f), f])) };
  });
  const src = Object.fromEntries(sources.map(s => [s.key, s]));

  // Spec 필드 약어(대문자) → 실제값. 필드 간 관계(HMPRE ≥ HMMIN 등) 판정에 사용
  const actualByName = new Map();
  for (const a of actual.fields) {
    const names = [a.cli_name.toUpperCase(), ...sources.map(s => s.byKey.get(keyOf(a))?.field).filter(Boolean)];
    names.forEach(n => { if (!actualByName.has(n)) actualByName.set(n, a.value); });
  }
  const valueOf = name => actualByName.get(name);

  const fields = actual.fields.map((a, idx) => {
    const k = keyOf(a);
    const entries = Object.fromEntries(sources.map(s => [s.key, s.byKey.get(k) || null]));
    const ref = entries['NVMe Spec'] || entries['Spec Gap'] || entries['제품 사양'] || {};

    const parsed = {};
    for (const s of sources) {
      const e = entries[s.key];
      parsed[s.key] = e && e.type !== 'not_defined' ? parseAssertions(e.expected, a.value) : null;
    }
    const confirmed = name => {
      const e = entries[name];
      return e && (e.type === 'fixed' || e.type === 'constraint');
    };

    let verdict = null;
    let reasonTypes = [];
    let reason = '';
    const applied = [];

    // 1. Gen / Eval 2회 초과 FAIL
    const overflowed = sources.filter(s => s.overflow.has(k)).map(s => s.key);
    if (overflowed.length) {
      verdict = '검토 필요';
      reasonTypes = ['기대값 검토 미통과'];
      reason = `${overflowed.join(', ')} 기대값이 Gen / Eval 2회 반복 후에도 검토를 통과하지 못함`;
    }

    // 2. Spec Gap TBD
    if (!verdict && entries['Spec Gap'] && entries['Spec Gap'].type === 'tbd') {
      const g = entries['Spec Gap'];
      verdict = '검토 필요';
      reasonTypes = ['기대값 미정 (TBD)'];
      reason = `Spec Gap 기대값이 확정되지 않음${g.evidence && g.evidence.status ? ` (상태: ${g.evidence.status})` : ''}${g.note ? ` — ${g.note}` : ''}`;
      if (confirmed('제품 사양') && parsed['제품 사양']) {
        const viol = parsed['제품 사양'].filter(x => check(x, a.value, valueOf) === false);
        reason += viol.length
          ? `. 제품 사양 기대값(${viol.map(describe).join(', ')})과도 다름`
          : '. 제품 사양 기대값과는 일치';
        if (viol.length) reasonTypes.push('문서 간 상충');
      }
    }

    // 3. Spec Gap ↔ 제품 사양 상충
    if (!verdict && confirmed('Spec Gap') && confirmed('제품 사양') && parsed['Spec Gap'] && parsed['제품 사양']) {
      const c = conflicts(parsed['Spec Gap'], parsed['제품 사양']);
      if (c.length) {
        verdict = '검토 필요';
        reasonTypes = ['문서 간 상충'];
        reason = `Spec Gap과 제품 사양의 기대값이 다름: ${c.map(([x, y]) => `${describe(x)} / ${describe(y)}`).join(', ')}`;
      }
    }

    if (!verdict) {
      // 4. 적용 기대값
      const useSpec = !entries['Spec Gap'] || entries['Spec Gap'].type === 'not_defined';
      const names = [...PRODUCT.filter(confirmed), ...(useSpec && confirmed('NVMe Spec') ? ['NVMe Spec'] : [])];
      const productConfirmed = PRODUCT.some(confirmed);
      let unparsedSpecOnly = false;

      for (const name of names) {
        const list = parsed[name];
        if (!list) {
          if (name === 'NVMe Spec' && !productConfirmed) unparsedSpecOnly = true;
          applied.push({ source: name, expected: entries[name].expected, result: 'unparsed', detail: '자동 판정할 수 없는 형태' });
          continue;
        }
        const results = list.map(x => ({ a: x, ok: check(x, a.value, valueOf) }));
        const bad = results.filter(r => r.ok === false);
        const unknown = results.filter(r => r.ok === null);
        applied.push({
          source: name,
          expected: entries[name].expected,
          result: bad.length ? 'violated' : unknown.length === results.length ? 'unparsed' : 'ok',
          detail: bad.length ? `위반: ${bad.map(r => describe(r.a)).join(', ')}` : results.map(r => describe(r.a)).join(', '),
        });
        if (name === 'NVMe Spec' && !productConfirmed && unknown.length === results.length) unparsedSpecOnly = true;
      }

      const violated = applied.filter(x => x.result === 'violated');
      const unparsedProduct = applied.filter(x => x.result === 'unparsed' && PRODUCT.includes(x.source));
      if (violated.length) {
        verdict = 'Fail';
        reason = violated.map(x => `${x.source} ${x.detail}`).join(' / ');
      } else if (unparsedProduct.length) {
        verdict = '검토 필요';
        reasonTypes = ['기대값 자동 판정 불가'];
        reason = `${unparsedProduct.map(x => x.source).join(', ')} 기대값이 자동 비교할 수 없는 형태라 사람 확인이 필요함: ${unparsedProduct.map(x => x.expected).join(' / ')}`;
      } else if (unparsedSpecOnly) {
        verdict = '검토 필요';
        reasonTypes = ['기대값 자동 판정 불가'];
        reason = 'NVMe Spec 기대값만 있고, 자동 비교할 수 없는 형태(다른 필드·기능 지원 여부에 따른 조건 등)라 사람 확인이 필요함';
      } else if (!applied.length) {
        const tbd = sources.filter(s => entries[s.key] && entries[s.key].type === 'tbd').map(s => s.key);
        verdict = '검토 필요';
        if (tbd.length) {
          reasonTypes = ['기대값 미정 (TBD)'];
          reason = `${tbd.join(', ')} 기대값이 확정되지 않았고 다른 문서에 확정 기대값이 없음`;
        } else {
          reasonTypes = ['근거 문서 없음'];
          reason = 'NVMe Spec · Spec Gap · 제품 사양 어디에도 기대값이 없음';
        }
      } else {
        verdict = 'Pass';
        reason = applied.filter(x => x.result === 'ok').map(x => `${x.source} 기대값 충족`).join(', ');
      }
    }

    // 표시용 문자열
    const shown = applied.length
      ? applied.map(x => x.source)
      : sources.filter(s => entries[s.key] && entries[s.key].type !== 'not_defined').map(s => s.key);
    const expectedDisplay = shown.map(n => `[${n}] ${entries[n].type === 'tbd' ? 'TBD' : ''}${entries[n].type === 'tbd' && entries[n].expected ? ' · ' : ''}${entries[n].expected || ''}`.trim()).join('\n') || '기대값 없음';
    const sourceDisplay = shown.map(n => shortEvidence(n, entries[n].evidence)).join('\n') || '없음';

    return {
      no: idx + 1,
      structure: a.structure,
      field: ref.field || a.cli_name.toUpperCase(),
      cli_name: a.cli_name,
      byte_offset: (entries['NVMe Spec'] && entries['NVMe Spec'].byte_offset) || ref.byte_offset || '',
      actual: a.value,
      verdict,
      review_reason_types: reasonTypes,
      reason,
      applied,
      expected_display: expectedDisplay,
      source_display: sourceDisplay,
      expected_by_source: Object.fromEntries(sources.map(s => {
        const e = entries[s.key];
        return [s.key, e ? { type: e.type, expected: e.expected, interpretation: e.interpretation, note: e.note, evidence: e.evidence } : null];
      })),
      expected_by_source_text: Object.fromEntries(sources.map(s => {
        const e = entries[s.key];
        const tag = !e ? '항목 없음' : e.type === 'not_defined' ? '정의 없음' : e.type === 'tbd' ? `TBD${e.expected ? ` (${e.expected})` : ''}` : e.expected;
        const ev = e && e.type !== 'not_defined' && e.evidence ? ` · ${shortEvidence(s.key, e.evidence)}` : '';
        const owner = s.key === 'Spec Gap' && e && e.evidence && e.evidence.owner ? ` · 담당: ${e.evidence.owner}` : '';
        return [s.key, `${tag}${ev}${owner}`];
      })),
    };
  });

  const count = list => ({
    total: list.length,
    pass: list.filter(f => f.verdict === 'Pass').length,
    fail: list.filter(f => f.verdict === 'Fail').length,
    review: list.filter(f => f.verdict === '검토 필요').length,
  });
  const structures = [...new Set(fields.map(f => f.structure))];

  const get = n => actual.fields.find(f => f.structure === 'Identify Controller' && f.cli_name === n)?.value || '';
  const product = get('mn');
  const result = {
    task: 'Workflow Task 3 - 필드별 판정',
    generated_at: new Date().toISOString(),
    meta: {
      product,
      model: product.split(/\s+/)[0] || 'UNKNOWN',
      fw: get('fr'),
      sn: get('sn'),
      basis: [
        'NVMe Base 2.1 · NVM Command Set 1.1',
        ...src['Spec Gap'].data.documents,
        ...src['제품 사양'].data.documents.map(d => d.replace(/\s*\(.*\)\s*$/, '')),
      ].join(' / '),
      eval_summary: sources.map(s => `${s.task}-E ${s.ev.result} (iteration ${s.ev.target_iteration || 1})`).join(' · '),
    },
    rules: [
      'Gen / Eval 2회 초과 FAIL → 검토 필요',
      'Spec Gap TBD → 검토 필요',
      'Spec Gap ↔ 제품 사양 상충 → 검토 필요',
      '적용 기대값 위반 → Fail (Spec Gap에 행이 있는 필드는 NVMe Spec 기대값 미적용)',
      'NVMe Spec 기대값만 있고 자동 판정 불가 → 검토 필요',
      '확정 기대값 없음 → 검토 필요 (TBD / 근거 문서 없음)',
    ],
    summary: { ...count(fields), by_structure: Object.fromEntries(structures.map(s => [s, count(fields.filter(f => f.structure === s))])) },
    fields,
  };

  const outPath = path.resolve(ROOT, args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

  const s = result.summary;
  console.log(`저장: ${path.relative(ROOT, outPath)}`);
  console.log(`전체 ${s.total} · Pass ${s.pass} · Fail ${s.fail} · 검토 필요 ${s.review}`);
  const reasons = {};
  fields.filter(f => f.verdict === '검토 필요').forEach(f => f.review_reason_types.forEach(r => { reasons[r] = (reasons[r] || 0) + 1; }));
  console.log('검토 필요 사유:', JSON.stringify(reasons));
  console.log('Fail:', fields.filter(f => f.verdict === 'Fail').map(f => f.field).join(', ') || '없음');
}

main();
