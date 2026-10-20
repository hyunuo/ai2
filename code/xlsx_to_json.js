// 입력 자료 읽기 도구: 엑셀(.xlsx) 내용을 JSON으로 출력한다. (외부 라이브러리 없음)
// Sub Agent(2-b, 2-b-E)가 Spec Gap 문서를 읽을 때 사용한다. Workflow Task가 아니다.
//
// 사용법:
//   node code/xlsx_to_json.js <xlsx 파일> [--sheet <시트 이름>]
// 출력:
//   { file, sheets: [ { name, header: [...], rows: [ { _row: 엑셀 행 번호, <헤더>: 값, ... } ] } ] }

const fs = require('fs');
const zlib = require('zlib');

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('xlsx(zip) 형식이 아닙니다.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(dataStart, dataStart + compSize);
    files[name] = method === 8 ? zlib.inflateRawSync(data) : data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decode = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');

// <t>...</t> 조각을 모두 이어 붙인다 (서식이 섞인 텍스트 포함)
const textOf = xml => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => decode(m[1])).join('');

function colIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0];
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}

function readSheet(xml, shared) {
  const rows = [];
  for (const r of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const body = c[2] || '';
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const type = (attrs.match(/\bt="(\w+)"/) || [])[1];
      const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let value = null;
      if (type === 's') value = shared[Number(v)];
      else if (type === 'inlineStr') value = textOf(body);
      else if (type === 'str' || type === 'e') value = v !== undefined ? decode(v) : null;
      else if (type === 'b') value = v === '1';
      else if (v !== undefined) value = Number(v);
      if (ref) cells[colIndex(ref)] = value;
    }
    rows.push({ row: Number(r[1]), cells });
  }
  return rows;
}

function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) throw new Error('사용법: node code/xlsx_to_json.js <xlsx 파일> [--sheet <시트 이름>]');
  const sheetFilter = rest[0] === '--sheet' ? rest[1] : null;

  const files = unzip(fs.readFileSync(file));
  const xml = name => (files[name] ? files[name].toString('utf8') : '');
  const shared = [...xml('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1]));
  const rels = Object.fromEntries([...xml('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)]
    .map(m => [m[1], m[2].replace(/^\/?(xl\/)?/, 'xl/')]));

  const sheets = [];
  for (const s of xml('xl/workbook.xml').matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"/g)) {
    const name = decode(s[1]);
    if (sheetFilter && name !== sheetFilter) continue;
    const rows = readSheet(xml(rels[s[2]]), shared);
    if (!rows.length) { sheets.push({ name, header: [], rows: [] }); continue; }
    const header = rows[0].cells.map((h, i) => (h === undefined || h === null ? `col${i + 1}` : String(h)));
    sheets.push({
      name,
      header,
      rows: rows.slice(1).map(r => {
        const obj = { _row: r.row };
        header.forEach((h, i) => { obj[h] = r.cells[i] === undefined ? null : r.cells[i]; });
        return obj;
      }),
    });
  }
  process.stdout.write(JSON.stringify({ file, sheets }, null, 2) + '\n');
}

main();
