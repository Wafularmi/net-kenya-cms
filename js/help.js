(function() {
if (window._helpReady) return;
window._helpReady = true;

// ===== HELP TEXT MAP =====
const H = {
  // Navigation / Sidebar
  'menu-toggle': 'Toggle the sidebar menu to navigate between modules.',
  'nav-tab': 'Click to switch to a different module or section of the system.',
  'dashboard': 'View key metrics, recent activity, and quick actions at a glance.',
  'student-hub': 'Access your personal student dashboard with courses and progress.',
  'portal': 'Open the student portal for fee statements, grades, and attendance.',
  'students': 'Manage student records: register, edit, search, and track enrollment.',
  'courses': 'Create and manage academic courses, assign instructors, and set credits.',
  'lessons': 'Organize lessons within courses with topics, notes, and attachments.',
  'attendance': 'Record and view student attendance for classes and sessions.',
  'grades': 'Enter and manage student grades for assignments and exams.',
  'exams': 'Create examinations, manage grade scales, and generate report cards.',
  'manuals': 'Upload and manage institutional manuals and policy documents.',
  'chapel': 'Record and manage chapel attendance and spiritual development.',
  'graduation': 'Manage graduation lists, clearance, and ceremony preparations.',
  'discussions': 'Facilitate class discussions and threaded conversations.',
  'questions': 'Build a question bank with multiple types for quizzes and exams.',
  'quizzes': 'Create quizzes from the question bank, set pass marks and time limits.',
  'submissions': 'View quiz submissions, scores, and student performance results.',
  'progress': 'Track student academic progress across courses and assessments.',
  'staff': 'Manage staff records, roles, assignments, and contact information.',
  'finance': 'Manage expenses, income, cash book, vouchers, and financial reports.',
  'hostel': 'Manage hostel allocations, rooms, and boarding student records.',
  'library': 'Manage library resources, book loans, and reading materials.',
  'inventory': 'Track institutional inventory, assets, and supplies.',
  'notes': 'Create and share study notes with students for each course.',
  'communication': 'Send bulk SMS and email communications to students and parents.',
  'verify': 'Verify the authenticity of official documents by their code.',
  'reprint': 'Re-print lost or damaged official documents like transcripts.',
  'pending': 'Review and approve pending student registrations.',
  'alumni': 'Manage alumni records, track graduates, and engagement.',
  'certificates': 'Generate certificates of participation, completion, and conduct.',
  'idcards': 'Design and print student and staff identification cards.',
  'events': 'Create and manage institutional events and activities.',
  'whatsapp': 'Send WhatsApp messages to students, staff, or groups.',
  'tickets': 'View and manage support tickets from users.',
  'audit': 'View the audit log of all system activities and changes.',
  'settings': 'Configure system settings: branding, signatures, users, and preferences.',

  // Dashboard
  'screen-dashboard': 'Dashboard showing key metrics, recent students, and financial summary.',
  'btn-quick-enroll': 'Quickly enroll a new student with minimal fields.',
  'whatsapp-blast': 'Send a bulk WhatsApp message to selected recipients.',
  'dash-recent-students': 'Shows recently enrolled students and their status.',
  'dash-finance': 'Financial summary showing fee income, expenses, and net balance.',
  'dash-upcoming': 'Upcoming events, birthdays, and important dates.',
  'dash-alerts': 'System alerts and notifications requiring attention.',

  // Finance
  'screen-finance': 'Financial management: expenses, income, cash book, and reports.',
  'btn-record-expense': 'Record a new expense and automatically generate a petty cash voucher.',
  'btn-cash-book': 'Open the cash book statement filtered by a date range.',
  'btn-add-income': 'Record income from various income categories.',
  'btn-expense-categories': 'Manage expense categories for organizing financial records.',
  'finance-stats': 'Financial statistics showing totals and balances at a glance.',
  'expenses-list': 'List of all recorded expenses. Click V to view or print the voucher.',
  'exp-v': 'View and manage the petty cash voucher for this expense. Upload signatures and print.',
  'exp-edit': 'Edit this expense record including amount, description, and voucher details.',
  'exp-delete': 'Delete this expense record permanently.',
  'exp-category': 'Select the category for this expense (e.g., Salaries, Utilities).',
  'exp-amount': 'Enter the total amount of the expense in KES.',
  'exp-date': 'The date when the expense was incurred.',
  'exp-paid-to': 'The name of the person or organization paid (e.g., staff name, company).',
  'exp-description': 'Brief description of what the expense was for.',
  'exp-receipt': 'Reference or receipt number (e.g., MPESA transaction ID, invoice #).',
  'exp-voucher-no': 'Auto-generated unique voucher number. Can be customized.',
  'exp-voucher-date': 'The date appearing on the petty cash voucher.',
  'btn-save-expense': 'Save this expense and generate its petty cash voucher.',
  'btn-update-expense': 'Save changes to this expense record.',

  // Voucher
  'btn-voucher-design': 'Change the template style and branding of the petty cash voucher.',
  'btn-download-pdf': 'Download the voucher as a PDF file to your device.',
  'btn-print': 'Print the voucher directly or save as PDF from the print dialog.',
  'voucher-paper-size': 'Select the paper size for printing: A4 (standard), A5 (half), or A6 (compact).',
  'sig-received': 'Upload the signature of the person who received the payment.',
  'sig-paid': 'Upload the signature of the authorized signatory who approved the payment.',
  'voucher-signatures': 'Upload and manage signatures for this specific voucher.',

  // Income
  'btn-income-categories': 'Manage income categories like Donations, Grants, and Rentals.',
  'inc-amount': 'Enter the amount of income received.',
  'inc-date': 'The date when the income was received.',
  'inc-payer': 'Name of the person or organization that paid.',
  'inc-description': 'Brief description of the income source or purpose.',
  'inc-category': 'Select the income category for this entry.',

  // Cash Book
  'cb-from': 'Start date for the cash book statement range.',
  'cb-to': 'End date for the cash book statement range.',
  'btn-generate-cb': 'Generate the cash book statement for the selected date range.',
  'btn-print-cb': 'Print the cash book statement or save as PDF.',

  // Students
  'screen-students': 'Student records management: register, search, and manage enrollments.',
  'btn-add-student': 'Register a new student with full enrollment details.',
  'students-search': 'Search for students by name, admission number, or phone number.',
  'students-filter': 'Filter students by status: Active, Graduated, Transferred, or Pending.',
  'students-body': 'List of all students matching the current search and filter criteria.',
  'student-edit': 'Edit this student\'s personal and academic information.',
  'student-delete': 'Delete this student record permanently.',
  'student-name': 'Full name of the student.',
  'student-adm': 'Unique admission/admission number assigned to the student.',
  'student-program': 'Academic program or course the student is enrolled in.',
  'student-status': 'Current enrollment status: Active, Graduated, Transferred, or Pending.',
  'student-phone': 'Student\'s phone number for communications and SMS alerts.',
  'student-email': 'Student\'s email address for official communications.',
  'student-dob': 'Student\'s date of birth.',
  'student-gender': 'Student\'s gender.',
  'student-guardian': 'Name and contact of the parent or guardian.',
  'student-fee': 'Total fee amount for the student\'s program.',

  // Exams
  'screen-exams': 'Examination management: create exams, enter grades, and generate report cards.',
  'btn-add-exam': 'Create a new examination with schedule and grading parameters.',
  'exam-name': 'Name of the examination (e.g., End of Term 1, Midterm).',
  'exam-date': 'Date when the examination was held.',
  'exam-max-score': 'Maximum possible score for this examination.',
  'exam-pass-mark': 'Minimum score required to pass this examination.',
  'btn-enter-grades': 'Enter or edit grades for students in this examination.',
  'btn-report-card': 'Generate and view report cards for students.',
  'grade-student': 'Select the student for grade entry.',
  'grade-score': 'Enter the score achieved by the student.',
  'grade-comment': 'Optional comment on the student\'s performance.',

  // Transcripts
  'btn-transcript': 'Generate an official transcript for this student.',
  'btn-certificate': 'Generate a certificate of completion or participation.',
  'transcript-type': 'Select the type of transcript document to generate.',
  'transcript-student': 'Select the student for whom to generate the transcript.',
  'btn-download-transcript': 'Download the transcript as a PDF document.',

  // Settings
  'screen-settings': 'System configuration: branding, roles, signatures, and preferences.',
  'school-name': 'The name of the institution displayed on all documents and the header.',
  'school-tagline': 'The institution\'s motto or tagline shown under the school name.',
  'school-logo': 'Upload the institution\'s logo for display on documents and the header.',
  'btn-save-branding': 'Save the branding settings including name, tagline, and logo.',
  'btn-upload-sig': 'Upload a signature image to be placed on official documents.',
  'sig-registrar': 'Upload the Registrar\'s signature for transcripts and certificates.',
  'sig-dean': 'Upload the Academic Dean\'s signature for official documents.',
  'sig-director': 'Upload the Director/Principal\'s signature for official documents.',
  'user-role': 'Select the role for this user (Admin, Finance, Staff, etc.).',

  // General actions
  'btn-save': 'Save the current changes to the system.',
  'btn-cancel': 'Cancel without saving and close this form.',
  'btn-close': 'Close this window or dialog.',
  'btn-delete': 'Delete this item permanently. This action cannot be undone.',
  'btn-search': 'Search for records matching your query.',
  'btn-refresh': 'Refresh the current view to load the latest data.',
  'btn-export': 'Export the current data to a file (CSV, Excel, or PDF).',
  'btn-print-rec': 'Print the current record or document.',

  // Modals
  'modal-title': 'Title of the current dialog or form.',
  'modal-body': 'Main content area of the current dialog.',
  'modal-actions': 'Action buttons for this dialog, such as Save or Cancel.',
  'smart-search': 'Search across all modules: students, staff, courses, and transactions.',
  'header-date': 'Current date displayed in the header.',
  'user-badge': 'Shows your current role and username. Click the power icon to logout.',
  'notif-bell': 'View support tickets and notifications.',
  'btn-logout': 'Sign out of the system.',

  // Report Card
  'report-card-student': 'Student name and details displayed on the report card.',
  'report-card-grades': 'Table of subjects and corresponding grades.',
  'report-card-summary': 'Summary statistics: total points, average, and ranking.',
  'report-card-comments': 'Teacher and principal comments on student performance.',
};

// ===== STUDENT-SPECIFIC HELP TEXT (overrides for student role) =====
const H_STUDENT = {
  'dashboard': 'View your personal academic summary: courses, grades, attendance, fee balance, and upcoming exams.',
  'portal': 'View your fee statements, grades, attendance records, and personal academic information.',
  'grades': 'View your grades and academic performance across all your enrolled courses.',
  'attendance': 'View your attendance record for classes and sessions.',
  'quizzes': 'Attempt quizzes assigned to you and view your scores.',
  'submissions': 'View your quiz results, scores, and feedback on submissions.',
  'notes': 'Access study notes shared by your instructors for each course.',
  'discussions': 'Participate in class discussions and interact with instructors.',
  'finance': 'View your fee statement, payment history, and outstanding balance.',
  'students': 'View your personal profile and academic information.',
  'courses': 'Browse your enrolled courses and view course materials.',
  'lessons': 'Access lesson content, topics, and resources for your courses.',
  'screen-dashboard': 'Your personal dashboard showing your academic progress, fees, and upcoming exams.',
  'dash-finance': 'Your fee summary: total fees charged, amount paid, and remaining balance.',
};

// ===== GET CURRENT USER ROLE =====
function getRole() {
  try {
    const u = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
    return u.role || 'admin';
  } catch { return 'admin'; }
}
function isStudent() { return getRole() === 'student'; }

// ===== TOUR STEPS (Admin/Staff) =====
const TOUR_STEPS = [
  { target: '#school-name', title: 'Welcome!', text: 'Welcome to the NET Foundation Kenya College Management System. This quick tour will show you the main features to get you started.', side: 'bottom' },
  { target: '#main-nav', title: 'Sidebar Navigation', text: 'The sidebar gives you access to all modules: Dashboard, Students, Finance, Exams, Transcripts, and more. Click any item to jump to that section.', side: 'right' },
  { target: '.nav-tab[data-screen="finance"]', title: 'Finance', text: 'Manage expenses, record income, generate petty cash vouchers, and view the cash book. All financial operations are handled here.', side: 'right' },
  { target: '.nav-tab[data-screen="students"]', title: 'Students', text: 'Register new students, search existing records, update profiles, and track enrollment status across all programs.', side: 'right' },
  { target: '.nav-tab[data-screen="exams"]', title: 'Exams & Grades', text: 'Create examinations, enter grades, and generate report cards with automated grading and performance summaries.', side: 'right' },
  { target: '#btn-help', title: 'Help System', text: 'Click this ? button anytime to enter Help Mode. Then click any button, field, or tab to see a description of what it does.', side: 'bottom' },
  { target: '#smart-search', title: 'Quick Search', text: 'Use the search bar to quickly find students, staff, courses, and transactions across the entire system. Press Ctrl+K to focus.', side: 'bottom' },
  { target: '#user-badge', title: 'Your Account', text: 'Your role and username are shown here. Click the power icon to sign out when done.', side: 'bottom' },
  { target: '#school-name', title: 'You\'re Ready!', text: 'You\'re all set! Explore the system at your own pace. Remember: click the ? button anytime you need help with a feature.', side: 'bottom' }
];

// ===== TOUR STEPS (Student) =====
const TOUR_STEPS_STUDENT = [
  { target: '#school-name', title: 'Welcome!', text: 'Welcome to the NET Foundation Kenya Student Portal. This quick tour will help you navigate your academic experience.', side: 'bottom' },
  { target: '#main-nav', title: 'Your Navigation', text: 'The sidebar shows the sections available to you: Dashboard, Student Hub, Portal, Grades, Attendance, and more.', side: 'right' },
  { target: '.nav-tab[data-screen="student-hub"]', title: 'My Hub', text: 'Your personal hub shows your courses, upcoming exams, quizzes, notes, and discussions all in one place.', side: 'right' },
  { target: '.nav-tab[data-screen="portal"]', title: 'Student Portal', text: 'View your fee statements, academic grades, attendance records, and personal information.', side: 'right' },
  { target: '.nav-tab[data-screen="grades"]', title: 'My Grades', text: 'View your academic performance, grades for each course, and overall progress.', side: 'right' },
  { target: '#btn-help', title: 'Help System', text: 'Click this ? button anytime to enter Help Mode. Then click any button, field, or tab to see a description of what it does.', side: 'bottom' },
  { target: '#smart-search', title: 'Quick Search', text: 'Search for courses, notes, and other information across the portal.', side: 'bottom' },
  { target: '#user-badge', title: 'Your Account', text: 'Your role and name are shown here. Click the power icon to sign out.', side: 'bottom' },
  { target: '#school-name', title: 'You\'re Ready!', text: 'You\'re all set! Explore the student portal at your own pace. Click the ? button anytime you need help.', side: 'bottom' }
];

// ===== GET TOUR STEPS FOR CURRENT ROLE =====
function getTourSteps() { return isStudent() ? TOUR_STEPS_STUDENT : TOUR_STEPS; }

// ===== CREATE TOOLTIP ELEMENT =====
let tooltipEl = null;

// ===== HELP SYSTEM STATE =====
let helpActive = false;
let tourActive = false;
let tourCurrentStep = 0;
let tourOverlay = null;

// ===== INJECT STYLES =====
(function injectStyles() {
  const style = document.createElement('style');
  style.textContent = `
/* Help Tooltip */
.help-tooltip {
  position: fixed; z-index: 99999; background: var(--bg-card,#1e293b); color: var(--text,#f1f5f9);
  border: 1px solid var(--accent,#f59e0b); border-radius: 8px; padding: 10px 14px;
  font-size: 12px; line-height: 1.5; max-width: 320px; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  pointer-events: none; animation: helpFadeIn 0.2s ease;
}
.help-tooltip .help-tt-title { font-weight: 700; font-size: 13px; color: var(--accent,#f59e0b); margin-bottom: 2px; }
.help-tooltip .help-tt-text { color: var(--text-secondary,#94a3b8); }
@keyframes helpFadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

/* Help Mode */
body.help-mode, body.help-mode * { cursor: help !important; }
.help-mode-indicator {
  position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 99998;
  background: var(--accent,#f59e0b); color: #fff; padding: 8px 20px; border-radius: 20px;
  font-size: 13px; font-weight: 600; box-shadow: 0 4px 16px rgba(245,158,11,0.4);
  display: flex; align-items: center; gap: 8px; animation: helpFadeIn 0.3s ease;
}
.help-mode-indicator span { background: rgba(255,255,255,0.2); padding: 0 8px; border-radius: 10px; font-size: 11px; cursor: pointer; }

/* Help Button Active */
#btn-help.active { background: var(--accent,#f59e0b); color: #fff; box-shadow: 0 0 0 3px rgba(245,158,11,0.3); }

/* Tour Overlay */
.tour-overlay {
  position: fixed; inset: 0; z-index: 99995; pointer-events: none;
}
.tour-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 99994;
  animation: helpFadeIn 0.3s ease;
}
.tour-highlight {
  position: fixed; z-index: 99995; border: 3px solid var(--accent,#f59e0b);
  border-radius: 8px; box-shadow: 0 0 0 4px rgba(245,158,11,0.2), 0 0 0 9999px rgba(0,0,0,0.5);
  pointer-events: none; transition: all 0.3s ease;
}
.tour-card {
  position: fixed; z-index: 99996; background: var(--bg-card,#1e293b); color: var(--text,#f1f5f9);
  border: 1px solid var(--accent,#f59e0b); border-radius: 12px; padding: 20px 24px;
  max-width: 400px; box-shadow: 0 12px 48px rgba(0,0,0,0.5); animation: helpFadeIn 0.3s ease;
}
.tour-card .tour-title { font-size: 16px; font-weight: 800; color: var(--accent,#f59e0b); margin-bottom: 8px; }
.tour-card .tour-text { font-size: 13px; line-height: 1.6; color: var(--text-secondary,#94a3b8); margin-bottom: 16px; }
.tour-card .tour-progress { font-size: 11px; color: var(--text-muted,#64748b); margin-bottom: 12px; }
.tour-card .tour-actions { display: flex; gap: 8px; justify-content: flex-end; }
.tour-card .tour-actions button {
  padding: 6px 16px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; border: none; transition: all 0.15s;
}
.tour-card .tour-actions .tour-prev { background: var(--bg-hover,#475569); color: var(--text,#f1f5f9); }
.tour-card .tour-actions .tour-next { background: var(--accent,#f59e0b); color: #fff; }
.tour-card .tour-actions .tour-skip { background: transparent; color: var(--text-muted,#64748b); }
`;
  document.head.appendChild(style);
})();

// ===== TOOLTIP FUNCTIONS =====
function showTooltip(el, title, text) {
  hideTooltip();
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'help-tooltip';
  tooltipEl.innerHTML = (title ? `<div class="help-tt-title">${title}</div>` : '') + `<div class="help-tt-text">${text}</div>`;
  document.body.appendChild(tooltipEl);
  positionTooltip(el, tooltipEl);
}
function showSimpleTooltip(text) {
  hideTooltip();
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'help-tooltip';
  tooltipEl.innerHTML = `<div class="help-tt-text">${text}</div>`;
  document.body.appendChild(tooltipEl);
}
function positionTooltip(target, tip) {
  const tr = target.getBoundingClientRect();
  const tw = tip.offsetWidth || 280;
  const th = tip.offsetHeight || 60;
  let left = tr.left + tr.width / 2 - tw / 2;
  let top = tr.bottom + 8;
  if (left < 4) left = 4;
  if (left + tw > window.innerWidth - 4) left = window.innerWidth - tw - 4;
  if (top + th > window.innerHeight - 4) top = tr.top - th - 8;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}
function hideTooltip() {
  if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
}

// ===== GET HELP MAP FOR CURRENT ROLE =====
function getHelpMap() {
  return isStudent() ? Object.assign({}, H, H_STUDENT) : H;
}

// ===== FIND HELP TEXT =====
function findHelpText(el) {
  if (!el) return null;
  const M = getHelpMap();
  // Check data-help attribute
  if (el.dataset && el.dataset.help) return { text: el.dataset.help, source: 'data-help' };
  // Check ID
  if (el.id && M[el.id]) return { text: M[el.id], title: '', source: 'id' };
  // Check className
  for (const cls of el.classList) {
    if (M[cls]) return { text: M[cls], title: '', source: 'class' };
  }
  // Check onclick attribute for known function names
  const onclick = el.getAttribute && el.getAttribute('onclick');
  if (onclick) {
    const match = onclick.match(/(show|open|edit|delete|print|save|record|generate|toggle|add)(\w+)/i);
    if (match) {
      const key = match[0].toLowerCase();
      for (const [k, v] of Object.entries(M)) {
        if (k.toLowerCase().includes(key) || key.includes(k.toLowerCase())) return { text: v, title: '', source: 'onclick' };
      }
    }
  }
  // Check parent elements (walk up to 3 levels)
  let parent = el.parentElement;
  for (let i = 0; i < 3 && parent; i++) {
    if (parent.id && M[parent.id]) return { text: M[parent.id], title: '', source: 'parent-id' };
    for (const cls of parent.classList) {
      if (M[cls]) return { text: M[cls], title: '', source: 'parent-class' };
    }
    parent = parent.parentElement;
  }
  // Check for label text nearby
  const label = el.closest('.form-group')?.querySelector('label');
  if (label) {
    const labelText = label.textContent.trim().replace(/[✕✍️*]/g, '').trim();
    for (const [k, v] of Object.entries(M)) {
      if (labelText.toLowerCase().includes(k.replace(/-/g, ' ').toLowerCase()) || k.toLowerCase().includes(labelText.toLowerCase())) return { text: v, title: '', source: 'label' };
    }
  }
  return null;
}

// ===== TOGGLE HELP MODE =====
function toggleHelpMode() {
  helpActive = !helpActive;
  const btn = document.getElementById('btn-help');
  if (!btn) return;
  if (helpActive) {
    btn.classList.add('active');
    document.body.classList.add('help-mode');
    // Show indicator bar
    const bar = document.createElement('div');
    bar.id = 'help-mode-bar';
    bar.className = 'help-mode-indicator';
    bar.innerHTML = '❓ Help Mode — Click any element to learn about it <span onclick="window._toggleHelp()">✕ Exit</span>';
    document.body.appendChild(bar);
    showSimpleTooltip('Click any button, field, or tab to see its description.');
    setTimeout(() => { const t = document.querySelector('.help-tooltip'); if (t) t.style.opacity = '0.7'; }, 2000);
  } else {
    btn.classList.remove('active');
    document.body.classList.remove('help-mode');
    const bar = document.getElementById('help-mode-bar');
    if (bar) bar.remove();
    hideTooltip();
  }
}
window._toggleHelp = toggleHelpMode;

// ===== HELP CLICK HANDLER =====
function handleHelpClick(e) {
  if (!helpActive) return;
  // If clicking inside the help-mode bar or the exit span, let the click pass through
  if (e.target.closest('#help-mode-bar') || e.target.closest('#btn-help')) return;
  e.preventDefault();
  e.stopPropagation();
  const el = e.target;
  const found = findHelpText(el);
  if (found) {
    showTooltip(el, found.title, found.text);
    setTimeout(hideTooltip, 5000);
  } else {
    // Try to find any matching help text from parent elements
    let walk = el;
    let text = null;
    const M = getHelpMap();
    while (walk && walk !== document.body) {
      if (walk.textContent) {
        const t = walk.textContent.trim().substring(0, 30);
        for (const [k, v] of Object.entries(M)) {
          if (t.toLowerCase().includes(k.replace(/-/g, ' ').toLowerCase())) { text = v; break; }
        }
        if (text) break;
      }
      walk = walk.parentElement;
    }
    if (text) {
      showTooltip(el, '', text);
      setTimeout(hideTooltip, 5000);
    } else {
      showSimpleTooltip('No description available for this element.');
      setTimeout(hideTooltip, 3000);
    }
  }
}

// ===== TOUR FUNCTIONS =====
function createTourOverlay() {
  tourOverlay = document.createElement('div');
  tourOverlay.id = 'tour-overlay-container';
  tourOverlay.style.cssText = 'position:fixed;inset:0;z-index:99994;';
  document.body.appendChild(tourOverlay);
}

function showTourStep(index) {
  if (!tourActive) return;
  const steps = getTourSteps();
  const step = steps[index];
  if (!step) { endTour(); return; }
  tourCurrentStep = index;

  // Remove old highlights and cards
  document.querySelectorAll('.tour-highlight, .tour-card, .tour-backdrop').forEach(el => el.remove());

  // Add backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'tour-backdrop';
  document.body.appendChild(backdrop);

  // Try to find target element
  const target = document.querySelector(step.target);
  if (target) {
    const rect = target.getBoundingClientRect();
    const hl = document.createElement('div');
    hl.className = 'tour-highlight';
    hl.style.left = (rect.left - 6) + 'px';
    hl.style.top = (rect.top - 6) + 'px';
    hl.style.width = (rect.width + 12) + 'px';
    hl.style.height = (rect.height + 12) + 'px';
    document.body.appendChild(hl);
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // Build card
  const card = document.createElement('div');
  card.className = 'tour-card';
  const total = steps.length;
  card.innerHTML = `
    <div class="tour-progress">Step ${index + 1} of ${total}</div>
    <div class="tour-title">${step.title}</div>
    <div class="tour-text">${step.text}</div>
    <div class="tour-actions">
      ${index > 0 ? '<button class="tour-prev" onclick="window._tourPrev()">← Back</button>' : ''}
      ${index < total - 1 ? '<button class="tour-skip" onclick="window._tourEnd()">Skip Tour</button><button class="tour-next" onclick="window._tourNext()">Next →</button>' : '<button class="tour-next" onclick="window._tourEnd()">Start Using System →</button>'}
    </div>`;
  document.body.appendChild(card);

  // Position card
  setTimeout(() => {
    const cRect = card.getBoundingClientRect();
    card.style.left = Math.max(20, (window.innerWidth - cRect.width) / 2) + 'px';
    card.style.top = Math.max(20, window.innerHeight - cRect.height - 40) + 'px';
  }, 50);
}

window._tourNext = function() { if (tourActive) showTourStep(tourCurrentStep + 1); };
window._tourPrev = function() { if (tourActive) showTourStep(tourCurrentStep - 1); };
window._tourEnd = function() {
  tourActive = false;
  document.querySelectorAll('.tour-highlight, .tour-card, .tour-backdrop').forEach(el => el.remove());
  if (tourOverlay) { tourOverlay.remove(); tourOverlay = null; }
  localStorage.setItem('netkenya_tour_done', '1');
};

function startTour() {
  if (tourActive) return;
  tourActive = true;
  createTourOverlay();
  showTourStep(0);
}

// ===== INITIALIZATION =====
function initHelpSystem() {
  // Help button click toggles help mode
  const helpBtn = document.getElementById('btn-help');
  if (helpBtn) {
    helpBtn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      toggleHelpMode();
    });
  }

  // Document click handler for help mode
  document.addEventListener('click', handleHelpClick, true);

  // Escape exits help mode
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && helpActive) toggleHelpMode();
  });

  // Auto-start tour on first visit (after login)
  const tourDone = localStorage.getItem('netkenya_tour_done');
  if (!tourDone) {
    // Wait for app to become visible (after login)
    const observer = new MutationObserver(function() {
      const app = document.getElementById('app');
      if (app && app.style.display !== 'none') {
        observer.disconnect();
        setTimeout(startTour, 800);
      }
    });
    const app = document.getElementById('app');
    if (app) {
      if (app.style.display !== 'none') {
        setTimeout(startTour, 800);
      } else {
        observer.observe(app, { attributes: true, attributeFilter: ['style'] });
      }
    }
  }

  // Add help text to smart search
  const search = document.getElementById('smart-search');
  if (search) {
    const origPlaceholder = search.placeholder;
    if (!H['smart-search']) H['smart-search'] = 'Search across all modules: students, staff, courses, and transactions. Press Ctrl+K to focus.';
  }
}

// Run on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHelpSystem);
} else {
  initHelpSystem();
}

})();
