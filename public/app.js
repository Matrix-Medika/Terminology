const state = {
  currentView: 'intake',
  selectedFile: null,
  pastedText: '',
  analysis: null,
  masked: false,
  lastPayload: null,
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

function statusClass(status) {
  if (status === 'matched') return 'matched';
  if (status === 'candidate' || status === 'needs_review') return 'candidate';
  return '';
}

function statusText(status) {
  const map = {
    matched: 'מותאם',
    candidate: 'מועמד',
    needs_review: 'דורש בדיקה',
    not_applicable: 'לא חל',
  };
  return map[status] || status || '—';
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

function renderProcedureCodes(analysis) {
  const codes = [
    analysis.terminology?.procedure?.icd9,
    analysis.terminology?.procedure?.snomed,
    analysis.terminology?.procedure?.billing,
  ].filter(Boolean);

  $('procedureCodes').innerHTML = codes.map((code) => `
    <article class="code-card ${statusClass(code.status)}">
      <div class="code-system">${escapeHtml(code.system)}</div>
      <div class="code-value">${escapeHtml(code.code || '—')}</div>
      <div class="code-display">${escapeHtml(code.display || 'לא נמצא תיאור')}</div>
      <div class="code-meta">
        <span>${escapeHtml(statusText(code.status))}</span>
        <span class="code-confidence">${formatConfidence((code.confidence || 0) * 100)}</span>
      </div>
    </article>
  `).join('');
}

function renderFindingCodes(analysis) {
  const mappings = Array.isArray(analysis.terminology?.findings) ? analysis.terminology.findings : [];
  $('findingCodes').innerHTML = mappings.length
    ? mappings.map((mapping) => `
        <div class="finding-code-row">
          <div>
            <strong>${escapeHtml(mapping.label)}</strong>
            <div class="finding-evidence">${escapeHtml(mapping.evidence || '')}</div>
          </div>
          <div class="finding-code-cell">
            SNOMED CT
            <b>${escapeHtml(mapping.snomed?.code || 'דורש אימות')}</b>
            ${escapeHtml(mapping.snomed?.display || '')}
          </div>
          <div class="finding-code-cell">
            ICD‑9
            <b>${escapeHtml(mapping.icd9?.code || 'דורש אימות')}</b>
            ${escapeHtml(mapping.icd9?.display || '')}
          </div>
        </div>
      `).join('')
    : '<div class="technical-details">לא זוהו ממצאים למיפוי.</div>';
}

function renderBilling(analysis) {
  const billing = analysis.billing || {};
  $('billingStatusBadge').textContent = billing.eligible ? 'בר־חיוב' : 'נדרשת בדיקה';
  $('billingStatusBadge').style.color = billing.eligible ? 'var(--success)' : 'var(--amber)';
  $('billingStatusBadge').style.background = billing.eligible ? 'var(--success-soft)' : 'var(--amber-soft)';

  $('billingCard').innerHTML = `
    <div class="billing-main">
      <div class="billing-label">קוד שירות מוצע</div>
      <div class="billing-code">${escapeHtml(billing.code || '—')}</div>
      <div class="billing-display">${escapeHtml(billing.display || 'לא נמצא קוד שירות')}</div>
    </div>
    <div class="billing-details">
      <div class="billing-detail">
        <span>זכאות לפי המסמך</span>
        <strong>${escapeHtml(billing.eligibility || 'לא ניתן לקבוע')}</strong>
      </div>
      <div class="billing-detail">
        <span>תעריף רשמי</span>
        <strong>${escapeHtml(billing.amountStatus || 'לא זמין')}</strong>
      </div>
      <div class="billing-detail">
        <span>סכום להגשה</span>
        <strong>${escapeHtml(billing.claimStatus || 'לא ניתן לקבוע')}</strong>
      </div>
    </div>
  `;
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
  renderSummary(analysis);
  renderFacts(analysis);
  renderFindings(analysis);
  renderProcedureCodes(analysis);
  renderFindingCodes(analysis);
  renderBilling(analysis);
  renderTechnical(analysis);
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
  fileInput.value = '';
  pastedText.value = '';
  dropZone.querySelector('.drop-title').textContent = 'גררי לכאן PDF או TXT';
  dropZone.querySelector('.drop-copy').textContent = 'או בחרי קובץ מהמחשב · עד 25MB';
  maskToggle.textContent = 'הסתרת מזהים';
  clearError();
  setView('intake');
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

approveResult.addEventListener('click', () => showToast('התוצאה סומנה לבדיקה אנושית. לא בוצע חיוב אוטומטי.'));
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
});

fetch('/api/health').catch(() => {});
