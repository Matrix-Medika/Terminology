import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadCatalog,
  searchCatalog,
  searchFaceted,
  lookupCode,
  procedureCandidates,
  diagnosisCandidates,
  catalogManifest,
  tokenize,
  IMAGING_CODE_PREFIXES,
} from '../lib/catalog.js';

test('the catalog loads both ICD-9 code families', () => {
  const catalog = loadCatalog();
  const procedures = catalog.documents.filter((doc) => doc.kind === 'procedure');
  const diagnoses = catalog.documents.filter((doc) => doc.kind === 'diagnosis');
  assert.ok(procedures.length > 4000, `expected >4000 procedures, got ${procedures.length}`);
  assert.ok(diagnoses.length > 16000, `expected >16000 diagnoses, got ${diagnoses.length}`);
  // The fifth-digit expansion is what makes most diagnoses billable, so guard
  // against a parser regression silently dropping them again.
  assert.ok(diagnoses.filter((doc) => doc.assignable).length > 13000);
});

test('the manifest records provenance so a coder can audit the edition', () => {
  const manifest = catalogManifest();
  assert.match(manifest.edition, /ICD-9-CM/);
  assert.match(manifest.source, /^https:\/\/ftp\.cdc\.gov\//);
  assert.equal(manifest.files.length, 2);
  for (const file of manifest.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
  }
});

test('tokenize drops stop words that carry no discriminating signal', () => {
  assert.deepEqual(tokenize('Magnetic resonance imaging of the spinal canal'),
    ['magnetic', 'resonance', 'imaging', 'spinal', 'canal']);
});

test('known imaging descriptions retrieve their official code first', () => {
  const cases = [
    ['magnetic resonance imaging spinal canal', '88.93'],
    ['diagnostic ultrasound abdomen retroperitoneum', '88.76'],
    ['computerized axial tomography abdomen', '88.01'],
    ['computerized axial tomography head', '87.03'],
  ];
  for (const [query, expected] of cases) {
    const results = searchCatalog(query, { kind: 'procedure', codePrefixes: IMAGING_CODE_PREFIXES });
    assert.equal(results[0]?.code, expected, `${query} -> ${results[0]?.code}`);
  }
});

test('retrieval is restricted to the requested code family', () => {
  const results = searchCatalog('spinal stenosis cervical', { kind: 'diagnosis' });
  assert.ok(results.length > 0);
  assert.ok(results.every((result) => result.kind === 'diagnosis'));
});

test('faceted search prefers a code matching both facets over one strong facet', () => {
  // "computerized axial tomography" alone matches dozens of entries, so a
  // single-facet winner must not beat the code that also matches the anatomy.
  const results = searchFaceted(
    [
      { name: 'modality', terms: ['computerized axial tomography'] },
      { name: 'anatomy', terms: ['thorax', 'chest'] },
    ],
    { kind: 'procedure', codePrefixes: IMAGING_CODE_PREFIXES, limit: 5 },
  );
  assert.equal(results[0].code, '87.41');
  assert.deepEqual(results[0].facetScores.length, 2);
});

test('procedureCandidates maps Hebrew-report facts onto real imaging codes', () => {
  const cases = [
    [{ modality: 'MRI', bodyRegion: 'cervical_spine' }, '88.93'],
    [{ modality: 'MRI', bodyRegion: 'brain' }, '88.91'],
    [{ modality: 'MRI', bodyRegion: 'pelvis' }, '88.95'],
    [{ modality: 'CT', bodyRegion: 'abdomen' }, '88.01'],
    [{ modality: 'CT', bodyRegion: 'chest' }, '87.41'],
    [{ modality: 'US', bodyRegion: 'abdomen' }, '88.76'],
    [{ modality: 'US', bodyRegion: 'urinary' }, '88.75'],
    [{ modality: 'XRAY', bodyRegion: 'chest' }, '87.44'],
  ];
  for (const [facts, expected] of cases) {
    const candidates = procedureCandidates(facts);
    assert.equal(candidates[0]?.code, expected,
      `${facts.modality}/${facts.bodyRegion} -> ${candidates[0]?.code} (${candidates[0]?.display})`);
  }
});

test('every procedure candidate stays inside the imaging block', () => {
  const candidates = procedureCandidates({ modality: 'MRI', bodyRegion: 'brain' }, { limit: 8 });
  assert.ok(candidates.length > 0);
  for (const candidate of candidates) {
    assert.ok(IMAGING_CODE_PREFIXES.some((prefix) => candidate.code.startsWith(prefix)),
      `${candidate.code} is outside the imaging block`);
  }
});

test('an unknown modality returns no candidates instead of guessing', () => {
  assert.deepEqual(procedureCandidates({ modality: null, bodyRegion: 'abdomen' }), []);
  assert.deepEqual(procedureCandidates({ modality: 'UNKNOWN_MODALITY', bodyRegion: 'abdomen' }), []);
  assert.deepEqual(procedureCandidates({}), []);
});

test('one supported qualifier does not license the unsupported ones', () => {
  // The penalty used to be all-or-nothing: as soon as any "with X" clause was
  // supported, every other clause was exempted. So a report documenting stones
  // *and* acute cholecystitis scored 574.01, "…with acute cholecystitis, with
  // obstruction", above its "without mention of obstruction" sibling — adding an
  // obstruction the report never mentioned.
  const [top] = searchCatalog(['calculus of gallbladder', 'acute cholecystitis'], {
    kind: 'diagnosis',
    limit: 5,
  });
  assert.equal(top.code, '574.00');
  assert.match(top.display, /without mention of obstruction/);
});

test('candidates report whether they matched every facet', () => {
  // The floor score keeps a single-facet match visible, but its rank then comes
  // from its code number rather than from evidence, so the caller has to be able
  // to tell the two apart instead of promoting whatever sorted first.
  const [top] = procedureCandidates({ modality: 'MRI', bodyRegion: 'cervical_spine' });
  assert.equal(top.code, '88.93');
  assert.equal(top.groundedInAllFacets, true);

  const unmatched = procedureCandidates({ modality: 'CT', bodyRegion: 'pelvis' });
  assert.ok(unmatched.length > 0, 'the coder still needs a list to choose from');
  assert.ok(unmatched.every((candidate) => candidate.groundedInAllFacets === false));
});

test('faceted search over an unrestricted kind does not throw', () => {
  // The document lookup hardcoded the procedure namespace, so any code coming
  // back from an unrestricted search failed to resolve and threw on .display.
  const results = searchFaceted([{ name: 'finding', terms: ['pleural effusion'] }], { limit: 2 });
  assert.ok(results.length > 0);
  assert.ok(results.every((entry) => typeof entry.display === 'string'));
});

test('an unmapped anatomy still returns modality-level candidates for review', () => {
  // With no anatomy to narrow by, every MRI code is an equally plausible
  // candidate, so the coder should be shown the modality's own codes ranked
  // ahead of the generic "diagnostic imaging NEC" fallback.
  const candidates = procedureCandidates({ modality: 'MRI', bodyRegion: 'not_a_region' }, { limit: 6 });
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((candidate) => /magnetic resonance/i.test(candidate.display)),
    candidates.map((candidate) => `${candidate.code} ${candidate.display}`).join(' | '));
});

test('diagnosisCandidates finds findings by their clinical description', () => {
  assert.equal(diagnosisCandidates(['spinal stenosis', 'cervical'])[0].code, '723.0');
  assert.equal(diagnosisCandidates(['hepatomegaly', 'enlarged liver'])[0].code, '789.1');
  // 789.0 requires a fifth digit, so only its specified children are offered.
  const abdominalPain = diagnosisCandidates(['abdominal pain'], { limit: 9 });
  assert.ok(abdominalPain.every((candidate) => /^789\.0\d$/.test(candidate.code)),
    abdominalPain.map((candidate) => candidate.code).join(' '));
  assert.deepEqual(diagnosisCandidates([]), []);
  assert.deepEqual(diagnosisCandidates(null), []);
});

test('fifth-digit codes are expanded and carry the digit meaning', () => {
  // ICD-9 declares the fifth digit once per category, so 574.00 and 574.01 would
  // otherwise be indistinguishable duplicates of the same rubric text.
  const catalog = loadCatalog();
  const withObstruction = catalog.byCode.get('diagnosis:574.01');
  const withoutObstruction = catalog.byCode.get('diagnosis:574.00');
  assert.match(withObstruction.display, /with obstruction$/);
  assert.match(withoutObstruction.display, /without mention of obstruction$/);
  assert.equal(withObstruction.specifiesDigitOf, '574.0');
  assert.equal(catalog.byCode.get('diagnosis:789.03').display, 'Abdominal pain, right lower quadrant');
});

test('codes a biller cannot submit are excluded from candidate lists', () => {
  const catalog = loadCatalog();
  // A category heading with subdivisions.
  assert.equal(catalog.byCode.get('procedure:88.9').assignable, false);
  // A code still missing its required fifth digit.
  assert.equal(catalog.byCode.get('diagnosis:574.0').assignable, false);
  assert.equal(catalog.byCode.get('diagnosis:574.00').assignable, true);

  const results = searchCatalog('cholelithiasis calculus gallbladder', { kind: 'diagnosis', limit: 20 });
  assert.ok(results.length > 0);
  for (const result of results) {
    assert.equal(catalog.byCode.get(`diagnosis:${result.code}`).assignable, true,
      `${result.code} is not assignable but was offered as a candidate`);
  }
});

test('lookupCode verifies a selected code exists, which blocks invented codes', () => {
  const found = lookupCode('procedure', '88.93');
  assert.equal(found.display, 'Magnetic resonance imaging of spinal canal');
  assert.equal(lookupCode('procedure', '88.9999'), null);
  assert.equal(lookupCode('procedure', 'L0444'), null);
  // Code families are separate namespaces: 723.0 is a diagnosis, not a procedure.
  assert.equal(lookupCode('procedure', '723.0'), null);
  assert.ok(lookupCode('diagnosis', '723.0'));
});

test('hierarchy context is attached so terse entries remain interpretable', () => {
  // "015.1 Hip" is meaningless without its parent, "Tuberculosis of bones and joints".
  const hip = loadCatalog().byCode.get('diagnosis:015.1');
  assert.equal(hip.display, 'Hip');
  assert.ok(hip.context.some((line) => /tuberculosis/i.test(line)), JSON.stringify(hip.context));
});

test('retrieval is fast enough to run inline on every request', () => {
  loadCatalog();
  const started = performance.now();
  for (let index = 0; index < 100; index += 1) {
    procedureCandidates({ modality: 'MRI', bodyRegion: 'abdomen' });
  }
  const perCall = (performance.now() - started) / 100;
  assert.ok(perCall < 20, `retrieval took ${perCall.toFixed(2)}ms per call`);
});
