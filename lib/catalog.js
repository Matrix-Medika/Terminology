/**
 * Internal code catalog and retrieval layer.
 *
 * Design intent: the language model must never invent a code. It extracts
 * clinical facts from the document, this module turns those facts into a short
 * closed list of real catalog candidates, and only then is the model allowed to
 * choose — and it must cite the sentence that justifies the choice. That gives
 * two cheap programmatic guardrails: the chosen code has to exist in the
 * candidate list, and the citation has to exist in the document.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = join(HERE, '..', 'data', 'catalogs');

/** Codes 87–88 are the diagnostic imaging block of ICD-9-CM volume 3. */
export const IMAGING_CODE_PREFIXES = ['87', '88'];

const STOP_WORDS = new Set([
  'of', 'and', 'or', 'the', 'a', 'an', 'other', 'unspecified', 'nos', 'nec',
  'with', 'without', 'for', 'by', 'in', 'on', 'to', 'not', 'so', 'described',
]);

/**
 * Bridges the Hebrew report vocabulary to the English catalog. Kept small and
 * explicit on purpose: this is clinical terminology, so it should be reviewed
 * by a coder rather than inferred. Extend it as new modalities are onboarded.
 */
export const HEBREW_TERMS = {
  modality: {
    MRI: ['magnetic resonance imaging', 'mri'],
    CT: ['computerized axial tomography', 'cat scan', 'tomography'],
    US: ['diagnostic ultrasound', 'ultrasound', 'echography'],
    XRAY: ['x-ray', 'radiography', 'radiogram'],
    MAMMO: ['mammography', 'mammogram'],
    PET: ['positron emission tomography'],
  },
  anatomy: {
    cervical_spine: ['spinal canal', 'cervical', 'spine', 'spinal cord'],
    thoracic_spine: ['spinal canal', 'thoracic', 'spine'],
    lumbar_spine: ['spinal canal', 'lumbar', 'lumbosacral', 'spine'],
    brain: ['brain', 'brain stem', 'head', 'skull'],
    abdomen: ['abdomen', 'retroperitoneum', 'abdominal'],
    pelvis: ['pelvis', 'pelvic'],
    // ICD-9 has no combined abdomen-and-pelvis entry; the abdomen codes are the
    // ones a coder submits for such a study, with pelvis as the weaker signal.
    abdomen_pelvis: ['abdomen', 'retroperitoneum', 'pelvis'],
    chest: ['chest', 'thorax', 'lung'],
    // ICD-9 titles these entries "mammography", not "breast", so the anatomy
    // facet has to speak the catalog's vocabulary rather than the clinician's.
    breast: ['breast', 'mammography', 'mammary'],
    neck: ['neck', 'head and neck', 'soft tissue'],
    urinary: ['urinary system', 'kidney', 'bladder'],
    heart: ['heart', 'cardiac', 'myocardium'],
    musculoskeletal: ['musculoskeletal', 'bone', 'joint', 'extremity'],
    whole_body: ['whole body', 'other and unspecified sites'],
  },
};

let cache = null;

function normalise(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '') // Hebrew niqqud
    .replace(/[^a-z0-9֐-׿]+/g, ' ')
    .trim();
}

export function tokenize(value) {
  return normalise(value)
    .split(' ')
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function readCatalogFile(file) {
  const parsed = JSON.parse(readFileSync(join(CATALOG_DIR, file), 'utf8'));
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    throw new Error(`catalog ${file} is empty — run scripts/build-icd9-catalog.mjs`);
  }
  return parsed;
}

/**
 * Loads the catalogs and builds an inverted index with IDF weights. Called once
 * per process; the catalogs are static data files, so there is nothing to
 * invalidate at runtime.
 */
export function loadCatalog({ force = false } = {}) {
  if (cache && !force) return cache;

  const procedures = readCatalogFile('icd9-procedures.json');
  const diagnoses = readCatalogFile('icd9-diagnoses.json');
  const manifest = JSON.parse(readFileSync(join(CATALOG_DIR, 'manifest.json'), 'utf8'));

  const documents = [];
  for (const [kind, source] of [['procedure', procedures], ['diagnosis', diagnoses]]) {
    for (const entry of source.entries) {
      // Weight the primary display above synonyms and hierarchy context: a hit
      // on the code's own name is far stronger evidence than a hit on its
      // chapter heading.
      const fields = [
        { text: entry.display, weight: 3 },
        { text: (entry.synonyms || []).join(' '), weight: 2 },
        { text: (entry.context || []).join(' '), weight: 1 },
      ];
      const termFrequency = new Map();
      let length = 0;
      for (const field of fields) {
        for (const token of tokenize(field.text)) {
          termFrequency.set(token, (termFrequency.get(token) || 0) + field.weight);
          length += field.weight;
        }
      }
      documents.push({ ...entry, kind, termFrequency, length });
    }
  }

  const documentFrequency = new Map();
  for (const doc of documents) {
    for (const token of doc.termFrequency.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }

  const index = new Map();
  for (let position = 0; position < documents.length; position += 1) {
    for (const token of documents[position].termFrequency.keys()) {
      if (!index.has(token)) index.set(token, []);
      index.get(token).push(position);
    }
  }

  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length;

  cache = {
    manifest,
    documents,
    index,
    documentFrequency,
    averageLength,
    byCode: new Map(documents.map((doc) => [`${doc.kind}:${doc.code}`, doc])),
  };
  return cache;
}

/**
 * "Other x" / "unspecified" / "NOS" entries are residual buckets. BM25 favours
 * them because their text is short, but a coder should only reach for them once
 * every specific alternative has been ruled out, so demote them enough to sit
 * below a genuine anatomical match without dropping out of the list.
 */
const RESIDUAL = /(^other\b|\bunspecified\b|\bNOS\b|\bnot elsewhere classified\b|\bNEC\b)/i;

/**
 * ICD-9 titles many codes as "<condition> with <qualifier>" — with obstruction,
 * with cholecystitis, with contrast — and each such qualifier is a separate
 * clinical claim that the document has to actually support.
 *
 * BM25 ranks these variants above the plain form, because the extra words add
 * matchable text without diluting the terms that did match. That is a real
 * hazard: searching for "calculus of gallbladder" returned 574.11, "with other
 * cholecystitis, with obstruction", from a report that mentioned neither. The
 * "without mention of" sibling is the code ICD-9 asks for when a qualifier is
 * undocumented, so a qualifier nothing in the query supports must be a penalty
 * rather than a bonus.
 *
 * Note the boundary in \bwith\b: it deliberately does not match "without".
 */
const WITH_CLAUSE = /\bwith\b\s+([^;,]*)/gi;

/**
 * Qualifiers naming a device or material that happens to be present, rather than
 * a claim about the patient's condition or about extra work performed. These are
 * exempt from the undocumented-qualifier penalty.
 *
 * Contrast is deliberately *not* on this list. "With contrast" is a distinct
 * billable service that has to be documented, and exempting it let 88.11,
 * "Pelvic opaque dye contrast radiography", win for a plain abdominal film.
 */
const INCIDENTAL_QUALIFIER = /\b(graft|prosthesis|implant|device)\b/i;

/**
 * Counts the "with X" clauses in a code's title that the query does not support.
 *
 * Each clause is judged on its own. An earlier version exempted every qualifier
 * as soon as any one of them was supported, which let the exact error it was
 * written to prevent back in: a report documenting "calculus of gallbladder with
 * acute cholecystitis" scored 574.01, "…with acute cholecystitis, with
 * obstruction", above the "without mention of obstruction" sibling, adding an
 * obstruction the report never mentioned.
 */
function unsupportedQualifiers(entry, queryTokens) {
  const clauses = [...entry.display.matchAll(WITH_CLAUSE)];
  if (clauses.length === 0) return 0;
  let unsupported = 0;
  for (const clause of clauses) {
    if (INCIDENTAL_QUALIFIER.test(clause[1])) continue;
    const claimed = tokenize(clause[1]);
    if (claimed.length === 0) continue;
    if (!claimed.some((token) => queryTokens.has(token))) unsupported += 1;
  }
  return unsupported;
}

/**
 * Combines the two ranking corrections. Residual buckets are demoted mildly —
 * "other x" is a legitimate choice once the specific options are excluded — while
 * an unsupported qualifier is demoted hard, because submitting a comorbidity the
 * report never documented is a coding error rather than a matter of preference.
 */
function specificityFactor(entry, queryTokens) {
  const residual = RESIDUAL.test(entry.display) ? 0.85 : 1;
  const unsupported = queryTokens ? unsupportedQualifiers(entry, queryTokens) : 0;
  return residual * (unsupported > 0 ? 0.6 : 1);
}

/** Okapi BM25. Standard parameters; the corpus is small and homogeneous. */
function bm25Score(catalog, doc, tokens, k1 = 1.5, b = 0.75) {
  let score = 0;
  for (const token of tokens) {
    const frequency = doc.termFrequency.get(token);
    if (!frequency) continue;
    const df = catalog.documentFrequency.get(token) || 1;
    const idf = Math.log(1 + (catalog.documents.length - df + 0.5) / (df + 0.5));
    const norm = frequency * (k1 + 1) / (frequency + k1 * (1 - b + b * (doc.length / catalog.averageLength)));
    score += idf * norm;
  }
  return score;
}

/**
 * Retrieves candidate codes for a free-text query.
 *
 * @param {string|string[]} query terms to search for
 * @param {object} options
 * @param {'procedure'|'diagnosis'} [options.kind] restrict to one code family
 * @param {string[]} [options.codePrefixes] restrict to code ranges, e.g. ['87','88']
 * @param {number} [options.limit] how many candidates to return
 * @param {boolean} [options.assignableOnly] exclude category headings and codes
 *   still missing a required extra digit, which a biller cannot submit
 * @returns {Array<{code, display, kind, context, synonyms, score}>}
 */
export function searchCatalog(query, {
  kind = null,
  codePrefixes = null,
  limit = 8,
  assignableOnly = true,
} = {}) {
  const catalog = loadCatalog();
  const tokens = Array.isArray(query) ? query.flatMap(tokenize) : tokenize(query);
  if (tokens.length === 0) return [];

  const queryTokens = new Set(tokens);
  const seen = new Set();
  const candidates = [];
  for (const token of new Set(tokens)) {
    for (const position of catalog.index.get(token) || []) {
      if (seen.has(position)) continue;
      seen.add(position);
      candidates.push(catalog.documents[position]);
    }
  }

  return candidates
    .filter((doc) => (kind ? doc.kind === kind : true))
    .filter((doc) => (codePrefixes ? codePrefixes.some((prefix) => doc.code.startsWith(prefix)) : true))
    .filter((doc) => (assignableOnly ? doc.assignable : true))
    .map((doc) => ({
      code: doc.code,
      display: doc.display,
      kind: doc.kind,
      context: doc.context || [],
      synonyms: doc.synonyms || [],
      residual: RESIDUAL.test(doc.display),
      score: Math.round(bm25Score(catalog, doc, tokens) * specificityFactor(doc, queryTokens) * 1000) / 1000,
    }))
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code, 'en', { numeric: true }))
    .slice(0, limit);
}

/**
 * Faceted retrieval. A procedure code is the intersection of two independent
 * facts — the modality and the anatomy — and plain BM25 over a merged bag of
 * words cannot express that: "computerized axial tomography" appears in dozens
 * of entries, so its tokens swamp the single anatomical token that actually
 * discriminates between them. Scoring each facet separately and multiplying the
 * results makes a code that satisfies both facets beat a code that satisfies
 * only one, however strongly.
 */
export function searchFaceted(facets, { kind = null, codePrefixes = null, limit = 8 } = {}) {
  const active = facets.filter((facet) => facet.terms && facet.terms.length > 0);
  if (active.length === 0) return [];

  const perFacet = active.map((facet) => {
    const results = searchCatalog(facet.terms, { kind, codePrefixes, limit: 400 });
    const best = results[0]?.score || 1;
    return new Map(results.map((result) => [result.code, result.score / best]));
  });

  const codes = new Set(perFacet.flatMap((scores) => [...scores.keys()]));
  const catalog = loadCatalog();

  return [...codes]
    .map((code) => {
      // Each per-facet search restricted itself to `kind`, so a returned code
      // belongs to that family; falling back to a hardcoded 'procedure' lookup
      // threw on any unrestricted search.
      const doc = kind
        ? catalog.byCode.get(`${kind}:${code}`)
        : catalog.byCode.get(`procedure:${code}`) || catalog.byCode.get(`diagnosis:${code}`);
      // A facet the code does not match at all still contributes a small floor
      // so that a strong single-facet match remains visible to the coder.
      const parts = perFacet.map((scores) => scores.get(code) ?? 0.05);
      const combined = parts.reduce((product, part) => product * part, 1);
      return {
        code,
        display: doc.display,
        kind: doc.kind,
        context: doc.context || [],
        synonyms: doc.synonyms || [],
        residual: RESIDUAL.test(doc.display),
        // How many facets this code actually matched, as opposed to receiving
        // the floor. A code that satisfies only one of two facets is a weak
        // candidate however high its score, and callers need to see that.
        facetsMatched: perFacet.filter((scores) => scores.has(code)).length,
        facetScores: parts.map((part) => Math.round(part * 100) / 100),
        // specificityFactor is deliberately not reapplied here: the per-facet
        // searchCatalog calls already applied it to every component score, so
        // multiplying again raised a documented 0.6 penalty to 0.6^3 ≈ 0.22.
        score: Math.round(combined * 10000) / 10000,
      };
    })
    .sort((a, b) => b.score - a.score || a.code.localeCompare(b.code, 'en', { numeric: true }))
    .slice(0, limit);
}

/** Exact lookup, used to verify that a model-selected code actually exists. */
export function lookupCode(kind, code) {
  const doc = loadCatalog().byCode.get(`${kind}:${code}`);
  if (!doc) return null;
  return { code: doc.code, display: doc.display, kind: doc.kind, context: doc.context || [] };
}

/**
 * Builds the imaging-procedure candidate list from the structured facts that
 * the extraction step produced. Returns an empty list rather than guessing when
 * the modality is unknown — an empty list is a correct answer that the UI can
 * surface, whereas a guess is a billing error.
 */
/**
 * Imaging codes whose title names an invasive or contrast-dependent technique.
 *
 * ICD-9 encodes the technique in the title rather than as a "with" clause, so the
 * qualifier penalty never sees it, and BM25 favours these entries because
 * "contrast radiogram" repeats the modality words: a plain abdominal film
 * retrieved 88.11, "Pelvic opaque dye contrast radiography", and a neck film
 * retrieved 87.06, a nasopharyngeal contrast study. Both are separately billable
 * procedures involving an injection the report never documented.
 */
const CONTRAST_STUDY = /\b(contrast|opaque dye|dye|angiogram|angiography|arteriogram|venogram|lymphangiogram|myelogram|urogram|pyelogram|cholangiogram|sialogram|fistulogram|gas)\b/i;

export function procedureCandidates({ modality, bodyRegion, contrast } = {}, { limit = 8 } = {}) {
  const modalityTerms = HEBREW_TERMS.modality[modality] || [];
  if (modalityTerms.length === 0) return [];
  const anatomyTerms = HEBREW_TERMS.anatomy[bodyRegion] || [];

  const results = searchFaceted(
    [{ name: 'modality', terms: modalityTerms }, { name: 'anatomy', terms: anatomyTerms }],
    { kind: 'procedure', codePrefixes: IMAGING_CODE_PREFIXES, limit },
  );

  // Order the list so that what a coder sees first is what the evidence
  // supports, and expose `groundedInAllFacets` so the caller can decline to
  // promote a weakly-matched entry. Two corrections, in priority order:
  //
  // 1. A code matching only one facet reached the list on the floor score, so
  //    its rank came from its code number rather than from evidence: 87.14
  //    "contrast radiogram of orbit" won every x-ray whose anatomy did not
  //    match, and 87.71 "CT of kidney" won every CT.
  // 2. A contrast study is a separately billable procedure involving an
  //    injection. Unless the report documents one, the plain studies rank first.
  const wantsContrast = contrast === 'עם חומר ניגוד';
  const rank = (entry) => {
    const grounded = entry.groundedInAllFacets ? 0 : 2;
    const unwantedContrast = !wantsContrast && CONTRAST_STUDY.test(entry.display) ? 1 : 0;
    return grounded + unwantedContrast;
  };

  return results
    .map((entry) => ({ ...entry, groundedInAllFacets: entry.facetsMatched >= facetCount(anatomyTerms) }))
    .sort((a, b) => rank(a) - rank(b) || b.score - a.score);
}

/** How many facets a code has to match to be considered fully grounded. */
function facetCount(anatomyTerms) {
  return anatomyTerms.length > 0 ? 2 : 1;
}

/** Builds the diagnosis candidate list for one extracted finding. */
export function diagnosisCandidates(searchTerms, { limit = 6 } = {}) {
  if (!searchTerms || searchTerms.length === 0) return [];
  return searchCatalog(searchTerms, { kind: 'diagnosis', limit });
}

export function catalogManifest() {
  return loadCatalog().manifest;
}
