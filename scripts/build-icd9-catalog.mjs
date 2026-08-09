#!/usr/bin/env node
/**
 * Builds the internal ICD-9-CM catalog from the official NCHS/CDC distribution.
 *
 * Source: ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/ICD9-CM/2011/
 * ICD-9-CM is maintained jointly by NCHS and CMS and published by the US
 * federal government, so the tabular lists are free to redistribute.
 *
 * Usage:  node scripts/build-icd9-catalog.mjs
 * Output: data/catalogs/icd9-procedures.json
 *         data/catalogs/icd9-diagnoses.json
 *         data/catalogs/manifest.json
 *
 * The generated files are committed so the app never needs network access at
 * runtime. Re-run this script only when moving to a different ICD-9 edition.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = join(ROOT, 'data', 'catalogs');

const BASE = 'https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/ICD9-CM/2011';
const EDITION = 'ICD-9-CM FY2012 (effective 2011-10-01), NCHS/CMS Sixth Edition';

const SOURCES = [
  { zip: 'Ptab12.zip', member: 'Ptab12.RTF', kind: 'procedure', out: 'icd9-procedures.json' },
  { zip: 'Dtab12.zip', member: 'Dtab12.rtf', kind: 'diagnosis', out: 'icd9-diagnoses.json' },
];

/** Minimal ZIP reader: finds one stored/deflated member by name. */
function extractFromZip(buffer, memberName) {
  const target = Buffer.from(memberName, 'latin1');
  let offset = 0;
  while (offset < buffer.length - 4) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = buffer.subarray(nameStart, nameStart + nameLength);
    const dataStart = nameStart + nameLength + extraLength;
    if (name.toString('latin1').toLowerCase() === target.toString('latin1').toLowerCase()) {
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      // ZIP stores raw DEFLATE streams (method 8) with no zlib header.
      return method === 0 ? data : inflateRawSync(data);
    }
    offset = dataStart + compressedSize;
  }
  throw new Error(`member ${memberName} not found in archive`);
}

/**
 * Reduces an RTF fragment to plain text. This is deliberately narrow: the NCHS
 * files use a small subset of RTF, so a full parser would be overkill.
 */
function rtfFragmentToText(fragment) {
  const PARAGRAPH = '\u0000'; // sentinel: cannot occur in the source text
  return fragment
    .replace(/\{\\\*\\bkmk(?:start|end) [^}]*\}/g, '')
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => Buffer.from(hex, 'hex').toString('latin1'))
    // Mark real paragraph breaks first: bare newlines in the source are only
    // line wrapping and must be dropped, not turned into content breaks.
    .replace(/\\(?:par|line)\b/g, PARAGRAPH)
    .replace(/\\tab\b/g, ' ')
    .replace(/\r?\n/g, '')
    .replace(/\\[a-zA-Z]+-?\d*[ ]?/g, '')
    .replace(/[{}]/g, '')
    .split(PARAGRAPH)
    .join('\n');
}

/**
 * The code and its description are often split across RTF runs, so the literal
 * "88.93" may arrive as "88." + "93". Walk the text consuming the code
 * character by character, tolerating whitespace, and return what follows it.
 */
function consumeCode(text, code) {
  let cursor = 0;
  let matched = 0;
  while (matched < code.length) {
    if (cursor >= text.length) return null;
    const ch = text[cursor];
    if (ch === code[matched]) {
      cursor += 1;
      matched += 1;
    } else if (text.slice(0, cursor).trim() === '') {
      cursor += 1; // still in leading whitespace/noise
    } else {
      return null;
    }
  }
  return text.slice(cursor);
}

const NOTE_LINE = /^(Excludes|Includes|Code also|Note|Use additional|DEF:|\[|\()/i;
const CROSS_REFERENCE = /\(\d{2,3}\.\d/;

/**
 * Extracts the fifth-digit subclassification tables.
 *
 * ICD-9 does not repeat the meaning of each extra digit on every code. It
 * declares it once per category — "The following fifth-digit subclassification
 * is for use with category 574: 0 without mention of obstruction, 1 with
 * obstruction" — and expects the reader to combine the two. Without these
 * tables, 574.00 and 574.01 both read as plain "Calculus of gallbladder with
 * acute cholecystitis" and a coder cannot tell them apart.
 *
 * Returns a list of { scope, digits } where scope is the raw category
 * expression, resolved into concrete code prefixes by expandScope below.
 */
function parseFifthDigitTables(rtf) {
  const flat = rtfFragmentToText(rtf).split('\n').map((line) => line.replace(/\s+/g, ' ').trim());
  const tables = [];

  for (let index = 0; index < flat.length; index += 1) {
    const heading = flat[index];
    // The document uses two phrasings interchangeably: "is for use with
    // category 574" and "is to be used for codes 789.0, 789.3, ...".
    const match = /following (?:fourth|fifth)-digit subclassification is (?:for use with|to be used (?:for|with)) (.+?):?$/i.exec(heading);
    if (!match) continue;

    const digits = new Map();
    for (let cursor = index + 1; cursor < Math.min(index + 40, flat.length); cursor += 1) {
      const line = flat[cursor];
      if (!line) continue;
      const digit = /^([0-9])\s+(\S.*)$/.exec(line);
      if (digit) {
        const [, key, meaning] = digit;
        if (!digits.has(key)) digits.set(key, meaning);
        continue;
      }
      // Stop at the next real code, which marks the end of the digit table.
      if (/^[EV]?\d{2,3}(\.\d{1,2})?\s+\S/.test(line)) break;
    }

    if (digits.size > 0) tables.push({ scope: match[1], digits });
  }

  return tables;
}

/**
 * Turns a scope expression such as "categories 010-018", "category 574",
 * "categories 296.0-296.6" or "codes 305.0, 305.2-305.9" into a predicate over
 * code strings.
 */
function scopeMatcher(scope) {
  const tokens = scope
    // Volume 3 phrases scopes as "appropriate categories in section 38.0, 38.1,
    // ... according to site"; strip the prose so only the code list remains.
    .replace(/^appropriate categories in section\s+/i, '')
    .replace(/\s+according to site.*$/i, '')
    .replace(/\s+to identify (?:the )?site.*$/i, '')
    .replace(/^(categories|category|codes|code|subcategories|subcategory)\s+/i, '')
    .replace(/\band\b/gi, ',')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  const ranges = [];
  for (const token of tokens) {
    const range = /^([EV]?\d{2,3}(?:\.\d)?)\s*[-–]\s*(?:([EV]?\d{2,3})?(?:\.(\d))?|\.(\d))$/.exec(token);
    const single = /^([EV]?\d{2,3}(?:\.\d)?)$/.exec(token);
    if (single) {
      ranges.push({ from: single[1], to: single[1] });
    } else if (range) {
      const from = range[1];
      // "345.0, .1, .4-.9" style shorthand reuses the leading category.
      const to = range[2]
        ? `${range[2]}${range[3] ? `.${range[3]}` : ''}`
        : `${from.split('.')[0]}.${range[3] || range[4]}`;
      ranges.push({ from, to });
    }
  }
  if (ranges.length === 0) return null;

  return (code) => ranges.some(({ from, to }) => {
    // Compare at the granularity the range was written in, so "010-018"
    // matches 010.90 and "296.0-296.6" matches 296.04.
    const width = from.includes('.') ? from.length : from.length;
    const head = code.slice(0, width);
    return head >= from && head <= to;
  });
}

/** Returns the parent code, e.g. 88.93 -> 88.9 -> 88, and 723.0 -> 723. */
function parentOf(code) {
  if (!code.includes('.')) return null;
  const [head, tail] = code.split('.');
  if (tail.length > 1) return `${head}.${tail.slice(0, -1)}`;
  return head;
}

/**
 * Collects every bookmarked position in the file.
 *
 * Most codes are bookmarked individually, but a code that takes a fifth digit is
 * bookmarked as a group listing the whole expansion, e.g. 574.0 arrives as
 * {574.00}{574.01}{574.0}. Those fully specified codes are exactly the ones a
 * biller submits, so the group members have to be captured too — reading only
 * single bookmark pairs silently loses several thousand assignable codes.
 * Within a group the shortest code is the rubric that carries the description;
 * the longer siblings inherit it plus their fifth-digit meaning.
 */
function collectBookmarks(rtf) {
  const groups = [...rtf.matchAll(/(?:\{\\\*\\bkmkstart ([0-9A-Za-z._-]+)\}\s*)+(?:\{\\\*\\bkmkend [0-9A-Za-z._-]+\}\s*)+/g)];
  return groups.map((match) => {
    const codes = [...match[0].matchAll(/\{\\\*\\bkmkstart ([0-9A-Za-z._-]+)\}/g)].map((m) => m[1]);
    const rubric = codes.reduce((shortest, code) => (code.length < shortest.length ? code : shortest), codes[0]);
    return { codes, rubric, start: match.index, end: match.index + match[0].length };
  });
}

function parseTabularList(rtf, kind) {
  const marks = collectBookmarks(rtf);
  const byCode = new Map();

  const digitTables = parseFifthDigitTables(rtf)
    .map((table) => ({ ...table, matches: scopeMatcher(table.scope) }))
    .filter((table) => table.matches);

  /** Finds the meaning of the trailing digit of a fully specified code. */
  const describeExtraDigit = (code, rubric) => {
    const digit = code.slice(rubric.length);
    if (digit.length !== 1) return null;
    // Later tables are more specific (a category-level table overrides a
    // chapter-level range), so prefer the last one whose scope matches.
    for (let index = digitTables.length - 1; index >= 0; index -= 1) {
      const table = digitTables[index];
      if (table.matches(rubric) && table.digits.has(digit)) return table.digits.get(digit);
    }
    return null;
  };

  for (let index = 0; index < marks.length; index += 1) {
    const mark = marks[index];
    const code = mark.rubric;
    const start = mark.end;
    const end = index + 1 < marks.length ? marks[index + 1].start : Math.min(rtf.length, start + 4000);
    const chunk = rtfFragmentToText(rtf.slice(start, end));

    const remainder = consumeCode(chunk, code);
    if (remainder === null) continue;

    const lines = remainder.split('\n').map((line) => line.replace(/\s+/g, ' ').trim());
    const display = (lines[0] || '').replace(/^[-\s]+|[-\s]+$/g, '');
    if (display.length < 3) continue;

    // ICD-9 declares fifth digits once per category rather than spelling out
    // every combination, marking the codes that need one with a bracketed list
    // of the valid digits, e.g. "574.2  Calculus of gallbladder ... [0-1]".
    // Without this, 574.2 looks assignable when a biller must actually submit
    // 574.20 or 574.21.
    const digitNotation = lines.slice(0, 6).find((line) => /^\[[0-9,\s-]+\]$/.test(line));
    const requiresExtraDigit = Boolean(digitNotation);

    const synonyms = lines
      .slice(1, 14)
      .filter((line) => line && !NOTE_LINE.test(line) && !CROSS_REFERENCE.test(line))
      .filter((line) => line.length > 3 && line.length < 100)
      .slice(0, 6);

    if (byCode.has(code)) continue;
    byCode.set(code, {
      code,
      display,
      kind,
      synonyms,
      ...(requiresExtraDigit ? { requiresExtraDigit, validExtraDigits: digitNotation } : {}),
    });

    // Record the fully specified siblings from the same bookmark group. They
    // inherit the rubric's description; the meaning of the extra digit itself
    // comes from a category-level table elsewhere in the document, so leave a
    // marker rather than fabricating a description for it.
    for (const sibling of mark.codes) {
      if (sibling === code || byCode.has(sibling)) continue;
      if (!sibling.startsWith(code)) continue;
      const digitMeaning = describeExtraDigit(sibling, code);
      byCode.set(sibling, {
        code: sibling,
        display: digitMeaning ? `${display}, ${digitMeaning}` : display,
        kind,
        synonyms: [],
        specifiesDigitOf: code,
        ...(digitMeaning ? { extraDigitMeaning: digitMeaning } : {}),
      });
    }
  }

  // Attach the parent description as context. Without it, entries such as
  // "015.1 Hip" or "88.38 Other computerized axial tomography" are unsearchable.
  const hasChildren = new Set();
  for (const entry of byCode.values()) {
    const parents = [];
    let parent = parentOf(entry.code);
    while (parent) {
      hasChildren.add(parent);
      const found = byCode.get(parent);
      if (found) parents.unshift(found.display);
      parent = parentOf(parent);
    }
    entry.context = parents;
  }

  // ICD-9-CM requires coding to the highest level of specificity available, so a
  // category that has subdivisions is a heading rather than an assignable code.
  // Flag it here so retrieval can keep it for context but exclude it from the
  // candidate list a coder is asked to choose from.
  for (const entry of byCode.values()) {
    entry.assignable = !hasChildren.has(entry.code) && !entry.requiresExtraDigit;
  }

  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const manifest = {
    edition: EDITION,
    source: BASE,
    licence: 'US federal government publication (NCHS/CMS) — free to redistribute',
    builtAt: new Date().toISOString(),
    files: [],
  };

  for (const source of SOURCES) {
    process.stdout.write(`downloading ${source.zip} ... `);
    const archive = await download(`${BASE}/${source.zip}`);
    const rtf = extractFromZip(archive, source.member).toString('latin1');
    const entries = parseTabularList(rtf, source.kind);
    if (entries.length < 1000) {
      throw new Error(`${source.member} yielded only ${entries.length} entries — parser is broken`);
    }

    const payload = JSON.stringify({ edition: EDITION, kind: source.kind, entries });
    await writeFile(join(OUT_DIR, source.out), `${payload}\n`, 'utf8');
    manifest.files.push({
      file: source.out,
      kind: source.kind,
      entries: entries.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
    });
    process.stdout.write(`${entries.length} ${source.kind} codes\n`);
  }

  await writeFile(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote ${manifest.files.length} catalogs to data/catalogs\n`);
}

main().catch((error) => {
  process.stderr.write(`build failed: ${error.message}\n`);
  process.exitCode = 1;
});
