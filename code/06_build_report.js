// Workflow Task 6 (코드): 대시보드(요약)와 엑셀(상세 결과) 생성
//
// 사용법:
//   node code/06_build_report.js [--judgement <코드 3 결과>] [--fail <AI 4 결과>] [--review <AI 5 결과>] [--out <폴더>]
// 기본값:
//   --judgement output/judgement.json  --fail output/fail_analysis.json
//   --review output/review_items.json  --out final
//
// AI 5는 검토 필요 0건이면 호출되지 않으므로 review 파일이 없어도 진행한다.

const fs = require('fs');
const path = require('path');
const { writeXlsx } = require('./lib/xlsx_writer');

const ROOT = path.resolve(__dirname, '..');
const VERDICT_KEY = { 'Pass': 'pass', 'Fail': 'fail', '검토 필요': 'review' };
const LEVEL_KEY = { '높음': 'high', '중간': 'mid', '낮음': 'low' };

function parseArgs(argv) {
  const args = {
    judgement: 'output/judgement.json',
    fail: 'output/fail_analysis.json',
    review: 'output/review_items.json',
    out: 'final',
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in args) || argv[i + 1] === undefined) throw new Error(`알 수 없는 인자: ${argv[i]}`);
    args[key] = argv[i + 1];
  }
  return args;
}

function readJson(rel, required) {
  const file = path.resolve(ROOT, rel);
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`입력 파일이 없습니다: ${rel}`);
    return null;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ISO 주차 (예: W43)
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return 'W' + String(Math.ceil(((t - start) / 86400000 + 1) / 7)).padStart(2, '0');
}

const asText = v => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function main() {
  const args = parseArgs(process.argv.slice(2));
  const judgement = readJson(args.judgement, true);
  const failAnalysis = readJson(args.fail, true);
  const reviewItems = readJson(args.review, false) || { items: [] };

  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const round = isoWeek(now);
  const meta = judgement.meta;
  const baseName = `IDverify_${meta.model}_${meta.fw}_${round}`;
  const xlsxName = `${baseName}.xlsx`;

  // 상세 결과 행
  const rows = judgement.fields.map(f => ({
    no: f.no,
    structure: f.structure,
    field: f.field,
    cli: f.cli_name,
    offset: f.byte_offset,
    expected: f.expected_display,
    actual: asText(f.actual),
    source: f.source_display,
    verdict: VERDICT_KEY[f.verdict],
    verdictText: f.verdict,
    reason: f.reason,
  }));

  // 검토 필요사항 (AI 5 결과)
  const byKey = new Map(judgement.fields.map(f => [`${f.structure}|${f.cli_name}`, f]));
  // AI 5 결과가 없는데 검토 필요 항목이 있으면, 코드 3 판정 결과로 목록·사유만 채우고 문의 초안은 미작성으로 표시
  const draftsMissing = !reviewItems.items.length && judgement.summary.review > 0;
  if (draftsMissing) {
    reviewItems.items = judgement.fields.filter(f => f.verdict === '검토 필요').map((f, i) => ({
      id: `R-${String(i + 1).padStart(2, '0')}`,
      fields: [{ structure: f.structure, field: f.field, cli_name: f.cli_name, actual: f.actual }],
      expected_by_source: f.expected_by_source_text,
      reason_types: f.review_reason_types,
      reason: f.reason,
      to: '미지정',
      to_note: '문의 초안 미작성 (AI 5 미실행)',
    }));
  }
  const reviews = reviewItems.items.map(r => {
    const fields = r.fields || [];
    const first = byKey.get(`${fields[0]?.structure}|${fields[0]?.cli_name}`);
    return {
      id: r.id,
      fields: fields.map(x => x.field).join(' / '),
      struct: [...new Set(fields.map(x => x.structure))].join(' / '),
      actual: fields.map(x => (fields.length > 1 ? `${x.field}: ` : '') + asText(x.actual ?? byKey.get(`${x.structure}|${x.cli_name}`)?.actual)).join('\n'),
      expected: Object.entries(r.expected_by_source || first?.expected_by_source_text || {}).map(([k, v]) => `${k}: ${asText(v)}`),
      reason_types: r.reason_types || [],
      reason: r.reason,
      to: r.to + (r.to_note ? ` (${r.to_note})` : ''),
      draft: r.draft ? `제목: ${r.draft.subject}\n\n${r.draft.body}` : '문의 초안 미작성 (AI 5 미실행)',
    };
  });

  // Fail 분석 (AI 4 결과)
  const fails = (failAnalysis.fails || []).map(f => ({
    field: f.field,
    struct: f.structure,
    exp: asText(f.expected),
    act: asText(f.actual),
    src: (f.evidence_documents || []).join(', '),
    cause: f.cause,
    level: LEVEL_KEY[f.impact_level] || 'low',
    levelText: f.impact_level,
    impact: f.impact,
    action: f.action,
  }));
  const opinion = failAnalysis.overall_opinion || [];

  const s = judgement.summary;
  const byStructure = Object.entries(s.by_structure).map(([name, v]) => ({ name, ...v }));
  const pct = n => (s.total ? (n / s.total * 100).toFixed(1) : '0.0');
  const summarySheet = [
    ['제품', meta.product],
    ['FW', meta.fw],
    ['SN', meta.sn],
    ['검증일', date],
    ['회차', round],
    ['기준 문서', meta.basis],
    ['검증 필드 수', s.total],
    ['Pass', `${s.pass} (${pct(s.pass)}%)`],
    ['Fail', `${s.fail} (${pct(s.fail)}%)`],
    ['검토 필요', `${s.review} (${pct(s.review)}%)`],
    ...byStructure.map(b => [`  ${b.name}`, `Pass ${b.pass} · Fail ${b.fail} · 검토 필요 ${b.review} / ${b.total}`]),
    ['기대값 검토 (Gen / Eval)', meta.eval_summary],
    ...(draftsMissing ? [['문의 초안', 'AI 5 미실행 — 검토 필요 항목의 사유는 코드 3 판정 결과, 문의 초안은 미작성']] : []),
    ['종합 의견', opinion.join('\n')],
  ];
  const detailHead = ['No', '구분', '필드', 'nvme-cli', 'Byte Offset', '기대값 (적용 기준)', '실제값', '근거 문서', '판정', '판정 사유'];

  const outDir = path.resolve(ROOT, args.out);
  fs.mkdirSync(outDir, { recursive: true });

  // 엑셀
  const H = v => ({ v, s: 'header' });
  writeXlsx(path.join(outDir, xlsxName), [
    {
      name: '요약',
      columns: [26, 90],
      rows: [[H('항목'), H('내용')], ...summarySheet.map(([k, v]) => [{ v: k, s: 'label' }, v])],
    },
    {
      name: '상세 결과',
      columns: [6, 20, 11, 11, 12, 46, 26, 34, 11, 52],
      freezeHeader: true,
      autoFilter: true,
      rows: [detailHead.map(H), ...rows.map(r => {
        const st = r.verdict;
        return [r.no, r.structure, r.field, r.cli, r.offset, r.expected, r.actual, r.source, r.verdictText, r.reason].map(v => ({ v, s: st }));
      })],
    },
    {
      name: '검토 필요사항',
      columns: [7, 16, 20, 22, 44, 20, 46, 22, 70],
      freezeHeader: true,
      rows: [['ID', '필드', '구분', '실제값', '문서별 기대값', '사유 유형', '검토 사유', '문의 대상', '문의 초안'].map(H),
        ...reviews.map(r => [r.id, r.fields, r.struct, r.actual, r.expected.join('\n'), r.reason_types.join(', '), r.reason, r.to, r.draft].map(v => ({ v, s: 'review' })))],
    },
    {
      name: 'Fail 분석',
      columns: [11, 20, 28, 20, 30, 46, 8, 46, 40],
      freezeHeader: true,
      rows: [['필드', '구분', '기대값', '실제값', '근거 문서', '예상 원인', '영향도', '영향', '조치 제안'].map(H),
        ...fails.map(f => [f.field, f.struct, f.exp, f.act, f.src, f.cause, f.levelText, f.impact, f.action].map(v => ({ v, s: 'fail' })))],
    },
  ]);

  // 대시보드 (엑셀과 같은 데이터)
  const data = {
    meta: { product: meta.product, fw: meta.fw, sn: meta.sn, date, round, basis: meta.basis, xlsxName, draftsMissing },
    summary: { total: s.total, pass: s.pass, fail: s.fail, review: s.review, by_structure: byStructure },
    rows, reviews, fails, opinion, summarySheet, detailHead,
  };
  const template = fs.readFileSync(path.join(__dirname, 'templates', 'dashboard.html'), 'utf8');
  const html = template.replace('__DATA__', () => JSON.stringify(data).replace(/</g, '\\u003c'));
  const htmlName = `${baseName}_dashboard.html`;
  fs.writeFileSync(path.join(outDir, htmlName), html, 'utf8');

  console.log(`저장: ${path.relative(ROOT, path.join(outDir, htmlName))}`);
  console.log(`저장: ${path.relative(ROOT, path.join(outDir, xlsxName))}`);
  console.log(`필드 ${s.total} · Pass ${s.pass} · Fail ${s.fail} · 검토 필요 ${s.review} · Fail 분석 ${fails.length} · 검토 필요사항 ${reviews.length}${draftsMissing ? ' (문의 초안 미작성)' : ''}`);
}

main();
