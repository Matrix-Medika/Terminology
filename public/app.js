const state = {
  currentView: 'intake',
  selectedFile: null,
  pastedText: '',
  analysis: null,
  masked: false,
  lastPayload: null,
  coding: { diagnoses: [], procedures: [] },
  reviewOutcome: null,
};

const $ = (id) => document.getElementById(id);
const views = {
  intake: $('intakeView'),
  processing: $('processingView'),
  result: $('resultView'),
};

const chooseFile = $('chooseFile');
const fileInput = $('fileInput');
const dropZone = $('dropZone');
const analyzeText = $('analyzeText');
const pastedText = $('pastedText');
const intakeError = $('intakeError');
const newAnalysisTop = $('newAnalysisTop');
const newAnalysisBottom = $('newAnalysisBottom');
const maskToggle = $('maskToggle');
const reanalyze = $('reanalyze');
const approveResult = $('approveResult');
const recheckResult = $('recheckResult');
const recheckReasonWrap = $('recheckReasonWrap');
const recheckReason = $('recheckReason');
const saveAndNext = $('saveAndNext');
const sourceDrawer = $('sourceDrawer');
const closeDrawer = $('closeDrawer');
const sourceText = $('sourceText');
const sourceEvidence = $('sourceEvidence');
const toast = $('toast');

function setView(name) {
  state.currentView = name;
  Object.entries(views).forEach(([key, element]) => {
    element.classList.toggle('view-active', key === name);
  });
  newAnalysisTop.classList.toggle('hidden', name === 'intake');
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function showError(message) {
  intakeError.textContent = message;
  intakeError.classList.remove('hidden');
}

function clearError() {
  intakeError.classList.add('hidden');
  intakeError.textContent = '';
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  window.setTimeout(() => toast.classList.add('hidden'), 3200);
}

function formatConfidence(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${Math.round(numeric)}%` : '—';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function makeEvidenceButton(evidence) {
  if (!evidence) return '';
  return `<button class="fact-evidence" type="button" data-evidence="${escapeHtml(evidence)}">צפייה בראיה</button>`;
}

function renderFacts(analysis) {
  const facts = [
    { label: 'שם המטופל', value: analysis.patient?.name || 'לא נמצא', sensitive: true, evidence: analysis.patient?.evidence?.name || null },
    { label: 'תעודת זהות', value: analysis.patient?.id || 'לא נמצא', sensitive: true, evidence: analysis.patient?.evidence?.id || null },
    { label: 'תאריך לידה', value: analysis.patient?.birthDate || 'לא נמצא', sensitive: true, evidence: analysis.patient?.evidence?.birthDate || null },
    { label: 'סוג מסמך', value: analysis.document?.type || 'מסמך רפואי', evidence: analysis.document?.evidence?.type || analysis.procedure?.evidence },
    { label: 'בדיקה', value: [analysis.procedure?.modality, analysis.procedure?.anatomicalSite].filter(Boolean).join(' · ') || 'לא זוהתה', evidence: analysis.procedure?.evidence },
    { label: 'סטטוס', value: analysis.procedure?.status || 'לא ידוע', evidence: analysis.procedure?.evidence },
    { label: 'חומר ניגוד', value: analysis.procedure?.contrast || 'לא תועד', evidence: analysis.procedure?.protocol },
    { label: 'תאריך בדיקה', value: analysis.procedure?.examDate || 'לא נמצא', evidence: analysis.procedure?.examDate ? `הבדיקה בוצעה בתאריך: ${analysis.procedure.examDate}` : null },
    { label: 'רופא מפענח', value: analysis.document?.radiologist || 'לא נמצא', evidence: analysis.document?.evidence?.radiologist || analysis.document?.radiologist },
  ];

  $('factsGrid').innerHTML = facts.map((fact) => `
    <article class="fact-card">
      <div class="fact-label">${escapeHtml(fact.label)}</div>
      <div class="fact-value ${fact.sensitive && state.masked ? 'masked' : ''}">${escapeHtml(fact.value)}</div>
      ${makeEvidenceButton(fact.evidence)}
    </article>
  `).join('');
  const highlights = [
    [analysis.procedure?.modality, analysis.procedure?.anatomicalSite].filter(Boolean).join(' · '),
    analysis.procedure?.contrast,
    `${analysis.findings?.length || 0} ממצאים זוהו`,
  ].filter(Boolean);
  $('factsHighlights').innerHTML = highlights.map((value) => `<span>${escapeHtml(value)}</span>`).join('');
}

function renderFindings(analysis) {
  const findings = Array.isArray(analysis.findings) ? analysis.findings : [];
  $('findingsCount').textContent = String(findings.length);
  $('findingsList').innerHTML = findings.length
    ? findings.map((finding) => `
        <article class="finding-row">
          <span class="finding-dot" aria-hidden="true"></span>
          <div>
            <div class="finding-title">${escapeHtml(finding.label)}</div>
            <div class="finding-evidence">${escapeHtml(finding.evidence || 'לא נשמרה ראיה')}</div>
          </div>
          <div class="finding-actions">
            <span class="severity-chip">${escapeHtml(finding.severity || 'לא סווג')}</span>
            ${makeEvidenceButton(finding.evidence)}
          </div>
        </article>
      `).join('')
    : '<div class="subtle-text">לא חולצו ממצאים קליניים מהמסמך.</div>';
}

function makeCandidate(code, display, match, system, context = null, partial = false) {
  return { code, display, match, system, context, partial };
}

/**
 * Builds the selection state from the catalog candidates the server returned.
 *
 * Every code shown here comes from the retrieved candidate list. This function
 * used to fall back to hardcoded ICD-10 and CPT codes when the server returned
 * nothing — codes that were never in any catalog and did not describe the
 * document on screen. An empty list is the honest rendering of "the catalog had
 * no match", and it is what a coder needs to see in order to intervene.
 */
/**
 * Describes how clearly the leading candidate beat the runner-up.
 *
 * The match percentage is normalised against the best hit, so the selected code
 * is always 100% — printing that on every row reads as certainty while carrying
 * no information. The gap to the second candidate does carry information: a
 * runner-up scoring 28 means the wording pointed decisively at one code, while
 * one scoring 97 means two codes fit almost equally and the coder is the only
 * one who can separate them. That is the signal worth showing.
 */
function describeSeparation(alternatives) {
  const runnerUp = Number(alternatives[0]?.match);
  if (!Number.isFinite(runnerUp)) return { label: 'ניסוח מובהק', tone: 'clear' };
  if (runnerUp <= 40) return { label: 'ניסוח מובהק', tone: 'clear' };
  if (runnerUp <= 75) return { label: 'יש חלופה קרובה', tone: 'review' };
  return { label: 'חלופות שקולות', tone: 'ambiguous' };
}

function toSelectionItems(entries, type) {
  return entries.map((entry, index) => {
    const alternatives = (entry.candidates || [])
      .filter((candidate) => candidate.code !== entry.code)
      .slice(0, 5)
      .map((candidate) => makeCandidate(
        candidate.code, candidate.display, candidate.match, entry.system, candidate.context, candidate.partial === true,
      ));
    // The selected code's own match against the catalog, not a default. It used
    // to fall back to 100 when the list was empty, which printed a full progress
    // bar and a certainty the server had never asserted.
    const selected = (entry.candidates || []).find((candidate) => candidate.code === entry.code);
    return {
      id: `${type}-${index}`,
      type,
      included: true,
      ...makeCandidate(
        entry.code, entry.display, selected?.match ?? null, entry.system, entry.label, selected?.partial === true,
      ),
      separation: describeSeparation(alternatives),
      alternatives,
    };
  });
}

function initializeCodingState(analysis) {
  const mappings = Array.isArray(analysis.terminology?.findings) ? analysis.terminology.findings : [];
  const diagnosisEntries = mappings
    .filter((mapping) => mapping.icd9?.code)
    .map((mapping) => ({ ...mapping.icd9, label: mapping.label }));
  state.coding.diagnoses = toSelectionItems(diagnosisEntries, 'diagnosis');

  const procedure = analysis.terminology?.procedure?.icd9;
  state.coding.procedures = procedure?.code
    ? toSelectionItems([procedure], 'procedure')
    : [];
}

function renderSelectionItem(item) {
  return `<article class="selection-item ${item.included ? 'is-included' : ''}">
    <label class="include-control">
      <input type="checkbox" data-toggle-code="${escapeHtml(item.id)}" ${item.included ? 'checked' : ''} />
      <span class="sr-only">${item.included ? 'הוצאה' : 'הכללה'} בחישוב</span>
    </label>
    <button class="clickable-code" type="button" data-open-alternatives="${escapeHtml(item.id)}" aria-label="חלופות לקוד ${escapeHtml(item.code)}">
      <b>${escapeHtml(item.code)}</b><span>⌄</span>
      <small>לחיצה להצגת חלופות</small>
    </button>
    <div class="selection-description"><strong>${escapeHtml(item.display || 'ללא תיאור')}</strong><span>${escapeHtml(item.context || item.system || '')}</span></div>
    <div class="match-score is-${escapeHtml(item.separation?.tone || 'clear')}"><strong>${escapeHtml(item.separation?.label || '—')}</strong><span>${item.alternatives.length} חלופות</span></div>
  </article>`;
}

function renderCodingWorkspace() {
  const empty = (message) => `<div class="subtle-text">${message}</div>`;
  $('diagnosisCodes').innerHTML = state.coding.diagnoses.length
    ? state.coding.diagnoses.map(renderSelectionItem).join('')
    : empty('לא נמצאו קודי אבחנה בקטלוג עבור הממצאים שחולצו.');
  $('procedureCodes').innerHTML = state.coding.procedures.length
    ? state.coding.procedures.map(renderSelectionItem).join('')
    : empty('לא הוצע קוד פרוצדורה — ראו את הפירוט בסעיף הטכני.');
  const diagnosisCount = state.coding.diagnoses.filter((item) => item.included).length;
  const procedureCount = state.coding.procedures.filter((item) => item.included).length;
  $('diagnosisCount').textContent = `${diagnosisCount} נבחרו`;
  $('procedureCount').textContent = `${procedureCount} נבחרו`;
}

function findCodingItem(id) {
  return [...state.coding.diagnoses, ...state.coding.procedures].find((item) => item.id === id);
}

function openAlternatives(item) {
  const popover = $('alternativePopover');
  const title = item.type === 'diagnosis' ? 'חלופות לקוד אבחנה' : 'חלופות לקוד פרוצדורה';
  const candidates = [makeCandidate(item.code, item.display, item.match, item.system, item.context), ...item.alternatives];
  popover.innerHTML = `<div class="alternative-head"><div><span>בחירה תשנה את החישוב</span><h3 id="alternativeTitle">${title}</h3></div><button type="button" data-close-alternatives aria-label="סגירה">×</button></div>
    <div class="alternative-list">${candidates.map((candidate) => `<button class="alternative-row ${candidate.code === item.code ? 'current' : ''}" type="button" data-select-alternative="${escapeHtml(item.id)}" data-code="${escapeHtml(candidate.code)}">
      <span class="alternative-code">${escapeHtml(candidate.code)}</span>
      <span class="alternative-description">${escapeHtml(candidate.display || 'ללא תיאור')}<small>${escapeHtml(candidate.context || candidate.system || '')}</small></span>
      <span class="alternative-match">${candidate.partial
        ? '<b class="is-partial">התאמה חלקית</b><small>לא תואם את כל מאפייני הבדיקה</small>'
        : `<b>${formatConfidence(candidate.match)}</b><progress max="100" value="${Math.min(100, Number(candidate.match) || 0)}" aria-label="אחוז התאמת ניסוח"></progress>`}</span>
      <span class="alternative-action">${candidate.code === item.code ? 'נבחר' : 'בחירה'}</span>
    </button>`).join('')}</div>
    <p class="alternative-note">האחוז מודד התאמת ניסוח לקטלוג ICD-9 — לא סבירות קלינית. "התאמה חלקית" = הקוד תואם רק חלק ממאפייני הבדיקה. הבחירה דורשת אימות מקודד.</p>`;
  popover.classList.remove('hidden');
}

function renderBilling(analysis) {
  const billing = analysis.billing || {};
  const diagnoses = state.coding.diagnoses.filter((item) => item.included);
  const procedures = state.coding.procedures.filter((item) => item.included);
  const selectionMade = Boolean(diagnoses.length && procedures.length);
  const primaryProcedure = procedures[0];
  // The service code comes from the MoH tariff, which is not loaded, so there is
  // nothing to derive. Showing the ICD-9 procedure code in its place would be
  // misleading: ICD-9 classifies what was done, it does not price it.
  const tariffLoaded = Boolean(billing.code);
  $('billingStatusBadge').textContent = tariffLoaded
    ? (selectionMade ? 'תוצאה מחושבת' : 'חסרה בחירה')
    : 'מחירון לא טעון';
  const badgeColour = tariffLoaded && selectionMade ? 'success' : 'amber';
  $('billingStatusBadge').style.color = `var(--${badgeColour})`;
  $('billingStatusBadge').style.background = `var(--${badgeColour}-soft)`;

  $('billingCard').innerHTML = `
    <div class="billing-main">
      <div class="billing-label">${escapeHtml(tariffLoaded ? 'קוד חיוב שנגזר מהבחירה' : 'קוד חיוב')}</div>
      <div class="billing-code">${escapeHtml(billing.code || '—')}</div>
      <div class="billing-display">${escapeHtml(tariffLoaded
        ? (selectionMade ? (billing.display || 'קוד שירות מוצע') : 'יש לבחור לפחות אבחנה ופרוצדורה אחת')
        : (billing.display || 'מחירון משרד הבריאות אינו טעון — לא ניתן להפיק קוד חיוב'))}</div>
      <div class="billing-display">${escapeHtml(primaryProcedure
        ? `קוד פרוצדורה נבחר: ${primaryProcedure.code} (ICD-9-CM, לתיעוד — לא לתמחור)`
        : 'לא נבחר קוד פרוצדורה')}</div>
    </div>
    <div class="billing-dependency">
      <span class="dependency-label">מושפע מ־</span>
      <div class="dependency-groups">
        <div><b>אבחנות</b>${diagnoses.map((item) => `<span class="dependency-chip diagnosis-chip">${escapeHtml(item.code)}</span>`).join('') || '<em>לא נבחרו</em>'}</div>
        <span class="dependency-plus">+</span>
        <div><b>פרוצדורות</b>${procedures.map((item) => `<span class="dependency-chip procedure-chip">${escapeHtml(item.code)}</span>`).join('') || '<em>לא נבחרו</em>'}</div>
      </div>
      <p>${escapeHtml(billing.eligibility || 'התוצאה מתעדכנת בכל שינוי בקודים שנבחרו.')}</p>
    </div>
  `;
}

function recalculateBilling(message = 'קוד החיוב עודכן בהתאם') {
  renderCodingWorkspace();
  renderBilling(state.analysis);
  const status = $('recalculationStatus');
  status.textContent = message;
  status.classList.add('just-updated');
  window.setTimeout(() => {
    status.textContent = 'מתעדכן לפי הבחירה';
    status.classList.remove('just-updated');
  }, 1800);
}

function renderTechnical(analysis) {
  const warnings = Array.isArray(analysis.warnings) ? analysis.warnings : [];
  $('technicalDetails').innerHTML = `
    <ul>
      <li>מנוע חילוץ: ${escapeHtml(analysis.extractionProvider || 'לא ידוע')}</li>
      <li>נותחו ${escapeHtml(String(analysis.findings?.length || 0))} ממצאים קליניים.</li>
      ${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}
    </ul>
  `;
}

function renderSummary(analysis) {
  const procedureName = [analysis.procedure?.modality, analysis.procedure?.anatomicalSite].filter(Boolean).join(' ');
  $('summaryTitle').textContent = procedureName || 'לא זוהתה פרוצדורה';
  $('summaryMeta').textContent = [
    analysis.procedure?.status,
    analysis.procedure?.signed ? 'דו״ח חתום' : 'חתימה לא זוהתה',
    analysis.procedure?.contrast,
  ].filter(Boolean).join(' · ');
  $('confidenceValue').textContent = formatConfidence(analysis.confidence);
  $('resultSubtitle').textContent = analysis.fileName ? `נותח המסמך: ${analysis.fileName}` : 'העובדות מוצגות לפני הקודים.';
}

function renderResult(analysis) {
  state.analysis = analysis;
  state.reviewOutcome = null;
  initializeCodingState(analysis);
  renderSummary(analysis);
  renderFacts(analysis);
  renderFindings(analysis);
  renderCodingWorkspace();
  renderBilling(analysis);
  renderTechnical(analysis);
  updateReviewControls();
  setView('result');
  window.setTimeout(() => $('resultTitle').scrollIntoView({ block: 'start', behavior: 'smooth' }), 80);
}

function openSource(evidence = '') {
  if (!state.analysis) return;
  sourceEvidence.textContent = evidence || 'המסמך המלא מוצג ללא סימון ראיה מסוימת.';
  sourceText.textContent = state.analysis.sourceText || 'טקסט המקור אינו זמין.';
  sourceDrawer.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeSource() {
  sourceDrawer.classList.add('hidden');
  document.body.style.overflow = '';
}

function updateSelectedFile(file) {
  clearError();
  state.selectedFile = file || null;
  if (!file) return;

  if (file.size > 25 * 1024 * 1024) {
    state.selectedFile = null;
    showError('הקובץ גדול מ־25MB.');
    return;
  }
  const title = dropZone.querySelector('.drop-title');
  const copy = dropZone.querySelector('.drop-copy');
  title.textContent = file.name;
  copy.textContent = `${Math.max(1, Math.round(file.size / 1024))}KB · מוכן לניתוח`;
  analyzeText.textContent = 'ניתוח המסמך';
}

function resetIntake() {
  state.selectedFile = null;
  state.pastedText = '';
  state.analysis = null;
  state.lastPayload = null;
  state.masked = false;
  state.coding = { diagnoses: [], procedures: [] };
  state.reviewOutcome = null;
  fileInput.value = '';
  pastedText.value = '';
  dropZone.querySelector('.drop-title').textContent = 'גררי לכאן PDF או TXT';
  dropZone.querySelector('.drop-copy').textContent = 'או בחרי קובץ מהמחשב · עד 25MB';
  maskToggle.textContent = 'הסתרת מזהים';
  clearError();
  setView('intake');
}

function updateReviewControls() {
  const approved = state.reviewOutcome === 'approved';
  const recheck = state.reviewOutcome === 'recheck';
  approveResult.setAttribute('aria-checked', String(approved));
  recheckResult.setAttribute('aria-checked', String(recheck));
  approveResult.classList.toggle('selected', approved);
  recheckResult.classList.toggle('selected', recheck);
  recheckReasonWrap.classList.toggle('hidden', !recheck);
  saveAndNext.disabled = !state.reviewOutcome || (recheck && !recheckReason.value.trim());
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || '');
      resolve(value.split(',')[1] || '');
    };
    reader.onerror = () => reject(new Error('קריאת הקובץ נכשלה'));
    reader.readAsDataURL(file);
  });
}

function beginProgress() {
  setView('processing');
  const titles = [
    ['קוראים את המסמך', 'מחלצים טקסט ושומרים את הראיות המקוריות.'],
    ['בונים עובדות קליניות', 'מפרידים בין פרטי מטופל, פרוצדורה וממצאים.'],
    ['ממפים לטרמינולוגיות', 'מתאימים רק מול קטלוגים מורשים ומציגים מועמדים.'],
    ['בודקים חיוב', 'בודקים הוכחת ביצוע, קוד שירות ומידע חסר.'],
  ];
  let current = 0;
  const progressBar = $('progressBar');
  const processSteps = [...document.querySelectorAll('.process-steps li')];

  const interval = window.setInterval(() => {
    current = Math.min(current + 1, 3);
    $('processingTitle').textContent = titles[current][0];
    $('processingSubtitle').textContent = titles[current][1];
    progressBar.style.width = `${20 + current * 24}%`;
    processSteps.forEach((step, index) => step.classList.toggle('active', index <= current));
  }, 800);

  return () => {
    window.clearInterval(interval);
    progressBar.style.width = '100%';
    processSteps.forEach((step) => step.classList.add('active'));
  };
}

async function submitAnalysis() {
  clearError();
  const text = pastedText.value.trim();
  if (!state.selectedFile && !text) {
    showError('בחרי מסמך או הדביקי טקסט רפואי.');
    return;
  }

  const finishProgress = beginProgress();
  try {
    const payload = {
      filename: state.selectedFile?.name || 'טקסט מודבק',
      mimeType: state.selectedFile?.type || 'text/plain',
      pastedText: text || null,
      fileBase64: state.selectedFile ? await fileToBase64(state.selectedFile) : null,
    };
    state.lastPayload = payload;

    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await response.json().catch(() => ({}));
    if (result.debugTelemetry) console.info('[DEBUGGING_MODE] analysis telemetry', result.debugTelemetry);
    if (!response.ok || !result.ok) {
      throw new Error(result.error || 'עיבוד המסמך נכשל.');
    }

    finishProgress();
    window.setTimeout(() => renderResult(result.analysis), 350);
  } catch (error) {
    finishProgress();
    resetIntake();
    showError(`${error.message} הקובץ לא הוחלף במקרה דמו.`);
  }
}

async function rerunAnalysis() {
  if (!state.lastPayload) return;
  const finishProgress = beginProgress();
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.lastPayload),
    });
    const result = await response.json();
    if (result.debugTelemetry) console.info('[DEBUGGING_MODE] analysis telemetry', result.debugTelemetry);
    if (!response.ok || !result.ok) throw new Error(result.error || 'הרצה מחדש נכשלה');
    finishProgress();
    window.setTimeout(() => renderResult(result.analysis), 350);
  } catch (error) {
    finishProgress();
    renderResult(state.analysis);
    showToast(error.message);
  }
}

chooseFile.addEventListener('click', (event) => {
  event.stopPropagation();
  fileInput.click();
});

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') fileInput.click();
});
fileInput.addEventListener('change', () => updateSelectedFile(fileInput.files?.[0]));

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('dragging');
  });
}
dropZone.addEventListener('drop', (event) => updateSelectedFile(event.dataTransfer?.files?.[0]));

analyzeText.addEventListener('click', submitAnalysis);
newAnalysisTop.addEventListener('click', resetIntake);
newAnalysisBottom.addEventListener('click', resetIntake);
reanalyze.addEventListener('click', rerunAnalysis);

maskToggle.addEventListener('click', () => {
  state.masked = !state.masked;
  maskToggle.textContent = state.masked ? 'הצגת מזהים' : 'הסתרת מזהים';
  if (state.analysis) renderFacts(state.analysis);
});

approveResult.addEventListener('click', () => {
  state.reviewOutcome = 'approved';
  updateReviewControls();
});
recheckResult.addEventListener('click', () => {
  state.reviewOutcome = 'recheck';
  updateReviewControls();
  window.setTimeout(() => recheckReason.focus(), 0);
});
recheckReason.addEventListener('input', updateReviewControls);
saveAndNext.addEventListener('click', () => {
  if (saveAndNext.disabled) return;
  showToast(state.reviewOutcome === 'approved' ? 'הבדיקה אושרה לחיוב ונשמרה.' : 'הבדיקה סומנה לבדיקה חוזרת ונשמרה.');
  window.setTimeout(resetIntake, 650);
});
closeDrawer.addEventListener('click', closeSource);
sourceDrawer.addEventListener('click', (event) => {
  if (event.target === sourceDrawer) closeSource();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSource();
});

document.addEventListener('click', (event) => {
  const evidenceButton = event.target.closest('[data-evidence]');
  if (evidenceButton) openSource(evidenceButton.dataset.evidence);
  const sourceButton = event.target.closest('[data-open-source]');
  if (sourceButton) openSource('');
  const codeToggle = event.target.closest('[data-toggle-code]');
  if (codeToggle) {
    const item = findCodingItem(codeToggle.dataset.toggleCode);
    if (item) {
      item.included = codeToggle.checked;
      recalculateBilling();
    }
  }
  const alternativeTrigger = event.target.closest('[data-open-alternatives]');
  if (alternativeTrigger) {
    const item = findCodingItem(alternativeTrigger.dataset.openAlternatives);
    if (item) openAlternatives(item);
  }
  if (event.target.closest('[data-close-alternatives]')) $('alternativePopover').classList.add('hidden');
  const alternativeChoice = event.target.closest('[data-select-alternative]');
  if (alternativeChoice) {
    const item = findCodingItem(alternativeChoice.dataset.selectAlternative);
    const candidate = item ? [makeCandidate(item.code, item.display, item.match, item.system, item.context), ...item.alternatives]
      .find((option) => option.code === alternativeChoice.dataset.code) : null;
    if (item && candidate) {
      const previous = makeCandidate(item.code, item.display, item.match, item.system, item.context);
      item.code = candidate.code;
      item.display = candidate.display;
      item.match = candidate.match;
      item.system = candidate.system;
      item.context = candidate.context;
      item.alternatives = [previous, ...item.alternatives.filter((option) => option.code !== candidate.code)]
        .filter((option, index, all) => all.findIndex((entry) => entry.code === option.code) === index)
        .slice(0, 5);
      $('alternativePopover').classList.add('hidden');
      recalculateBilling(`הקוד הוחלף ל־${candidate.code} · החיוב עודכן`);
    }
  }
});

fetch('/api/health').catch(() => {});
