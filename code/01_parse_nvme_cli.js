// Workflow Task 1 (코드): nvme-cli 출력 로그(id-ctrl / id-ns)를 읽어 필드별 실제값 정리
//
// 사용법:
//   node code/01_parse_nvme_cli.js [--ctrl <id-ctrl 로그>] [--ns <id-ns 로그>] [--out <결과 JSON>]
// 기본값:
//   --ctrl data/nvme_id_ctrl.log  --ns data/nvme_id_ns.log  --out output/actual_values.json

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    ctrl: 'data/nvme_id_ctrl.log',
    ns: 'data/nvme_id_ns.log',
    out: 'output/actual_values.json',
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in args) || argv[i + 1] === undefined) {
      throw new Error(`알 수 없는 인자: ${argv[i]}`);
    }
    args[key] = argv[i + 1];
  }
  return args;
}

// "mp:25.00W operational enlat:0 ..." → { mp: '25.00W', operational: true, enlat: '0', ... }
function parseAttrs(text) {
  const attrs = {};
  for (const token of text.trim().split(/\s+/)) {
    if (!token) continue;
    const idx = token.indexOf(':');
    if (idx > 0) attrs[token.slice(0, idx)] = token.slice(idx + 1);
    else if (token === 'operational') attrs.operational = true;
    else if (token === 'non-operational') attrs.operational = false;
    else if (token === '(in') attrs.in_use = true;
    else if (token === 'use)') continue;
    else attrs[token] = true;
  }
  return attrs;
}

function parseLog(file, defaultStructure) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const fields = [];
  const warnings = [];
  let command = '';
  let last = null;

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (!line.trim()) return;
    if (line.startsWith('$ ')) { command = line.slice(2).trim(); return; }
    if (/^NVME Identify (Controller|Namespace)/i.test(line)) return;

    // Power State 설명 이어지는 줄 (들여쓰기로 시작)
    if (/^\s/.test(line)) {
      if (last && last.structure === 'Power State Descriptor') {
        Object.assign(last.value, parseAttrs(line));
        last.raw += ' ' + line.trim();
        last.lines.push(lineNo);
      } else {
        warnings.push(`${path.basename(file)}:${lineNo} 해석하지 못한 줄: ${line.trim()}`);
      }
      return;
    }

    const m = line.match(/^([^:]+?)\s*:\s?(.*)$/);
    if (!m) {
      warnings.push(`${path.basename(file)}:${lineNo} 해석하지 못한 줄: ${line.trim()}`);
      return;
    }
    const key = m[1].trim().replace(/\s+/g, ' ');
    const rawValue = m[2];

    let entry;
    const ps = key.match(/^ps (\d+)$/);
    const lbaf = key.match(/^lbaf (\d+)$/);
    if (ps) {
      entry = { structure: 'Power State Descriptor', cli_name: `ps ${ps[1]}`, index: Number(ps[1]), value: parseAttrs(rawValue) };
    } else if (lbaf) {
      const value = parseAttrs(rawValue);
      value.in_use = value.in_use === true;
      entry = { structure: 'LBA Format', cli_name: `lbaf ${lbaf[1]}`, index: Number(lbaf[1]), value };
    } else {
      entry = { structure: defaultStructure, cli_name: key, value: rawValue.trimEnd() };
    }
    entry.raw = line;
    entry.lines = [lineNo];

    if (fields.some(f => f.cli_name === entry.cli_name && f.structure === entry.structure)) {
      warnings.push(`${path.basename(file)}:${lineNo} 중복 필드: ${entry.cli_name}`);
    }
    fields.push(entry);
    last = entry;
  });

  return { file: path.relative(ROOT, file).replace(/\\/g, '/'), command, fields, warnings };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ctrl = parseLog(path.resolve(ROOT, args.ctrl), 'Identify Controller');
  const ns = parseLog(path.resolve(ROOT, args.ns), 'Identify Namespace');

  const fields = [...ctrl.fields, ...ns.fields].map(f => ({
    structure: f.structure,
    cli_name: f.cli_name,
    ...(f.index !== undefined ? { index: f.index } : {}),
    value: f.value,
    raw: f.raw,
    source: { file: (f.structure === 'Identify Controller' || f.structure === 'Power State Descriptor') ? ctrl.file : ns.file, lines: f.lines },
  }));

  const countBy = {};
  fields.forEach(f => { countBy[f.structure] = (countBy[f.structure] || 0) + 1; });

  const result = {
    task: 'Workflow Task 1 - 필드별 실제값',
    generated_at: new Date().toISOString(),
    inputs: [
      { file: ctrl.file, command: ctrl.command },
      { file: ns.file, command: ns.command },
    ],
    summary: { total: fields.length, by_structure: countBy },
    warnings: [...ctrl.warnings, ...ns.warnings],
    fields,
  };

  const outPath = path.resolve(ROOT, args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

  console.log(`저장: ${path.relative(ROOT, outPath)}`);
  console.log(`전체 필드: ${fields.length}`);
  for (const [k, v] of Object.entries(countBy)) console.log(`  - ${k}: ${v}`);
  console.log(`경고: ${result.warnings.length}건`);
  result.warnings.forEach(w => console.log(`  ! ${w}`));
}

main();
