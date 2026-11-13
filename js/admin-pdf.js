// ===== PDF-TEMPLATE DIPLOMA SYSTEM =====
async function handleDiplomaPdfUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.type !== 'application/pdf') return showToast('Please upload a PDF file', { type: 'danger' });
    window._diplomaPdfUploading = true;
    const reader = new FileReader();
    reader.onload = async function(e) {
        const arr = new Uint8Array(e.target.result);
        let b64 = '';
        for (let i = 0; i < arr.length; i++) b64 += String.fromCharCode(arr[i]);
        window._diplomaPdfTemplate = btoa(b64);
        window._diplomaPdfUploading = false;
        const preview = document.getElementById('diploma-pdf-preview');
        preview.textContent = 'Template: ' + file.name + ' (' + Math.round(file.size / 1024) + ' KB)';
        preview.style.color = 'var(--success)';
        
        // Render PDF on canvas for visual coordinate picking
        await renderPdfOnCanvas(window._diplomaPdfTemplate);
        
        // Auto-save the config when upload completes successfully
        try { 
            await saveDiplomaPdfConfig(); 
            showToast('Template saved to config!', { type: 'success' }); 
        } catch (e) { 
            showToast('Failed to save template: ' + e.message, { type: 'danger' }); 
        }
    };
    reader.onerror = function() {
        window._diplomaPdfUploading = false;
        showToast('Failed to read PDF file', { type: 'danger' });
    };
    window._diplomaPdfUploading = true;
    reader.readAsArrayBuffer(file);
}
async function handleDiplomaSigUpload(role, event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        if (!window._diplomaSigs) window._diplomaSigs = {};
        window._diplomaSigs[role] = e.target.result;
        const preview = document.getElementById('diploma-sig-' + role + '-preview');
        if (preview) { preview.src = e.target.result; preview.style.display = 'block'; }
    };
reader.readAsDataURL(file);
}

// PDF Canvas rendering and coordinate picking
let _diplomaCanvasScale = 1;

async function renderPdfOnCanvas(base64Pdf) {
    if (typeof PDFLib === 'undefined') {
        console.warn('PDFLib not loaded, skipping canvas render');
        return;
    }
    try {
        const pdfBytes = Uint8Array.from(atob(base64Pdf), c => c.charCodeAt(0));
        window._diplomaPdfDoc = await PDFLib.PDFDocument.load(pdfBytes);
        const page = window._diplomaPdfDoc.getPages()[0];

        // Use the DISPLAYED page size (page /Rotate applied) so the preview is
        // upright and matches the generated certificate exactly.
        const disp = tplDisplayedPage(page);
        const pageWidth = disp.w;
        const pageHeight = disp.h;
        window._diplomaPageMm = { wMm: disp.wMm, hMm: disp.hMm, rotation: disp.rotation };

        const maxWidth = 595;
        const maxHeight = 842;
        const scaleX = maxWidth / pageWidth;
        const scaleY = maxHeight / pageHeight;
        window._diplomaCanvasScale = Math.min(scaleX, scaleY);

        const canvasWidth = Math.round(pageWidth * window._diplomaCanvasScale);
        const canvasHeight = Math.round(pageHeight * window._diplomaCanvasScale);

        const canvas = document.getElementById('diploma-pdf-canvas');
        const preview = document.getElementById('diploma-pdf-preview');
        const crosshair = document.getElementById('diploma-crosshair');

        if (canvas) {
            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
            canvas.style.display = 'block';
            if (crosshair) crosshair.style.display = 'block';
        }
        // Keep preview visible so user sees the green filename
        // if (preview) preview.style.display = 'none';

if (typeof pdfjsLib !== 'undefined') {
            try {
                const pdfData = Uint8Array.from(atob(window._diplomaPdfTemplate), c => c.charCodeAt(0));
                const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
                const page = await pdf.getPage(1);
                const viewport = page.getViewport({ scale: window._diplomaCanvasScale, rotation: (window._diplomaPageMm && window._diplomaPageMm.rotation) || 0 });
                const canvas = document.getElementById('diploma-pdf-canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = viewport.width;
                canvas.height = viewport.height;
                // Fill with light gray background first to ensure PDF is visible
                ctx.fillStyle = '#f0f0f0';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                await page.render({ canvasContext: ctx, viewport: viewport }).promise;
                // pdf.js renders with the effective rotation (a stray 180° flag
                // is ignored), so the preview matches the printed certificate.
                drawTplAxes(canvas);
            } catch (e) {
                console.warn('pdf.js render failed, using placeholder:', e);
                drawPlaceholderCanvas();
            }
        } else {
            drawPlaceholderCanvas();
        }

        // Create field overlay elements after PDF is rendered
        createFieldOverlayElements();

        if (canvas) {
            canvas.onclick = function(e) {
                const rect = canvas.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const clickY = e.clientY - rect.top;
                // The canvas may be displayed smaller than its pixel size
                // (max-width:100%), so convert through the displayed scale -
                // otherwise every click lands in the wrong place.
                const cssScale = rect.width ? (canvas.width / rect.width) : 1;
                const mmToPx = diplomaMmToPx() * cssScale;
                const pdfX = clickX / mmToPx;
                const pdfY = clickY / mmToPx;
                setActiveFieldCoords(pdfX, pdfY);
            };
        }

        if (crosshair) {
            const canvas = document.getElementById('diploma-pdf-canvas');
            if (canvas) {
                crosshair.style.left = '0px';
                crosshair.style.top = '0px';
                crosshair.style.width = canvas.width + 'px';
                crosshair.style.height = canvas.height + 'px';
            }
        }

        // Create field overlay elements after PDF is rendered
        createFieldOverlayElements();

    } catch (e) {
        console.error('renderPdfOnCanvas error:', e);
    }
}

function drawPlaceholderCanvas() {
    const canvas = document.getElementById('diploma-pdf-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
    ctx.font = '14px system-ui';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    ctx.fillText('PDF Preview - Click to set coordinates', canvas.width / 2, canvas.height / 2);
}

// Create field overlay elements on top of the PDF canvas
function createFieldOverlayElements() {
    const overlay = document.getElementById('diploma-field-overlay');
    if (!overlay) return;
    
    // Clear existing overlay elements
    overlay.innerHTML = '';
    
    const fields = [
        { id: 'name', label: 'Student Name', color: '#3b82f6' },
        { id: 'adm', label: 'Adm No', color: '#f59e0b' },
        { id: 'date', label: 'Date', color: '#10b981' },
        { id: 'docid', label: 'Doc ID', color: '#8b5cf6' },
        { id: 'vcode', label: 'Verify Code', color: '#ef4444' },
        { id: 'website', label: 'Website', color: '#0ea5e9' }
    ];
    
    // Get current coordinates from input fields
    const fieldsData = ['name', 'adm', 'date', 'docid', 'vcode', 'website'].reduce((acc, field) => {
        const xEl = document.getElementById('diploma-fx-' + field);
        const yEl = document.getElementById('diploma-fy-' + field);
        const sizeEl = document.getElementById('diploma-fs-' + field);
        if (xEl && yEl) {
            acc[field] = {
                x: parseFloat(xEl.value) || 105,
                y: parseFloat(yEl.value) || 120,
                size: parseInt(sizeEl?.value) || 12
            };
        }
        return acc;
    }, {});
    
    const canvas = document.getElementById('diploma-pdf-canvas');
    if (!canvas) return;

    const scale = window._diplomaCanvasScale || 1;
    const _pageMm = getDiplomaPageSize();

    const fieldsConfig = [
        { id: 'name', label: 'Student Name', color: '#3b82f6' },
        { id: 'adm', label: 'Adm No', color: '#f59e0b' },
        { id: 'date', label: 'Date', color: '#10b981' },
        { id: 'docid', label: 'Doc ID', color: '#8b5cf6' },
        { id: 'vcode', label: 'Verify Code', color: '#ef4444' },
        { id: 'website', label: 'Website', color: '#0ea5e9' }
    ];

    fieldsConfig.forEach(field => {
        const data = (['name', 'adm', 'date', 'docid', 'vcode', 'website'].reduce((acc, field) => {
            const xEl = document.getElementById('diploma-fx-' + field);
            const yEl = document.getElementById('diploma-fy-' + field);
            const sizeEl = document.getElementById('diploma-fs-' + field);
            if (xEl && yEl) {
                acc[field] = {
                    x: parseFloat(xEl.value) || 105,
                    y: parseFloat(yEl.value) || 120,
                    size: parseInt(sizeEl?.value) || 12
                };
            }
            return acc;
        }, {})[field.id]) || { x: 105, y: 120, size: 12 };

        const el = document.createElement('div');
        el.className = 'diploma-field-label';
        el.id = 'diploma-field-overlay-' + field.id;
        el.style.cssText = `
            position: absolute;
            left: ${data.x * diplomaMmToPx()}px;
            top: ${(_pageMm.hMm - data.y) * diplomaMmToPx()}px;
            font-size: ${(data.size || 12) * 0.8}px;
            font-weight: 600;
            color: ${field.color};
            background: rgba(255,255,255,0.9);
            padding: 2px 6px;
            border-radius: 4px;
            border: 1px solid ${field.color};
            pointer-events: auto;
            cursor: move;
            z-index: 30;
            user-select: none;
            white-space: nowrap;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            transition: box-shadow 0.1s, transform 0.1s;
        `;
        el.innerHTML = field.label;
        el.dataset.field = field.id;
        
        // Enable drag; actual move/up handled by global listeners in wireDiplomaOverlay()
        el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            window._dragEl = el;
            window._activeDiplomaField = field.id;
            window._dragOffX = e.clientX - rect.left;
            window._dragOffY = e.clientY - rect.top;
            el.style.zIndex = '100';
            el.style.boxShadow = '0 4px 12px rgba(0,0,0,0.25)';
        });
        
        overlay.appendChild(el);
    });
    
    // Wire global drag listeners + live X/Y input updates once
    wireDiplomaOverlay();
}

function getDiplomaPageSize() {
    try {
        if (window._diplomaPageMm && window._diplomaPageMm.hMm) return { wMm: window._diplomaPageMm.wMm, hMm: window._diplomaPageMm.hMm };
        const pg = window._diplomaPdfDoc && window._diplomaPdfDoc.getPages()[0];
        if (pg) {
            const d = tplDisplayedPage(pg);
            return { w: d.w, h: d.h, wMm: d.wMm, hMm: d.hMm };
        }
    } catch (e) {}
    return { w: 595, h: 842, wMm: 210, hMm: 297 };
}
function diplomaMmToPx() {
    const scale = window._diplomaCanvasScale || 1;
    return 2.83465 * scale;
}

function resolveDiplomaPaperMm(paper) {
    if (!paper || !paper.kind || paper.kind === 'auto') return null;
    if (paper.kind === 'custom') {
        const w = parseFloat(paper.wMm);
        const h = parseFloat(paper.hMm);
        if (!isNaN(w) && !isNaN(h) && w > 0 && h > 0) return { wMm: w, hMm: h };
        return null;
    }
    const sizes = {
        a4_portrait: { wMm: 210, hMm: 297 }, a4_landscape: { wMm: 297, hMm: 210 },
        a3_portrait: { wMm: 297, hMm: 420 }, a3_landscape: { wMm: 420, hMm: 297 },
        a5_portrait: { wMm: 148, hMm: 210 }, a5_landscape: { wMm: 210, hMm: 148 },
        letter_portrait: { wMm: 215.9, hMm: 279.4 }, letter_landscape: { wMm: 279.4, hMm: 215.9 }
    };
    return sizes[paper.kind] || null;
}

function onDiplomaPaperSizeChange() {
    const kind = document.getElementById('diploma-paper-size').value;
    const cust = document.getElementById('diploma-custom-paper');
    if (cust) cust.style.display = kind === 'custom' ? 'flex' : 'none';
}

// ===== PDF template coordinate system =====================================
// X is measured in millimetres from the LEFT edge of the template and Y from
// the BOTTOM edge, so the X/Y axes meet at the bottom-left corner - the same
// convention PDF itself uses. Configs saved before this change measured Y
// from the top and carry no 'origin' flag; they are converted on load, so
// nothing on the page moves when the convention changes.
const TPL_ORIGIN_BOTTOM = 'bottom-left';
function tplHasBottomOrigin(config) { return !!(config && config.origin === TPL_ORIGIN_BOTTOM); }
// A stored Y -> millimetres from the bottom edge of the page.
function tplYBottom(config, y, pageHmm) {
    const n = Number(y);
    if (!isFinite(n)) return 0;
    if (tplHasBottomOrigin(config)) return n;
    return (Number(pageHmm) || 0) - n;   // legacy: stored from the top
}
// The page size as it is DISPLAYED. pdf.js applies the page /Rotate while
// pdf-lib reports the raw media box; mixing the two is what makes a template
// come out upside down, so everything here works from the displayed size.
function tplDisplayedPage(page) {
    let rot = 0;
    try { rot = (page.getRotation && page.getRotation().angle) || 0; } catch (e) { rot = 0; }
    rot = ((rot % 360) + 360) % 360;
    // A certificate template flagged 180° is almost always an upright design
    // with a stray "rotate me" marker (some design/scan tools add one). Honouring
    // that flag is exactly what makes the template - and the printed result -
    // come out upside down, so a 180° flag is treated as upright.
    const effective = rot === 180 ? 0 : rot;
    let w = page.getWidth(), h = page.getHeight();
    if (effective === 90 || effective === 270) { const t = w; w = h; h = t; }
    return { w: w, h: h, wMm: w / 2.83465, hMm: h / 2.83465, rotation: effective, rawRotation: rot };
}
// The displayed page size of a template, in millimetres.
async function tplPageMmOf(base64Pdf) {
    try {
        if (!base64Pdf || typeof PDFLib === 'undefined') return null;
        const bytes = Uint8Array.from(atob(base64Pdf), c => c.charCodeAt(0));
        const doc = await PDFLib.PDFDocument.load(bytes);
        const d = tplDisplayedPage(doc.getPages()[0]);
        return { wMm: d.wMm, hMm: d.hMm, rotation: d.rotation };
    } catch (e) { return null; }
}
// Prepare the template page for printing. The page is always upright, and the
// coordinate map keeps every field where the administrator placed it even when
// the chosen paper size differs from the template (the template is then scaled
// and centred on the sheet).
async function tplPreparePage(pdfDoc, page, templateBytes, paperMm) {
    const mmToPt = 2.83465;
    const disp = tplDisplayedPage(page);
    let tgtW = disp.w, tgtH = disp.h;
    if (paperMm) { tgtW = paperMm.wMm * mmToPt; tgtH = paperMm.hMm * mmToPt; }
    const needsRebuild = disp.rotation !== 0 || disp.rawRotation !== 0
        || (paperMm && (Math.abs(page.getWidth() - tgtW) > 1 || Math.abs(page.getHeight() - tgtH) > 1));
    if (!needsRebuild) {
        return { page: page, wMm: disp.wMm, hMm: disp.hMm, tplHmm: disp.hMm, sx: 1, sy: 1, offXmm: 0, offYmm: 0 };
    }
    const newPage = await embedTemplateOnPaperPage(pdfDoc, page, tgtW, tgtH, templateBytes);
    const ratio = Math.min(tgtW / disp.w, tgtH / disp.h);
    const imgWmm = disp.wMm * ratio, imgHmm = disp.hMm * ratio;
    const pageWmm = tgtW / mmToPt, pageHmm = tgtH / mmToPt;
    return {
        page: newPage,
        wMm: pageWmm, hMm: pageHmm, tplHmm: disp.hMm,
        sx: imgWmm / disp.wMm, sy: imgHmm / disp.hMm,
        offXmm: (pageWmm - imgWmm) / 2, offYmm: (pageHmm - imgHmm) / 2
    };
}
// Where a stored field position ends up on the finished page (mm).
function tplMapX(map, xTemplateMm) { return map.offXmm + (Number(xTemplateMm) || 0) * map.sx; }
function tplMapY(map, yTemplateBottomMm) { return map.offYmm + (Number(yTemplateBottomMm) || 0) * map.sy; }

// Draw the X/Y axes on the preview canvas. They meet at the BOTTOM-LEFT
// corner, which is the origin of the coordinate system (X right, Y up).
function drawTplAxes(canvas) {
    if (!canvas) return;
    try {
        const ctx = canvas.getContext('2d');
        const w = canvas.width, h = canvas.height;
        ctx.save();
        ctx.strokeStyle = 'rgba(37,99,235,.9)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([7, 5]);
        ctx.beginPath(); ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0.5, 0); ctx.lineTo(0.5, h); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(37,99,235,.95)';
        ctx.beginPath(); ctx.arc(0, h, 5, 0, Math.PI * 2); ctx.fill();
        ctx.font = 'bold 11px monospace';
        ctx.fillText('0,0', 7, h - 7);
        ctx.fillText('X', w - 14, h - 7);
        ctx.fillText('Y', 7, 14);
        ctx.restore();
    } catch (e) {}
}

async function embedTemplateOnPaperPage(pdfDoc, srcPage, tgtW, tgtH, templateB64) {
    if (typeof pdfjsLib === 'undefined') {
        srcPage.setSize(tgtW, tgtH);
        return srcPage;
    }
    // Displayed (rotation-aware) size of the source page.
    const disp = tplDisplayedPage(srcPage);
    const srcW = disp.w, srcH = disp.h;
    const ratio = Math.min(tgtW / srcW, tgtH / srcH);
    const renderScale = ratio * 2;
    const src = (templateB64 instanceof Uint8Array) ? templateB64 : Uint8Array.from(atob(templateB64), c => c.charCodeAt(0));
    // pdf.js may detach the buffer it is given, so hand it a copy.
    const pdfData = src.slice ? src.slice() : src;
    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: renderScale, rotation: disp.rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    const newPage = pdfDoc.addPage([tgtW, tgtH]);
    const img = await pdfDoc.embedPng(canvas.toDataURL('image/png'));
    const imgW = srcW * ratio;
    const imgH = srcH * ratio;
    newPage.drawImage(img, { x: (tgtW - imgW) / 2, y: (tgtH - imgH) / 2, width: imgW, height: imgH });
    // Keep only the new page: the template is one page.
    const keep = pdfDoc.getPageCount() - 1;
    for (let i = pdfDoc.getPageCount() - 1; i >= 0; i--) { if (i !== keep) pdfDoc.removePage(i); }
    return newPage;
}

function positionOverlayLabels() {
    const mmToPx = diplomaMmToPx();
    const ps = getDiplomaPageSize();
    ['name', 'adm', 'date', 'docid', 'vcode', 'website'].forEach(field => {
        const el = document.getElementById('diploma-field-overlay-' + field);
        if (!el) return;
        const xEl = document.getElementById('diploma-fx-' + field);
        const yEl = document.getElementById('diploma-fy-' + field);
        const xs = parseFloat(xEl && xEl.value) || 105;
        // Y is stored from the BOTTOM edge, so it is flipped for the canvas.
        const ys = parseFloat(yEl && yEl.value) || 120;
        el.style.left = (xs * mmToPx) + 'px';
        el.style.top = ((ps.hMm - ys) * mmToPx) + 'px';
    });
}

function wireDiplomaOverlay() {
    if (window._diplomaOverlayWired) return;
    window._diplomaOverlayWired = true;
    const reposition = () => positionOverlayLabels();
    ['name', 'adm', 'date', 'docid', 'vcode', 'website'].forEach(field => {
        ['x', 'y'].forEach(ax => {
            const inp = document.getElementById('diploma-f' + ax + '-' + field);
            if (inp) {
                inp.addEventListener('input', reposition);
                inp.addEventListener('focus', () => { window._activeDiplomaField = field; });
            }
            const sld = document.getElementById('diploma-f' + ax + '-' + field + '-slider');
            if (sld) sld.addEventListener('input', reposition);
        });
    });
    document.addEventListener('mousemove', (e) => {
        const el = window._dragEl;
        if (!el) return;
        const canvas = document.getElementById('diploma-pdf-canvas');
        if (!canvas) return;
        const canvasRect = canvas.getBoundingClientRect();
        const newX = e.clientX - canvasRect.left - (window._dragOffX || 0);
        const newY = e.clientY - canvasRect.top - (window._dragOffY || 0);
        const maxX = canvasRect.width - el.offsetWidth;
        const maxY = canvasRect.height - el.offsetHeight;
        const cx = Math.max(0, Math.min(newX, maxX));
        const cy = Math.max(0, Math.min(newY, maxY));
        el.style.left = cx + 'px';
        el.style.top = cy + 'px';
    });
    document.addEventListener('mouseup', () => {
        const el = window._dragEl;
        if (!el) return;
        window._dragEl = null;
        el.style.zIndex = '30';
        el.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
        const canvas = document.getElementById('diploma-pdf-canvas');
        if (!canvas) return;
        const canvasRect = canvas.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        // The canvas may be displayed smaller than its pixel size, so convert
        // through the displayed scale or the drop lands in the wrong place.
        const cssScale = canvasRect.width ? (canvas.width / canvasRect.width) : 1;
        const mmToPx = diplomaMmToPx() * cssScale;
        const pdfX = (elRect.left - canvasRect.left) / mmToPx;
        const pdfY = (elRect.top - canvasRect.top) / mmToPx;
        const fieldId = el.dataset.field;
        window._activeDiplomaField = fieldId;
        const xEl = document.getElementById('diploma-fx-' + fieldId);
        const yEl = document.getElementById('diploma-fy-' + fieldId);
        if (xEl && yEl) {
            const ps = getDiplomaPageSize();
            xEl.value = Math.round(Math.max(0, Math.min(ps.wMm, pdfX)));
            // Y is stored from the BOTTOM edge of the template.
            yEl.value = Math.round(Math.max(0, Math.min(ps.hMm, ps.hMm - pdfY)));
            const sld = document.getElementById('diploma-fx-' + fieldId + '-slider');
            const sldY = document.getElementById('diploma-fy-' + fieldId + '-slider');
            if (sld) sld.value = xEl.value;
            if (sldY) sldY.value = yEl.value;
            positionOverlayLabels();
            showToast('Updated ' + fieldId + ' position', { type: 'success' });
        }
    });
}
function setActiveFieldCoords(pdfX, pdfY) {
    const activeField = window._activeDiplomaField || 'name';
    const xEl = document.getElementById('diploma-fx-' + activeField);
    const yEl = document.getElementById('diploma-fy-' + activeField);
    if (xEl && yEl) {
        const ps = getDiplomaPageSize();
        xEl.value = Math.round(Math.max(0, Math.min(ps.wMm, pdfX)));
        // Y is stored from the BOTTOM edge of the template.
        yEl.value = Math.round(Math.max(0, Math.min(ps.hMm, ps.hMm - pdfY)));
        const sld = document.getElementById('diploma-fx-' + activeField + '-slider');
        const sldY = document.getElementById('diploma-fy-' + activeField + '-slider');
        if (sld) sld.value = xEl.value;
        if (sldY) sldY.value = yEl.value;
        positionOverlayLabels();
        showToast('Moved ' + activeField + ' to X=' + xEl.value + ', Y=' + yEl.value + ' (from the bottom)', { type: 'success' });
    }
}

function clearDiplomaPdfPreview() {
    window._diplomaPdfTemplate = null;
    window._diplomaPdfDoc = null;
    const preview = document.getElementById('diploma-pdf-preview');
    const canvas = document.getElementById('diploma-pdf-canvas');
    const crosshair = document.getElementById('diploma-crosshair');
    const fileInput = document.getElementById('diploma-pdf-upload');
    const overlay = document.getElementById('diploma-field-overlay');
    if (preview) { preview.textContent = 'No template uploaded'; preview.style.display = 'block'; preview.style.color = 'var(--text-muted)'; }
    if (canvas) canvas.style.display = 'none';
    if (crosshair) crosshair.style.display = 'none';
    if (fileInput) fileInput.value = '';
    if (overlay) overlay.innerHTML = '';
}

function applyPresetCoords(preset) {
    // Presets are written from the TOP of the page (the old convention) and
    // converted to the bottom-left origin at apply time, so they stay correct
    // whatever the height of the uploaded template.
    const presets = {
        portrait: {
            name: { x: 105, y: 120, size: 24 },
            adm: { x: 105, y: 140, size: 14 },
            date: { x: 105, y: 200, size: 14 },
            docid: { x: 70, y: 280, size: 10 },
            vcode: { x: 140, y: 280, size: 10 },
            website: { x: 10, y: 12, size: 9 }
        },
        landscape: {
            name: { x: 148, y: 105, size: 24 },
            adm: { x: 148, y: 125, size: 14 },
            date: { x: 148, y: 185, size: 14 },
            docid: { x: 100, y: 250, size: 10 },
            vcode: { x: 196, y: 250, size: 10 },
            website: { x: 10, y: 12, size: 9 }
        }
    };
    const coords = presets[preset];
    if (!coords) return;
    const hMm = getDiplomaPageSize().hMm;
    for (const [field, c] of Object.entries(coords)) {
        const xEl = document.getElementById('diploma-fx-' + field);
        const yEl = document.getElementById('diploma-fy-' + field);
        const sizeEl = document.getElementById('diploma-fs-' + field);
        if (xEl) xEl.value = c.x;
        if (yEl) yEl.value = Math.max(0, Math.round(hMm - c.y));
        if (sizeEl) sizeEl.value = c.size;
    }
    positionOverlayLabels();
    showToast('Applied ' + preset + ' preset coordinates', { type: 'success' });
}

async function detectDiplomaFieldsWithAI() {
    const btn = document.querySelector('button[onclick="detectDiplomaFieldsWithAI()"]');
    if (btn) { btn.disabled = true; btn.textContent = '🔍 Detecting...'; }

    try {
        // Use a freshly selected file first, else the already-uploaded/saved template
        let base64 = '';
        const fileInput = document.getElementById('diploma-pdf-upload');
        if (fileInput.files && fileInput.files[0]) {
            const file = fileInput.files[0];
            if (file.type !== 'application/pdf') return showToast('Please upload a PDF file', { type: 'danger' });
            base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => resolve(uint8ArrayToBase64(new Uint8Array(e.target.result)));
                reader.onerror = reject;
                reader.readAsArrayBuffer(file);
            });
        } else if (window._diplomaPdfTemplate) {
            base64 = window._diplomaPdfTemplate;
        } else {
            const rec = await dbGet('settings', 'diplomaPdfConfig');
            const config = (rec && rec.value) ? rec.value : rec;
            if (config && config.template) base64 = config.template;
        }
        if (!base64) {
            return showToast('No PDF template available. Please upload and save a PDF first.', { type: 'danger' });
        }

        showToast('Extracting text from PDF...', { type: 'info' });
        const res = await fetch('/api/ai/detect-fields', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ pdfBase64: base64 })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'AI detection failed');

        if (data.fields && Object.keys(data.fields).length) {
            let applied = 0;
            // Detection returns Y from the TOP of the page; the editor works
            // from the BOTTOM edge, so convert it here.
            const pageMm = getDiplomaPageSize();
            for (const [field, coords] of Object.entries(data.fields)) {
                const xEl = document.getElementById('diploma-fx-' + field);
                const yEl = document.getElementById('diploma-fy-' + field);
                const sizeEl = document.getElementById('diploma-fs-' + field);
                if (xEl && Number.isFinite(coords.x)) { xEl.value = Math.round(coords.x); applied++; }
                if (yEl && Number.isFinite(coords.y)) yEl.value = Math.round(pageMm.hMm - coords.y);
                if (sizeEl && coords.size) sizeEl.value = coords.size;
            }
            // Show detection method and confidence in toast
            const method = data.method || 'unknown';
            const confidence = data.confidence || 'low';
            const methodLabel = method === 'pdfjs' ? 'PDF text layer' : (method === 'azure' ? 'Azure OCR' : (method === 'pdfjs+azure' ? 'PDF text + Azure OCR' : method));
            const confidenceLabel = confidence === 'high' ? 'High confidence' : (confidence === 'medium' ? 'Medium confidence' : 'Low confidence');
            showToast(`${confidenceLabel}: ${applied} fields detected via ${methodLabel}. Positions filled.`, { type: 'success' });

            // Auto-save the newly detected positions so the editor matches the saved
            // template without requiring a manual extra "Save Template" click.
            try {
                if (applied > 0) {
                    if (!window._diplomaPdfTemplate) window._diplomaPdfTemplate = base64;
                    await saveDiplomaPdfConfig();
                }
            } catch (autoSaveErr) {
                console.warn('Auto-save after AI detection failed:', autoSaveErr);
            }
        } else {
            showToast('No text found in PDF. Labels may be in raster images. Set positions manually.', { type: 'warning' });
        }
    } catch (e) {
        showToast('AI detection error: ' + e.message, { type: 'danger' });
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔍 Detect Fields with AI'; }
    }
}

async function saveDiplomaPdfConfig() {
    if (window._diplomaPdfUploading) {
        showToast('Waiting for PDF upload to finish...', { type: 'info' });
        let waited = 0;
        while (window._diplomaPdfUploading && waited < 10000) {
            await new Promise(r => setTimeout(r, 200));
            waited += 200;
        }
        if (window._diplomaPdfUploading) return showToast('Upload timed out, please try again', { type: 'danger' });
    }
    
    if (!window._diplomaPdfTemplate) {
        showToast('No PDF template uploaded. Please upload a PDF first.', { type: 'danger' });
        return;
    }

    const btn = document.getElementById('btn-save-diploma-config');
    const statusEl = document.getElementById('diploma-save-status');
    if (btn) { btn.disabled = true; btn.querySelector('.btn-text').textContent = 'Saving...'; btn.querySelector('.btn-loading').style.display = 'inline'; }
    if (statusEl) { statusEl.textContent = 'Saving...'; statusEl.style.color = 'var(--accent)'; }

    const config = {
        template: window._diplomaPdfTemplate || null,
        // X from the left edge, Y from the bottom edge (the X/Y axes meet at
        // the bottom-left corner of the template).
        origin: TPL_ORIGIN_BOTTOM,
        fields: {
            name: { x: +document.getElementById('diploma-fx-name').value, y: +document.getElementById('diploma-fy-name').value, size: +document.getElementById('diploma-fs-name').value },
            adm: { x: +document.getElementById('diploma-fx-adm').value, y: +document.getElementById('diploma-fy-adm').value, size: +document.getElementById('diploma-fs-adm').value },
            date: { x: +document.getElementById('diploma-fx-date').value, y: +document.getElementById('diploma-fy-date').value, size: +document.getElementById('diploma-fs-date').value },
            docid: { x: +document.getElementById('diploma-fx-docid').value, y: +document.getElementById('diploma-fy-docid').value, size: +document.getElementById('diploma-fs-docid').value },
            vcode: { x: +document.getElementById('diploma-fx-vcode').value, y: +document.getElementById('diploma-fy-vcode').value, size: +document.getElementById('diploma-fs-vcode').value },
            website: { x: +(document.getElementById('diploma-fx-website')?.value || 10), y: +(document.getElementById('diploma-fy-website')?.value || 12), size: +(document.getElementById('diploma-fs-website')?.value || 9) }
        },
        font: document.getElementById('diploma-font').value,
        color: document.getElementById('diploma-text-color').value,
        showWebsite: document.getElementById('diploma-show-website') ? document.getElementById('diploma-show-website').checked : true,
        paper: (() => {
            const kind = document.getElementById('diploma-paper-size').value;
            if (kind === 'custom') return { kind: 'custom', wMm: +document.getElementById('diploma-paper-w').value, hMm: +document.getElementById('diploma-paper-h').value };
            return { kind: kind || 'auto' };
        })(),
        sigs: {
            registrar: { img: (window._diplomaSigs || {}).registrar || null, x: +document.getElementById('diploma-sig-registrar-x').value, y: +document.getElementById('diploma-sig-registrar-y').value, w: +document.getElementById('diploma-sig-registrar-w').value },
            dean: { img: (window._diplomaSigs || {}).dean || null, x: +document.getElementById('diploma-sig-dean-x').value, y: +document.getElementById('diploma-sig-dean-y').value, w: +document.getElementById('diploma-sig-dean-w').value },
            director: { img: (window._diplomaSigs || {}).director || null, x: +document.getElementById('diploma-sig-director-x').value, y: +document.getElementById('diploma-sig-director-y').value, w: +document.getElementById('diploma-sig-director-w').value }
        }
    };
    try {
        await dbSet('settings', 'diplomaPdfConfig', config);
        try { localStorage.setItem('nkcms_diplomaPdfConfig_backup', JSON.stringify(config)); } catch (e) {}
        try { tplCacheClear('diplomaPdfConfig'); } catch {}
        showToast('Diploma PDF configuration saved!', { type: 'success' });
        if (statusEl) { statusEl.textContent = '✓ Saved successfully'; statusEl.style.color = 'var(--success)'; }
    } catch (e) {
        const hint = /403/.test(e.message || '') ? ' Session expired — log out and log back in, then retry.' : '';
        showToast('Failed to save: ' + e.message + hint, { type: 'danger' });
        if (statusEl) { statusEl.textContent = '✗ Save failed'; statusEl.style.color = 'var(--danger)'; }
    } finally {
        const btn = document.getElementById('btn-save-diploma-config');
        if (btn) { btn.disabled = false; btn.querySelector('.btn-text').textContent = 'Save Template'; btn.querySelector('.btn-loading').style.display = 'none'; }
    }
}

// ============ Completion Certificate PDF Template ============
async function handleCompletionPdfUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.type !== 'application/pdf') return showToast('Please upload a PDF file', { type: 'danger' });
    window._completionPdfUploading = true;
    const reader = new FileReader();
    reader.onload = async function(e) {
        const arr = new Uint8Array(e.target.result);
        let b64 = '';
        for (let i = 0; i < arr.length; i++) b64 += String.fromCharCode(arr[i]);
        window._completionPdfTemplate = btoa(b64);
        window._completionPdfUploading = false;
        const preview = document.getElementById('completion-pdf-preview');
        if (preview) { preview.textContent = 'Template: ' + file.name + ' (' + Math.round(file.size / 1024) + ' KB)'; preview.style.color = 'var(--success)'; }
        const preview2 = document.getElementById('completion-pdf-preview2');
        if (preview2) { preview2.textContent = 'Template: ' + file.name + ' (' + Math.round(file.size / 1024) + ' KB)'; preview2.style.color = 'var(--success)'; }
        await renderCompletionPdfOnCanvas(window._completionPdfTemplate);
        try {
            await saveCompletionPdfConfig();
            showToast('Template saved to config!', { type: 'success' });
        } catch (err) {
            showToast('Failed to save template: ' + err.message, { type: 'danger' });
        }
    };
    reader.onerror = function() {
        window._completionPdfUploading = false;
        showToast('Failed to read PDF file', { type: 'danger' });
    };
    reader.readAsArrayBuffer(file);
}
function handleCompletionSigUpload(role, event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        if (!window._completionSigs) window._completionSigs = {};
        window._completionSigs[role] = e.target.result;
        const preview = document.getElementById('completion-sig-' + role + '-preview');
        if (preview) { preview.src = e.target.result; preview.style.display = 'block'; }
    };
    reader.readAsDataURL(file);
}
let _completionCanvasScale = 1;
function completionMmToPx() {
    const scale = window._completionCanvasScale || 1;
    return 2.83465 * scale;
}
function getCompletionPageSize() {
    try {
        if (window._completionPageMm && window._completionPageMm.hMm) return { wMm: window._completionPageMm.wMm, hMm: window._completionPageMm.hMm };
        const pg = window._completionPdfDoc && window._completionPdfDoc.getPages()[0];
        if (pg) {
            const d = tplDisplayedPage(pg);
            return { w: d.w, h: d.h, wMm: d.wMm, hMm: d.hMm };
        }
    } catch (e) {}
    return { w: 595, h: 842, wMm: 210, hMm: 297 };
}
function drawCompletionPlaceholderCanvas() {
    const canvas = document.getElementById('completion-pdf-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
    ctx.font = '14px system-ui';
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'center';
    ctx.fillText('PDF Preview - Click to set coordinates', canvas.width / 2, canvas.height / 2);
}
async function renderCompletionPdfOnCanvas(base64Pdf) {
    if (typeof PDFLib === 'undefined') {
        console.warn('PDFLib not loaded, skipping canvas render');
        return;
    }
    try {
        const pdfBytes = Uint8Array.from(atob(base64Pdf), c => c.charCodeAt(0));
        window._completionPdfDoc = await PDFLib.PDFDocument.load(pdfBytes);
        const page = window._completionPdfDoc.getPages()[0];
        // Displayed (rotation-aware) page size, so the preview is upright.
        const disp = tplDisplayedPage(page);
        const pageWidth = disp.w;
        const pageHeight = disp.h;
        window._completionPageMm = { wMm: disp.wMm, hMm: disp.hMm, rotation: disp.rotation };
        const maxWidth = 595;
        const maxHeight = 842;
        window._completionCanvasScale = Math.min(maxWidth / pageWidth, maxHeight / pageHeight);
        const canvas = document.getElementById('completion-pdf-canvas');
        const crosshair = document.getElementById('completion-crosshair');
        if (canvas) {
            canvas.width = Math.round(pageWidth * window._completionCanvasScale);
            canvas.height = Math.round(pageHeight * window._completionCanvasScale);
            canvas.style.display = 'block';
            if (crosshair) crosshair.style.display = 'block';
        }
        if (typeof pdfjsLib !== 'undefined') {
            try {
                const pdfData = Uint8Array.from(atob(window._completionPdfTemplate), c => c.charCodeAt(0));
                const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
                const rpage = await pdf.getPage(1);
                const viewport = rpage.getViewport({ scale: window._completionCanvasScale, rotation: (window._completionPageMm && window._completionPageMm.rotation) || 0 });
                const cnv = document.getElementById('completion-pdf-canvas');
                const ctx = cnv.getContext('2d');
                cnv.width = viewport.width;
                cnv.height = viewport.height;
                ctx.fillStyle = '#f0f0f0';
                ctx.fillRect(0, 0, cnv.width, cnv.height);
                await rpage.render({ canvasContext: ctx, viewport: viewport }).promise;
                // The X/Y axes meet at the bottom-left corner of the template.
                drawTplAxes(cnv);
            } catch (e) {
                console.warn('pdf.js render failed, using placeholder:', e);
                drawCompletionPlaceholderCanvas();
            }
        } else {
            drawCompletionPlaceholderCanvas();
        }
        if (crosshair) {
            const cnv = document.getElementById('completion-pdf-canvas');
            if (cnv) {
                crosshair.style.left = '0px';
                crosshair.style.top = '0px';
                crosshair.style.width = cnv.width + 'px';
                crosshair.style.height = cnv.height + 'px';
            }
        }
        if (canvas) {
            canvas.onclick = function(e) {
                const rect = canvas.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const clickY = e.clientY - rect.top;
                // The canvas may be shown smaller than its pixel size, so the
                // click has to be converted through the displayed scale.
                const cssScale = rect.width ? (canvas.width / rect.width) : 1;
                const mmToPx = completionMmToPx() * cssScale;
                const pdfX = clickX / mmToPx;
                const pdfY = clickY / mmToPx;
                setActiveCompletionFieldCoords(pdfX, pdfY);
            };
        }
        createCompletionFieldOverlayElements();
    } catch (e) {
        console.error('renderCompletionPdfOnCanvas error:', e);
    }
}
function createCompletionFieldOverlayElements() {
    const overlay = document.getElementById('completion-field-overlay');
    if (!overlay) return;
    overlay.innerHTML = '';
    const fieldsConfig = [
        { id: 'name', label: 'Student Name', color: '#3b82f6' },
        { id: 'adm', label: 'Adm No', color: '#f59e0b' },
        { id: 'date', label: 'Date', color: '#10b981' },
        { id: 'docid', label: 'Doc ID', color: '#8b5cf6' },
        { id: 'vcode', label: 'Verify Code', color: '#ef4444' }
    ];
    const canvas = document.getElementById('completion-pdf-canvas');
    if (!canvas) return;
    const _pageMm = getCompletionPageSize();
    const getField = (field) => {
        const xEl = document.getElementById('completion-fx-' + field);
        const yEl = document.getElementById('completion-fy-' + field);
        const sizeEl = document.getElementById('completion-fs-' + field);
        return { x: parseFloat(xEl && xEl.value) || 105, y: parseFloat(yEl && yEl.value) || 120, size: parseInt((sizeEl && sizeEl.value)) || 12 };
    };
    fieldsConfig.forEach(field => {
        const data = getField(field.id);
        const el = document.createElement('div');
        el.id = 'completion-field-overlay-' + field.id;
        el.style.cssText = `
            position: absolute;
            left: ${data.x * completionMmToPx()}px;
            top: ${(_pageMm.hMm - data.y) * completionMmToPx()}px;
            font-size: ${(data.size || 12) * 0.8}px;
            font-weight: 600;
            color: ${field.color};
            background: rgba(255,255,255,0.9);
            padding: 2px 6px;
            border-radius: 4px;
            border: 1px solid ${field.color};
            pointer-events: auto;
            cursor: move;
            z-index: 30;
            user-select: none;
            white-space: nowrap;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        `;
        el.innerHTML = field.label;
        el.dataset.field = field.id;
        el.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            window._completionDragEl = el;
            window._activeCompletionField = field.id;
            window._completionDragOffX = e.clientX - rect.left;
            window._completionDragOffY = e.clientY - rect.top;
            el.style.zIndex = '100';
            el.style.boxShadow = '0 4px 12px rgba(0,0,0,0.25)';
        });
        overlay.appendChild(el);
    });
    wireCompletionOverlay();
}
function positionCompletionOverlayLabels() {
    const mmToPx = completionMmToPx();
    const ps = getCompletionPageSize();
    ['name', 'adm', 'date', 'docid', 'vcode'].forEach(field => {
        const el = document.getElementById('completion-field-overlay-' + field);
        if (!el) return;
        const xEl = document.getElementById('completion-fx-' + field);
        const yEl = document.getElementById('completion-fy-' + field);
        const xs = parseFloat(xEl && xEl.value) || 105;
        // Y is stored from the BOTTOM edge, so it is flipped for the canvas.
        const ys = parseFloat(yEl && yEl.value) || 120;
        el.style.left = (xs * mmToPx) + 'px';
        el.style.top = ((ps.hMm - ys) * mmToPx) + 'px';
    });
}
function wireCompletionOverlay() {
    if (window._completionOverlayWired) return;
    window._completionOverlayWired = true;
    const reposition = () => positionCompletionOverlayLabels();
    ['name', 'adm', 'date', 'docid', 'vcode'].forEach(field => {
        ['x', 'y'].forEach(ax => {
            const inp = document.getElementById('completion-f' + ax + '-' + field);
            if (inp) {
                inp.addEventListener('input', reposition);
                inp.addEventListener('focus', () => { window._activeCompletionField = field; });
            }
            const sld = document.getElementById('completion-f' + ax + '-' + field + '-slider');
            if (sld) sld.addEventListener('input', reposition);
        });
    });
    document.addEventListener('mousemove', (e) => {
        const el = window._completionDragEl;
        if (!el) return;
        const canvas = document.getElementById('completion-pdf-canvas');
        if (!canvas) return;
        const canvasRect = canvas.getBoundingClientRect();
        const newX = e.clientX - canvasRect.left - (window._completionDragOffX || 0);
        const newY = e.clientY - canvasRect.top - (window._completionDragOffY || 0);
        const cx = Math.max(0, Math.min(newX, canvasRect.width - el.offsetWidth));
        const cy = Math.max(0, Math.min(newY, canvasRect.height - el.offsetHeight));
        el.style.left = cx + 'px';
        el.style.top = cy + 'px';
    });
    document.addEventListener('mouseup', () => {
        const el = window._completionDragEl;
        if (!el) return;
        window._completionDragEl = null;
        el.style.zIndex = '30';
        el.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
        const canvas = document.getElementById('completion-pdf-canvas');
        if (!canvas) return;
        const canvasRect = canvas.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const cssScale = canvasRect.width ? (canvas.width / canvasRect.width) : 1;
        const mmToPx = completionMmToPx() * cssScale;
        const pdfX = (elRect.left - canvasRect.left) / mmToPx;
        const pdfY = (elRect.top - canvasRect.top) / mmToPx;
        const fieldId = el.dataset.field;
        window._activeCompletionField = fieldId;
        const xEl = document.getElementById('completion-fx-' + fieldId);
        const yEl = document.getElementById('completion-fy-' + fieldId);
        if (xEl && yEl) {
            const ps = getCompletionPageSize();
            xEl.value = Math.round(Math.max(0, Math.min(ps.wMm, pdfX)));
            // Y is stored from the BOTTOM edge of the template.
            yEl.value = Math.round(Math.max(0, Math.min(ps.hMm, ps.hMm - pdfY)));
            const sld = document.getElementById('completion-fx-' + fieldId + '-slider');
            const sldY = document.getElementById('completion-fy-' + fieldId + '-slider');
            if (sld) sld.value = xEl.value;
            if (sldY) sldY.value = yEl.value;
            positionCompletionOverlayLabels();
            showToast('Updated ' + fieldId + ' position', { type: 'success' });
        }
    });
}
function setActiveCompletionFieldCoords(pdfX, pdfY) {
    const activeField = window._activeCompletionField || 'name';
    const xEl = document.getElementById('completion-fx-' + activeField);
    const yEl = document.getElementById('completion-fy-' + activeField);
    if (xEl && yEl) {
        const ps = getCompletionPageSize();
        xEl.value = Math.round(Math.max(0, Math.min(ps.wMm, pdfX)));
        // Y is stored from the BOTTOM edge of the template.
        yEl.value = Math.round(Math.max(0, Math.min(ps.hMm, ps.hMm - pdfY)));
        const sld = document.getElementById('completion-fx-' + activeField + '-slider');
        const sldY = document.getElementById('completion-fy-' + activeField + '-slider');
        if (sld) sld.value = xEl.value;
        if (sldY) sldY.value = yEl.value;
        positionCompletionOverlayLabels();
        showToast('Moved ' + activeField + ' to X=' + xEl.value + ', Y=' + yEl.value + ' (from the bottom)', { type: 'success' });
    }
}
function onCompletionPaperSizeChange() {
    const kind = document.getElementById('completion-paper-size').value;
    const cust = document.getElementById('completion-custom-paper');
    if (cust) cust.style.display = kind === 'custom' ? 'flex' : 'none';
}
function loadCompletionPaperConfig(paper) {
    if (!paper) return;
    const mm = resolveDiplomaPaperMm(paper);
    if (mm) {
        document.getElementById('completion-paper-w').value = mm.wMm;
        document.getElementById('completion-paper-h').value = mm.hMm;
    }
}
function clearCompletionPdfPreview() {
    window._completionPdfTemplate = null;
    window._completionPdfDoc = null;
    const preview = document.getElementById('completion-pdf-preview');
    const preview2 = document.getElementById('completion-pdf-preview2');
    const canvas = document.getElementById('completion-pdf-canvas');
    const crosshair = document.getElementById('completion-crosshair');
    const fileInput = document.getElementById('completion-pdf-upload');
    const overlay = document.getElementById('completion-field-overlay');
    if (preview) { preview.textContent = 'No template uploaded'; preview.style.color = 'var(--text-muted)'; }
    if (preview2) { preview2.textContent = 'No template uploaded'; preview2.style.color = 'var(--text-muted)'; }
    if (canvas) canvas.style.display = 'none';
    if (crosshair) crosshair.style.display = 'none';
    if (fileInput) fileInput.value = '';
    if (overlay) overlay.innerHTML = '';
}
function applyCompletionPresetCoords(preset) {
    // Presets are written from the TOP of the page (the old convention) and
    // converted to the bottom-left origin at apply time.
    const presets = {
        portrait: { name: { x: 105, y: 120, size: 24 }, adm: { x: 105, y: 140, size: 14 }, date: { x: 105, y: 200, size: 14 }, docid: { x: 70, y: 280, size: 10 }, vcode: { x: 140, y: 280, size: 10 } },
        landscape: { name: { x: 148, y: 105, size: 24 }, adm: { x: 148, y: 125, size: 14 }, date: { x: 148, y: 185, size: 14 }, docid: { x: 100, y: 250, size: 10 }, vcode: { x: 196, y: 250, size: 10 } }
    };
    const coords = presets[preset];
    if (!coords) return;
    const hMm = getCompletionPageSize().hMm;
    for (const [field, fc] of Object.entries(coords)) {
        const xEl = document.getElementById('completion-fx-' + field);
        const yEl = document.getElementById('completion-fy-' + field);
        const sizeEl = document.getElementById('completion-fs-' + field);
        if (xEl) xEl.value = fc.x;
        if (yEl) yEl.value = Math.max(0, Math.round(hMm - fc.y));
        if (sizeEl) sizeEl.value = fc.size;
    }
    positionCompletionOverlayLabels();
    showToast('Applied ' + preset + ' preset coordinates', { type: 'success' });
}
async function saveCompletionPdfConfig() {
    if (window._completionPdfUploading) {
        showToast('Waiting for PDF upload to finish...', { type: 'info' });
        let waited = 0;
        while (window._completionPdfUploading && waited < 10000) {
            await new Promise(r => setTimeout(r, 200));
            waited += 200;
        }
        if (window._completionPdfUploading) return showToast('Upload timed out, please try again', { type: 'danger' });
    }
    if (!window._completionPdfTemplate) {
        showToast('No PDF template uploaded. Please upload a PDF first.', { type: 'danger' });
        return;
    }
    const btn = document.getElementById('btn-save-completion-config');
    const statusEl = document.getElementById('completion-save-status');
    if (btn) { btn.disabled = true; btn.querySelector('.btn-text').textContent = 'Saving...'; btn.querySelector('.btn-loading').style.display = 'inline'; }
    if (statusEl) { statusEl.textContent = 'Saving...'; statusEl.style.color = 'var(--accent)'; }
    const config = {
        template: window._completionPdfTemplate || null,
        // X from the left edge, Y from the bottom edge (the X/Y axes meet at
        // the bottom-left corner of the template).
        origin: TPL_ORIGIN_BOTTOM,
        fields: {
            name: { x: +document.getElementById('completion-fx-name').value, y: +document.getElementById('completion-fy-name').value, size: +document.getElementById('completion-fs-name').value },
            adm: { x: +document.getElementById('completion-fx-adm').value, y: +document.getElementById('completion-fy-adm').value, size: +document.getElementById('completion-fs-adm').value },
            date: { x: +document.getElementById('completion-fx-date').value, y: +document.getElementById('completion-fy-date').value, size: +document.getElementById('completion-fs-date').value },
            docid: { x: +document.getElementById('completion-fx-docid').value, y: +document.getElementById('completion-fy-docid').value, size: +document.getElementById('completion-fs-docid').value },
            vcode: { x: +document.getElementById('completion-fx-vcode').value, y: +document.getElementById('completion-fy-vcode').value, size: +document.getElementById('completion-fs-vcode').value }
        },
        font: document.getElementById('completion-font').value,
        color: document.getElementById('completion-text-color').value,
        paper: (() => {
            const kind = document.getElementById('completion-paper-size').value;
            if (kind === 'custom') return { kind: 'custom', wMm: +document.getElementById('completion-paper-w').value, hMm: +document.getElementById('completion-paper-h').value };
            return { kind: kind || 'auto' };
        })(),
        sigs: {
            registrar: { img: (window._completionSigs || {}).registrar || null, x: +document.getElementById('completion-sig-registrar-x').value, y: +document.getElementById('completion-sig-registrar-y').value, w: +document.getElementById('completion-sig-registrar-w').value },
            dean: { img: (window._completionSigs || {}).dean || null, x: +document.getElementById('completion-sig-dean-x').value, y: +document.getElementById('completion-sig-dean-y').value, w: +document.getElementById('completion-sig-dean-w').value },
            director: { img: (window._completionSigs || {}).director || null, x: +document.getElementById('completion-sig-director-x').value, y: +document.getElementById('completion-sig-director-y').value, w: +document.getElementById('completion-sig-director-w').value }
        }
    };
    try {
        await dbSet('settings', 'completionPdfConfig', config);
        try { localStorage.setItem('nkcms_completionPdfConfig_backup', JSON.stringify(config)); } catch (e) {}
        try { tplCacheClear('completionPdfConfig'); } catch {}
        showToast('Completion Certificate PDF configuration saved!', { type: 'success' });
        if (statusEl) { statusEl.textContent = '✓ Saved successfully'; statusEl.style.color = 'var(--success)'; }
    } catch (e) {
        const hint = /403/.test(e.message || '') ? ' Session expired — log out and log back in, then retry.' : '';
        showToast('Failed to save: ' + e.message + hint, { type: 'danger' });
        if (statusEl) { statusEl.textContent = '✗ Save failed'; statusEl.style.color = 'var(--danger)'; }
    } finally {
        const btn = document.getElementById('btn-save-completion-config');
        if (btn) { btn.disabled = false; btn.querySelector('.btn-text').textContent = 'Save Template'; btn.querySelector('.btn-loading').style.display = 'none'; }
    }
}
async function loadCompletionPdfConfig() {
    let rec = null;
    try { rec = await dbGet('settings', 'completionPdfConfig'); } catch (e) {}
    let config = (rec && rec.value) ? rec.value : rec;
    if (!config || !config.template) {
        try {
            const raw = localStorage.getItem('nkcms_completionPdfConfig_backup');
            if (raw) {
                config = JSON.parse(raw);
            }
        } catch (e) {}
    }
    if (!config || !config.template) {
        try { showToast('No saved config found'); } catch (e) {}
        return;
    }
    try { localStorage.setItem('nkcms_completionPdfConfig_backup', JSON.stringify(config)); } catch (e) {}
    window._completionPdfTemplate = config.template;
    window._completionSigs = config.sigs || {};
    // Configs saved before the bottom-left convention measured Y from the top.
    // Convert them here so the page does not move, and work from the bottom.
    const pageMm = (await tplPageMmOf(config.template)) || { wMm: 210, hMm: 297 };
    window._completionPageMm = { wMm: pageMm.wMm, hMm: pageMm.hMm };
    const yOf = (fc) => Math.round(tplYBottom(config, fc.y, pageMm.hMm));
    const f = config.fields || {};
    ['name', 'adm', 'date', 'docid', 'vcode'].forEach(field => {
        const fc = f[field];
        if (fc) {
            const xEl = document.getElementById('completion-fx-' + field);
            const yEl = document.getElementById('completion-fy-' + field);
            const sizeEl = document.getElementById('completion-fs-' + field);
            if (xEl) xEl.value = fc.x;
            if (yEl) yEl.value = yOf(fc);
            if (sizeEl) sizeEl.value = fc.size;
        }
    });
    if (config.font) document.getElementById('completion-font').value = config.font;
    if (config.color) document.getElementById('completion-text-color').value = config.color;
    if (config.paper) {
        const kind = document.getElementById('completion-paper-size');
        if (config.paper.kind) kind.value = config.paper.kind;
        if (config.paper.wMm) document.getElementById('completion-paper-w').value = config.paper.wMm;
        if (config.paper.hMm) document.getElementById('completion-paper-h').value = config.paper.hMm;
        onCompletionPaperSizeChange();
    }
    if (config.sigs) {
        ['registrar', 'dean', 'director'].forEach(role => {
            const s = config.sigs[role];
            if (!s) return;
            document.getElementById('completion-sig-' + role + '-x').value = s.x;
            document.getElementById('completion-sig-' + role + '-y').value = Math.round(tplYBottom(config, s.y, pageMm.hMm));
            document.getElementById('completion-sig-' + role + '-w').value = s.w;
            if (s.img) { const p = document.getElementById('completion-sig-' + role + '-preview'); if (p) { p.src = s.img; p.style.display = 'block'; } }
        });
    }
    const preview = document.getElementById('completion-pdf-preview');
    const preview2 = document.getElementById('completion-pdf-preview2');
    if (preview) { preview.textContent = config.template ? 'Template loaded' : 'No template uploaded'; preview.style.color = config.template ? 'var(--success)' : 'var(--text-muted)'; }
    if (preview2) { preview2.textContent = config.template ? 'Template loaded' : 'No template uploaded'; preview2.style.color = config.template ? 'var(--success)' : 'var(--text-muted)'; }
    if (config.template) await renderCompletionPdfOnCanvas(config.template);
    showToast('Config loaded');
}
async function detectCompletionFieldsWithAI() {
    const btn = document.querySelector('button[onclick="detectCompletionFieldsWithAI()"]');
    if (btn) { btn.disabled = true; btn.textContent = '🔍 Detecting...'; }
    try {
        let base64 = '';
        const fileInput = document.getElementById('completion-pdf-upload');
        if (fileInput.files && fileInput.files[0]) {
            const file = fileInput.files[0];
            if (file.type !== 'application/pdf') return showToast('Please upload a PDF file', { type: 'danger' });
            base64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => resolve(uint8ArrayToBase64(new Uint8Array(e.target.result)));
                reader.onerror = reject;
                reader.readAsArrayBuffer(file);
            });
        } else if (window._completionPdfTemplate) {
            base64 = window._completionPdfTemplate;
        } else {
            const rec = await dbGet('settings', 'completionPdfConfig');
            const config = (rec && rec.value) ? rec.value : rec;
            if (config && config.template) base64 = config.template;
        }
        if (!base64) return showToast('No PDF template available. Please upload and save a PDF first.', { type: 'danger' });
        showToast('Extracting text from PDF...', { type: 'info' });
        const res = await fetch('/api/ai/detect-fields', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
            body: JSON.stringify({ pdfBase64: base64 })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'AI detection failed');
        if (data.fields && Object.keys(data.fields).length) {
            let applied = 0;
            // Detection returns Y from the TOP of the page; the editor works
            // from the BOTTOM edge, so convert it here.
            const pageMm = getCompletionPageSize();
            for (const [field, coords] of Object.entries(data.fields)) {
                const xEl = document.getElementById('completion-fx-' + field);
                const yEl = document.getElementById('completion-fy-' + field);
                const sizeEl = document.getElementById('completion-fs-' + field);
                if (xEl && Number.isFinite(coords.x)) { xEl.value = Math.round(coords.x); applied++; }
                if (yEl && Number.isFinite(coords.y)) yEl.value = Math.round(pageMm.hMm - coords.y);
                if (sizeEl && coords.size) sizeEl.value = coords.size;
            }
            showToast(`${applied} fields detected. Positions filled.`, { type: 'success' });
            try {
                if (applied > 0) {
                    if (!window._completionPdfTemplate) window._completionPdfTemplate = base64;
                    await saveCompletionPdfConfig();
                }
            } catch (autoSaveErr) {
                console.warn('Auto-save after AI detection failed:', autoSaveErr);
            }
        } else {
            showToast('No text found in PDF. Labels may be in raster images. Set positions manually.', { type: 'warning' });
        }
    } catch (e) {
        showToast('AI detection error: ' + e.message, { type: 'danger' });
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔍 Detect Fields with AI'; }
    }
}
let _completionGenRestored = [];
let _completionGenStudents = [];
let _completionGenUsed = [];
function _completionSavedRestored() { try { return JSON.parse(localStorage.getItem('completion_restored_ids') || '[]'); } catch { return []; } }
function _completionPersistRestored() { try { localStorage.setItem('completion_restored_ids', JSON.stringify(_completionGenRestored)); } catch {} }
async function showCompletionPdfGenerator() {
    await ensureDocGenFlags();
    if (!docGenEnabledFor('completion')) {
        return showToast('Generate Completion is turned OFF for your country by the administrator.', { type: 'warning' });
    }
    const rec = await dbGet('settings', 'completionPdfConfig');
    const config = (rec && rec.value) ? rec.value : rec;
    const students = await dbGetAll('students');
    const certificates = await dbGetAll('certificates');
    const active = students.filter(s => s.status === 'active');
    if (!active.length) return showToast('No active students available.', { type: 'warning' });
    const compCerts = certificates.filter(c => c.type === 'completion');
    const usedIds = new Set(compCerts.map(c => c.studentId));
    _completionGenStudents = active;
    _completionGenUsed = active
        .filter(s => usedIds.has(s.id))
        .map(s => ({ id: s.id, name: s.name, admissionNumber: s.admissionNumber || s.id, generatedAt: compCerts.filter(c => c.studentId === s.id).map(c => c.generatedAt || c.createdAt || '').sort().pop() || '' }))
        .sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || ''));
    _completionGenRestored = _completionSavedRestored().filter(id => active.some(s => s.id === id));
    _completionPersistRestored();
    const content = `<div class="form-group"><label>Student</label><select id="completion-pdf-student"></select></div>
        <div class="form-group"><label>Student Name on Certificate <span style="font-size:10px;color:var(--text-muted);">(override - leave blank to use student record name)</span></label><input type="text" id="completion-pdf-name-override" placeholder="Optional: type name differently from student record"></div>
        <div class="form-group"><label>Completion Date *</label><input type="date" id="completion-pdf-date" required></div>
        <div class="form-group" style="border-top:1px solid var(--border);padding-top:10px;">
            <label>Recycle used names</label>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px;">
                <input type="number" id="completion-restore-count" min="1" max="${Math.max(1, _completionGenUsed.length)}" value="${Math.min(5, Math.max(1, _completionGenUsed.length))}" style="width:70px;">
                <button type="button" class="btn btn-outline btn-sm" onclick="restoreCompletionNamesCount(event)">Restore N used names</button>
                <button type="button" class="btn btn-outline btn-sm" onclick="restoreCompletionNamesAll(event)">Restore all (${_completionGenUsed.length})</button>
            </div>
            <div id="completion-restored-list" style="margin-top:6px;"></div>
            <small style="color:var(--text-muted);">Restored names reappear in the dropdown marked "(reprint)" and stay available even after generating.</small>
        </div>`;
    showModal('Generate Completion Certificate PDF', content, `<button type="button" class="btn btn-primary" onclick="generateCompletionPdf()">Generate</button>`);
    renderCompletionGenDropdown();
}
function renderCompletionGenDropdown() {
    const sel = document.getElementById('completion-pdf-student');
    if (!sel) return;
    const restored = new Set(_completionGenRestored);
    const usedMap = new Map(_completionGenUsed.map(u => [u.id, u]));
    const opts = _completionGenStudents
        .filter(s => !usedMap.has(s.id) || restored.has(s.id))
        .map(s => `<option value="${s.id}">${escapeHtml(s.name)} (${escapeHtml(s.admissionNumber || s.id)})${restored.has(s.id) && usedMap.has(s.id) ? ' — reprint' : ''}</option>`);
    sel.innerHTML = '<option value="">Select student...</option>' + opts.join('');
    const listEl = document.getElementById('completion-restored-list');
    if (listEl) {
        const items = _completionGenUsed.filter(u => restored.has(u.id));
        listEl.innerHTML = items.length
            ? items.map(u => `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:4px;padding:2px 8px;margin:2px;font-size:12px;">${escapeHtml(u.name)}<a href="#" onclick="removeRestoredCompletionName('${String(u.id).replace(/['"\\]/g, '')}');return false;" title="Remove from dropdown" style="color:var(--danger);text-decoration:none;">✕</a></span>`).join(' ')
            : '<small style="color:var(--text-muted);">No used names restored yet.</small>';
    }
}
function restoreCompletionNamesCount(ev) {
    if (ev) ev.preventDefault();
    if (!_completionGenUsed.length) return showToast('No used names to restore.', { type: 'warning' });
    const inp = document.getElementById('completion-restore-count');
    const n = Math.max(1, parseInt(inp && inp.value, 10) || 1);
    const toAdd = _completionGenUsed.slice(0, n).map(u => u.id);
    _completionGenRestored = Array.from(new Set([..._completionGenRestored, ...toAdd]));
    _completionPersistRestored();
    renderCompletionGenDropdown();
    showToast('Restored ' + toAdd.length + ' used name(s) to dropdown.', { type: 'success' });
}
function restoreCompletionNamesAll(ev) {
    if (ev) ev.preventDefault();
    if (!_completionGenUsed.length) return showToast('No used names to restore.', { type: 'warning' });
    _completionGenRestored = Array.from(new Set([..._completionGenRestored, ..._completionGenUsed.map(u => u.id)]));
    _completionPersistRestored();
    renderCompletionGenDropdown();
    showToast('Restored all ' + _completionGenUsed.length + ' used name(s).', { type: 'success' });
}
function removeRestoredCompletionName(id) {
    _completionGenRestored = _completionGenRestored.filter(x => x !== id);
    _completionPersistRestored();
    renderCompletionGenDropdown();
}
function _signatureTimeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('signature embed timeout')), ms)); }
// Embed a signatory signature image into a generator's PDF without ever hanging
// the tab: validates the payload (shape, atob-safety, PNG magic/dimensions/IEND
// terminator) and races embedPng/embedJpg against a timeout. Malformed or
// truncated images are skipped so a single corrupt signature can never wedge
// pdf-lib (pako inflate on a truncated PNG feeds an infinite loop) or the browser.
async function embedGeneratorSignature(pdfDoc, sig) {
    let imgData = sig && sig.img;
    if (imgData && typeof imgData === 'object') imgData = imgData.img || imgData.data || null;
    if (!imgData || typeof imgData !== 'string' || !imgData.startsWith('data:image/')) return null;
    const b64 = (imgData.split(',')[1]) || '';
    if (!b64 || b64.length % 4 !== 0) return null;
    let bytes;
    try { bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); }
    catch (e) { return null; }
    if (bytes.length < 24) return null;
    const isPng = imgData.indexOf('/png') > 0 && imgData.indexOf('/jpeg') < 0;
    if (isPng) {
        if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
        const w = ((bytes[16] << 24) >>> 0) + (bytes[17] << 16) + (bytes[18] << 8) + bytes[19];
        const h = ((bytes[20] << 24) >>> 0) + (bytes[21] << 16) + (bytes[22] << 8) + bytes[23];
        if (!w || !h || w > 4096 || h > 4096) return null;
        let iend = false;
        for (let i = bytes.length - 8; i >= bytes.length - 64 && i >= 0; i--) {
            if (bytes[i] === 0x49 && bytes[i + 1] === 0x45 && bytes[i + 2] === 0x4e && bytes[i + 3] === 0x44) { iend = true; break; }
        }
        if (!iend) return null;
    }
    try {
        return await Promise.race([
            (isPng ? pdfDoc.embedPng(bytes) : pdfDoc.embedJpg(bytes)),
            _signatureTimeout(4000)
        ]);
    } catch (e) {
        console.warn('Signature embed skipped:', e && e.message);
        return null;
    }
}
async function generateCompletionPdf() {
    const studentId = document.getElementById('completion-pdf-student').value;
    const compDate = document.getElementById('completion-pdf-date').value;
    const nameOverride = document.getElementById('completion-pdf-name-override').value.trim();
    if (!studentId) return showToast('Select a student!');
    if (!compDate) return showToast('Enter completion date!');
    // Student + template config in parallel; template bytes reused from session cache.
    const studentP = dbGet('students', studentId);
    let config = null, pdfBytes = null;
    try {
        const hit = tplCacheGet('completionPdfConfig');
        if (hit && hit.pdfBytes) { config = hit.config; pdfBytes = hit.pdfBytes; }
        else {
            const rec = await dbGet('settings', 'completionPdfConfig');
            config = (rec && rec.value) ? rec.value : rec;
            pdfBytes = await loadGeneratorTemplateBytes(config, 'completionPdfConfig');
            if (config && pdfBytes) tplCacheSet('completionPdfConfig', config, pdfBytes);
        }
    } catch {}
    try {
        closeModal();
        showToast('Generating completion certificate...', { type: 'info' });
        const { PDFDocument, StandardFonts, rgb } = PDFLib;
        if (!pdfBytes) throw new Error('No PDF template available. Please upload and save a PDF template first in Settings → Completion PDF.');
        let pdfDoc;
        try {
            pdfDoc = await PDFDocument.load(pdfBytes);
        } catch (e) {
            throw new Error('Failed to load PDF template. The delivered template bytes could not be parsed — please re-upload the template in Settings (a freshly saved template is streamed directly from disk).');
        }
        let page = pdfDoc.getPages()[0];
        const fontMap = { 'Times Roman': StandardFonts.TimesRoman, 'Helvetica': StandardFonts.Helvetica, 'Courier': StandardFonts.Courier };
        const font = await pdfDoc.embedFont(fontMap[config.font] || StandardFonts.TimesRoman);
        const colorHex = config.color || '#1a1a2e';
        const r = parseInt(colorHex.slice(1, 3), 16) / 255;
        const g = parseInt(colorHex.slice(3, 5), 16) / 255;
        const b = parseInt(colorHex.slice(5, 7), 16) / 255;
        const txtColor = rgb(r, g, b);
        const mmToPt = 2.83465;
        const paperMm = resolveDiplomaPaperMm(config.paper);
        const map = await tplPreparePage(pdfDoc, page, pdfBytes, paperMm);
        page = map.page;
        const student = await studentP;
        if (!student) throw new Error('Student not found — please refresh and retry.');
        const displayName = nameOverride || student.name;
        const docId = 'CMP-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();
        const vCode = generateVerificationCode();
        const compDt = new Date(compDate + 'T12:00:00');
        const compDay = compDt.getDate();
        const compOrd = (compDay % 10 === 1 && compDay !== 11) ? 'st' : (compDay % 10 === 2 && compDay !== 12) ? 'nd' : (compDay % 10 === 3 && compDay !== 13) ? 'rd' : 'th';
        const dateStr = compDay + compOrd + ' ' + compDt.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
        const pageW = page.getWidth();
        const pageH = page.getHeight();
        const drawField = (text, field, opts = {}) => {
            if (!field) return;
            const size = field.size || 12;
            const topToBaseline = font.heightAtSize(size) * 0.78;
            // Y is measured from the BOTTOM edge of the template.
            const yTpl = tplYBottom(config, field.y, map.tplHmm);
            let x = tplMapX(map, field.x) * mmToPt;
            if (opts.center || field === config.fields.name) {
                try {
                    const w = font.widthOfTextAtSize(text, size);
                    const areaW = (map.wMm - map.offXmm * 2) * mmToPt;
                    x = map.offXmm * mmToPt + (areaW - w) / 2;
                } catch {}
            }
            page.drawText(text, { x: x, y: tplMapY(map, yTpl) * mmToPt - topToBaseline, size: size, font: font, color: txtColor });
        };
        drawField(displayName, config.fields.name, { center: true });
        drawField(student.admissionNumber || student.id, config.fields.adm);
        drawField(dateStr, config.fields.date);
        drawField('Doc ID: ' + docId, config.fields.docid);
        drawField('Verify: ' + vCode, config.fields.vcode);
        for (const role of ['registrar', 'dean', 'director']) {
            const sig = config.sigs && config.sigs[role];
            if (!sig) continue;
            try {
                const sigImg = await embedGeneratorSignature(pdfDoc, sig);
                if (!sigImg) continue;
                const sigW = sig.w * mmToPt;
                const sigH = sigW * (sigImg.height / sigImg.width);
                const sigY = tplYBottom(config, sig.y, map.tplHmm);
                page.drawImage(sigImg, { x: tplMapX(map, sig.x) * mmToPt - sigW / 2, y: tplMapY(map, sigY) * mmToPt - sigH / 2, width: sigW, height: sigH });
            } catch (e) { console.warn('Signature embed failed for ' + role + ':', e); }
        }
        let outBytes;
        try {
            outBytes = await pdfDoc.save();
        } catch (e) {
            throw new Error('Failed to save PDF. Try a simpler template.');
        }
        const _outBytesArr = new Uint8Array(outBytes);
        let _bin = '';
        const _chunk = 0x8000;
        for (let _i = 0; _i < _outBytesArr.length; _i += _chunk) {
            _bin += String.fromCharCode.apply(null, _outBytesArr.subarray(_i, _i + _chunk));
        }
        const pdfB64 = btoa(_bin);
        const blob = new Blob([outBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const modalContent = `<div style="text-align:center;"><iframe src="${url}" style="width:100%;height:70vh;border:1px solid var(--border);"></iframe></div>`;
        const cert = { id: 'CERT-' + Date.now() + Math.random().toString(36).substr(2, 6).toUpperCase(), studentId, studentName: displayName, admission: student.admissionNumber || '', program: student.program || '', type: 'completion', docTitle: 'Completion Certificate', content: pdfB64, docId, vCode, generatedAt: new Date().toISOString() };
        // Store BEFORE showing the preview: if the write is refused (e.g. the
        // per-country doc-gen gate) staff must never end up holding a PDF whose
        // Doc ID / verify code were never saved — it could not be verified.
        try { await dbPut('certificates', cert); }
        catch (e) { console.error('Completion save failed:', e); return showToast('Could not save the certificate, so it was not issued. Please try again.', { type: 'danger' }); }
        showModal('Completion Certificate — ' + displayName, modalContent, `<button class="btn btn-primary" onclick="window.open('${url}','_blank')">Open PDF</button> <button class="btn btn-outline" onclick="downloadCompletionPdfBlob('${url}','${displayName}')">Download</button> <button class="btn btn-success" onclick="sendDocWhatsApp('${cert.id}')">📲 Send on WhatsApp</button>`);
        logAudit('generated', 'completion', { studentId, docId });
        showToast('Completion certificate generated! ' + displayName + ' removed from dropdown.');
    } catch (err) {
        console.error('Completion PDF error:', err);
        showToast('Failed to generate completion certificate: ' + err.message, { type: 'danger' });
    }
}
function downloadCompletionPdfBlob(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = 'Completion_Certificate_' + (name || 'certificate').replace(/\s+/g, '_') + '.pdf';
    a.click();
}

