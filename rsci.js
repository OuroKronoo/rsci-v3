/* ═══════════════════════════════════════════════════════════════
   RSCI OPERATIONS MANAGEMENT SYSTEM — rsci.js
   Full JS logic with 6 feature upgrades:
   1. Project-First Flow
   2. PO Number Uniqueness Enforcement
   3. Credit Terms per Supplier + Due Date Auto-Compute
   4. Item Price per Supplier (supplier-item pricing)
   5. Per-Item Project Tagging inside one PO
   6. Custom Units of Measurement
═══════════════════════════════════════════════════════════════ */

// ── UTILITIES ─────────────────────────────────────────────────
function uid() { return Math.random().toString(36).slice(2,9) + Date.now().toString(36); }
function today() { return new Date().toISOString().split('T')[0]; }
function nowISO() { return new Date().toISOString(); }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function peso(n) { return '₱' + (parseFloat(n)||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtDate(d) {
  if(!d) return '–';
  try { return new Date(d+'T00:00:00').toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'}); } catch(e) { return d; }
}
function fmtDT(d) {
  if(!d) return '–';
  try { return new Date(d).toLocaleString('en-PH',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'}); } catch(e) { return d; }
}
function stockStatus(item) {
  const q=item.qty||0, m=item.min||5;
  if(q===0) return {label:'Out',cls:'out'};
  if(q<=m) return {label:'Low',cls:'low'};
  return {label:'OK',cls:'ok'};
}
function categoryOf(name) { const p=name.split(':'); return p.length>1?p[0].trim():'General'; }
function itemLabel(name) { return name.split(':').pop().trim(); }
function findInventoryItem(desc) {
  if(!desc) return null;
  const d=desc.toLowerCase().trim();
  return DB.inventory.find(i=> i.name.toLowerCase()===d || i.name.toLowerCase().includes(d) || d.includes(i.name.split(':').pop().toLowerCase().trim()) || i.name.split(':').pop().toLowerCase().trim()===d);
}
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}
function dueDateStatus(dueDateStr) {
  if(!dueDateStr) return 'ok';
  const due = new Date(dueDateStr + 'T00:00:00');
  const now = new Date();
  const diff = Math.ceil((due - now) / (1000*60*60*24));
  if(diff < 0) return 'overdue';
  if(diff <= 7) return 'warn';
  return 'ok';
}

// ── LOCAL STORAGE & DEMO SEED ─────────────────────────────────
const DB_KEY = 'rsci_db_v3';
const SEED_VERSION = 5;
const SEED_VERSION_KEY = 'rsci_seed_version';
const DEMO_PASSWORD = 'demo2025';

function saveDB() { try { localStorage.setItem(DB_KEY, JSON.stringify(DB)); } catch(e) {} }

function applySeedDB() {
  const fresh = cloneInitialDB();
  Object.keys(DB).forEach(k=>delete DB[k]);
  Object.assign(DB, fresh);
  DB.po_release_queue = DB.po_release_queue || [];
  DB.notifications = DB.notifications || [];
  DB.release_monitors = DB.release_monitors || [];
  DB.release_items = DB.release_items || [];
  DB.pullout_records = DB.pullout_records || [];
  migrateDB();
  saveDB();
  try { localStorage.setItem(SEED_VERSION_KEY, String(SEED_VERSION)); } catch(e) {}
}

function resetDemoData() {
  applySeedDB();
  buildDatalist();
  toast('Sample data restored.','ok');
  if(_currentUser) {
    _currentUser = mergeUserAssignments(_selectedRole, {...DEMO_USERS[_selectedRole]});
    updateInvPill();
    buildNotifications();
    const defaults = {
      admin:'acc-dashboard',accountant:'acc-dashboard',po_officer:'po-dashboard',
      inventory_manager:'inv-dashboard',engineer:'emp-dashboard',boss:'boss-dashboard',
    };
    navigate(defaults[_currentUser.role] || 'acc-dashboard', null);
  }
}

function loadDB() {
  try {
    const seedOk = localStorage.getItem(SEED_VERSION_KEY) === String(SEED_VERSION);
    const raw = localStorage.getItem(DB_KEY);
    if(seedOk && raw) {
      const d = JSON.parse(raw);
      if(d && d.inventory) {
        Object.keys(DB).forEach(k=>delete DB[k]);
        Object.assign(DB, d);
        DB.po_release_queue = DB.po_release_queue || [];
        migrateDB();
        return;
      }
    }
  } catch(e) {}
  applySeedDB();
}

function isDemoSession() {
  return sessionStorage.getItem('rsci_demo_session') === '1';
}

function initDemoLoginUI() {
  const demo=document.getElementById('demo-mode');
  const pass=document.getElementById('login-pass');
  const hint=document.getElementById('demo-pass-hint');
  if(demo && !demo.checked) { demo.checked=true; }
  onDemoToggle();
  if(pass && !pass.value) pass.value=DEMO_PASSWORD;
  if(hint) hint.style.display=demo?.checked?'block':'none';
}

function showDemoPresentBar() {
  const bar=document.getElementById('demo-present-bar');
  if(bar) bar.style.display=isDemoSession()?'flex':'none';
}

function migrateDB() {
  DB.user_assignments = DB.user_assignments || {};
  Object.keys(DEMO_USERS).forEach(k=>{
    const u=DEMO_USERS[k];
    if(u.role==='engineer'&&u.assignedProjectIds&&!DB.user_assignments[k]) {
      DB.user_assignments[k]={assignedProjectIds:[...u.assignedProjectIds]};
    }
  });
  (DB.billing_records||[]).forEach(r=>ensureProjectForBillingRecord(r));
  (DB.tickets||[]).forEach(t=>{
    if(t.bossApproved===undefined) t.bossApproved=false;
    if(t.financeApproved===undefined) t.financeApproved=false;
    if(!t.auditTrail) t.auditTrail=[{action:'Created',by:t.submittedBy||'System',at:t.submittedAt||nowISO(),note:'Material order created.'}];
    if(!t.projectId&&t.project) {
      const p=DB.projects.find(x=>x.name===t.project);
      if(p) t.projectId=p.id;
    }
    if(t.status==='Pending') t.status='Pending Inventory';
    if((t.status==='Partial'||t.materials?.some(m=>(m.fulfilledQty||0)>0))&&!t.inventoryReviewedAt) {
      t.inventoryReviewedAt=t.inventoryReviewedAt||t.submittedAt;
      t.inventoryReviewedBy=t.inventoryReviewedBy||'Inventory';
      if(ticketNeedsPurchase(t)) t.status='At PO';
    }
    if(t.status==='Partial'&&t.inventoryReviewedAt&&ticketNeedsPurchase(t)) t.status='At PO';
  });
  (DB.inventory||[]).forEach(i=>{ if(i.reserved===undefined) i.reserved=0; });
  DB.release_monitors=DB.release_monitors||[];
  DB.release_items=DB.release_items||[];
  DB.pullout_records=DB.pullout_records||[];
}

function statusBadgeClass(status) {
  return String(status||'').toLowerCase().replace(/\s+/g,'-');
}

function generateOrderNumber() {
  const year=new Date().getFullYear();
  const nums=DB.tickets.map(t=>{
    const m=(t.no||'').match(/(?:ORD|TKT)-\d{4}-(\d+)/i);
    return m?parseInt(m[1],10):0;
  });
  const next=(nums.length?Math.max(...nums):0)+1;
  return `ORD-${year}-${String(next).padStart(3,'0')}`;
}

function getReservedQty(inv) { return inv?.reserved||0; }
function getAvailableQty(inv) { return Math.max(0,(inv?.qty||0)-getReservedQty(inv)); }
function getStockAvailableForMaterial(name) {
  const inv=findInventoryItem(name);
  return inv?getAvailableQty(inv):0;
}
function computeReleaseItemStatus(item) {
  const rq=item.reservedQty||0, rel=item.releasedQty||0;
  if(rel<=0) return 'Reserved';
  if(rel>=rq) return 'Released All';
  return 'Partially Released';
}
function releaseItemBadgeClass(st) {
  return String(st||'').toLowerCase().replace(/\s+/g,'-');
}
function computeMonitorStatus(monitorId) {
  const items=getReleaseItemsForMonitor(monitorId);
  if(!items.length) return 'ongoing';
  if(items.every(i=>i.status==='Released All')) return 'completed';
  if(items.some(i=>i.status==='Partially Released'||i.status==='Released All')) return 'partial';
  return 'ongoing';
}
function getReleaseItemsForMonitor(monitorId) {
  return (DB.release_items||[]).filter(i=>i.monitorId===monitorId);
}
function findReleaseItemForTicketMaterial(ticketId, itemName) {
  return (DB.release_items||[]).find(i=>i.ticketId===ticketId&&i.itemName===itemName);
}
function findOrCreateReleaseMonitor({projectId,projectName,ticketId,ticketNo,pm,siteLocation,remarks}) {
  DB.release_monitors=DB.release_monitors||[];
  let mon=ticketId?DB.release_monitors.find(m=>m.ticketId===ticketId):null;
  if(!mon) mon=DB.release_monitors.find(m=>m.projectId===projectId&&m.status!=='completed'&&!m.ticketId);
  if(!mon) {
    mon={id:uid(),projectId,projectName,ticketId:ticketId||null,orderRef:ticketNo||null,pm:pm||'',siteLocation:siteLocation||'',remarks:remarks||'',status:'ongoing',createdAt:nowISO(),createdBy:_currentUser?.name||'System'};
    DB.release_monitors.unshift(mon);
  } else if(ticketId&&!mon.ticketId) { mon.ticketId=ticketId; mon.orderRef=ticketNo; }
  return mon;
}
function reserveMaterialsForTicket(ticket) {
  DB.release_items=DB.release_items||[];
  const mon=findOrCreateReleaseMonitor({projectId:ticket.projectId,projectName:ticket.project,ticketId:ticket.id,ticketNo:ticket.no,pm:ticket.pm,siteLocation:ticket.siteLocation,remarks:ticket.remarks});
  ticket.materials.forEach(m=>{
    const inv=findInventoryItem(m.name);
    const avail=inv?getAvailableQty(inv):0;
    const reserveQty=Math.min(m.requestedQty||0,avail);
    m.reservedQty=reserveQty;
    if(inv&&reserveQty>0) {
      inv.reserved=(inv.reserved||0)+reserveQty;
      DB.inventory_log.unshift({id:uid(),dt:nowISO(),type:'reserve',itemName:inv.name,project:ticket.project,qtyChange:-reserveQty,balanceAfter:getAvailableQty(inv),remarks:`${ticket.no} reserved · ${ticket.project} (${reserveQty} ${m.unit})`});
    }
    DB.release_items.push({id:uid(),monitorId:mon.id,ticketId:ticket.id,itemName:m.name,inventoryId:inv?.id||null,reservedQty:reserveQty,releasedQty:0,unit:m.unit,status:'Reserved',createdAt:nowISO()});
  });
  mon.status=computeMonitorStatus(mon.id);
}
function restoreReleaseItemReservation(item,projectName) {
  const inv=findInventoryItem(item.itemName);
  const unreserve=Math.max(0,(item.reservedQty||0)-(item.releasedQty||0));
  if(inv&&unreserve>0) {
    inv.reserved=Math.max(0,(inv.reserved||0)-unreserve);
    DB.inventory_log.unshift({id:uid(),dt:nowISO(),type:'reserve',itemName:inv.name,project:projectName||'',qtyChange:unreserve,balanceAfter:getAvailableQty(inv),remarks:`Reservation cancelled — ${unreserve} ${item.unit} returned to available`});
  }
}
function syncWarehouseReleaseToMonitor(ticket,materialName,releaseQty) {
  const ri=findReleaseItemForTicketMaterial(ticket.id,materialName);
  if(!ri) return;
  ri.releasedQty=(ri.releasedQty||0)+releaseQty;
  ri.status=computeReleaseItemStatus(ri);
  const inv=findInventoryItem(materialName);
  if(inv&&releaseQty>0) inv.reserved=Math.max(0,(inv.reserved||0)-releaseQty);
  const mon=DB.release_monitors?.find(m=>m.id===ri.monitorId);
  if(mon) mon.status=computeMonitorStatus(mon.id);
}
function finalizeReleaseToMovementLog(ticket) {
  const items=getReleaseItemsForMonitor(DB.release_monitors?.find(m=>m.ticketId===ticket.id)?.id||'').filter(i=>i.status==='Released All');
  items.forEach(i=>{
    DB.inventory_log.unshift({id:uid(),dt:nowISO(),type:'release',itemName:i.itemName,project:ticket.project,qtyChange:-(i.releasedQty||0),balanceAfter:findInventoryItem(i.itemName)?.qty??0,remarks:`${ticket.no} finalized · ${i.releasedQty} ${i.unit} released to site`});
  });
}

function ticketNeedsPurchase(t) {
  return (t.materials||[]).some(m=>(m.remainingQty||0)>0);
}

function getTicketsPendingInventory() {
  return DB.tickets.filter(t=>t.status==='Pending Inventory');
}

function getTicketsForPOOfficer() {
  return DB.tickets.filter(t=>{
    if(t.status==='Completed'||t.linkedPOId) return false;
    if(!t.inventoryReviewedAt||!ticketNeedsPurchase(t)) return false;
    return t.status==='At PO'||t.status==='Partial'||t.status==='Pending Override';
  });
}

function updateOrderNavBadges() {
  const invCnt=getTicketsPendingInventory().length;
  const poCnt=getTicketsForPOOfficer().length;
  const nbInv=document.getElementById('nb-inv-orders');
  const nbPo=document.getElementById('nb-po-orders');
  if(nbInv) nbInv.textContent=invCnt||'';
  if(nbPo) nbPo.textContent=poCnt||'';
}

function getAssignedProjectIds(userKey) {
  return DB.user_assignments?.[userKey]?.assignedProjectIds
    || DEMO_USERS[userKey]?.assignedProjectIds
    || [];
}

function mergeUserAssignments(userKey, user) {
  const ids=getAssignedProjectIds(userKey);
  if(user.role==='engineer') return {...user,assignedProjectIds:ids.length?ids:(user.assignedProjectIds||[])};
  return user;
}

function appendTicketAudit(ticket, action, note, by) {
  if(!ticket.auditTrail) ticket.auditTrail=[];
  ticket.auditTrail.push({action,by:by||_currentUser?.name||'System',at:nowISO(),note:note||''});
}

function pushPOAudit(po, action, note) {
  if(!po) return;
  if(!po.audit_trail) po.audit_trail=[];
  po.audit_trail.push({action, by:_currentUser?.name||'–', at:nowISO(), note:note||''});
}

function reconcileBillingRecordProject(record) {
  if(!record) return record;
  const p=DB.projects.find(x=>x.id===record.projectId)
    ||DB.projects.find(x=>x.name===record.project)
    ||(record.company&&DB.projects.find(x=>x.client===record.company));
  if(p) {
    record.projectId=p.id;
    if(!record.project) record.project=p.name;
    if(!record.company) record.company=p.client||record.company;
    delete record.projectIdNote;
  } else if(!record.projectId) {
    record.projectId=null;
    if(!record.projectIdNote) record.projectIdNote='No matching project found in DB.projects.';
  }
  return record;
}

/** Ensures every billing record has a matching Active project for tickets / PO gate. */
function ensureProjectForBillingRecord(record) {
  if(!record||!(record.project||'').trim()) return record;
  reconcileBillingRecordProject(record);
  if(record.projectId&&DB.projects.some(p=>p.id===record.projectId)) {
    const p=DB.projects.find(x=>x.id===record.projectId);
    if(record.company) p.client=record.company;
    if(record.contractAmount&&!p.contractAmount) p.contractAmount=parseFloat(record.contractAmount)||0;
    if(p.status!=='Active') p.status='Active';
    delete record.projectIdNote;
    return record;
  }
  const name=record.project.trim();
  let p=DB.projects.find(x=>x.name.toLowerCase()===name.toLowerCase());
  if(!p) {
    p={
      id:uid(), name,
      client:record.company||'',
      contractAmount:parseFloat(record.contractAmount)||0,
      status:'Active', code:'', location:'',
      remarks:'Synced from Customer Billing',
      createdAt:today(),
    };
    DB.projects.unshift(p);
  } else {
    if(record.company) p.client=record.company;
    if(record.contractAmount&&!p.contractAmount) p.contractAmount=parseFloat(record.contractAmount)||0;
    if(p.status!=='Active') p.status='Active';
  }
  record.projectId=p.id;
  delete record.projectIdNote;
  return record;
}

function getTicketProjectOptions() {
  const isEng=_currentUser?.role==='engineer';
  const allowed=new Set(isEng?(_currentUser?.assignedProjectIds||[]):DB.projects.map(p=>p.id));
  if(isEng) {
    (DB.billing_records||[]).forEach(r=>{
      if(r.projectId) allowed.add(r.projectId);
      else if(r.project) {
        ensureProjectForBillingRecord(r);
        if(r.projectId) allowed.add(r.projectId);
      }
    });
  }
  return DB.projects
    .filter(p=>p.status==='Active'&&(!isEng||allowed.has(p.id)))
    .map(p=>({id:p.id,name:p.name,client:p.client||''}))
    .sort((a,b)=>a.name.localeCompare(b.name));
}

function resolveTicketProjectByName(name) {
  const n=(name||'').trim();
  if(!n) return null;
  let p=DB.projects.find(x=>x.name.toLowerCase()===n.toLowerCase());
  if(p) return {id:p.id,name:p.name,client:p.client||''};
  const br=(DB.billing_records||[]).find(r=>(r.project||'').toLowerCase()===n.toLowerCase());
  if(br) {
    ensureProjectForBillingRecord(br);
    p=DB.projects.find(x=>x.id===br.projectId);
    if(p) return {id:p.id,name:p.name,client:br.company||p.client||''};
  }
  return null;
}

function getBillingRecordByProjectId(projectId) {
  if(!projectId) return null;
  return DB.billing_records.find(r=>r.projectId===projectId)||null;
}

function getBillingGateStatus(projectId) {
  if(!projectId) {
    return {passed:false,reason:'no_project',message:'No project linked to this ticket.',record:null,paidInvoices:[]};
  }
  const record=getBillingRecordByProjectId(projectId);
  if(!record) {
    return {passed:false,reason:'no_record',message:'No customer billing record for this project.',record:null,paidInvoices:[]};
  }
  const paidInvoices=DB.billing_invoices.filter(i=>i.recordId===record.id&&i.status==='Paid');
  if(!paidInvoices.length) {
    return {passed:false,reason:'no_paid_invoice',message:'Billing record exists but no invoice is marked Paid.',record,paidInvoices:[]};
  }
  return {passed:true,reason:'paid',message:'Paid invoice on file — PO gate open.',record,paidInvoices};
}

function ticketHasPaidBilling(projectId) {
  return getBillingGateStatus(projectId).passed;
}

function logSystemActivity(action, entity, details) {
  DB.system_logs=DB.system_logs||[];
  DB.system_logs.unshift({
    id:uid(),dt:nowISO(),user:_currentUser?.name||'System',action,entity:entity||'',details:details||'',status:'success',
  });
  DB.system_logs=DB.system_logs.slice(0,200);
}

function onBillingPaymentRecorded(projectId, invoiceLabel) {
  if(!projectId) return;
  const proj=DB.projects.find(p=>p.id===projectId);
  const affected=DB.tickets.filter(t=>t.projectId===projectId&&['Pending Override','At PO','Pending Inventory'].includes(t.status));
  affected.forEach(t=>{
    appendTicketAudit(t,'Billing updated',`Paid invoice recorded (${invoiceLabel||'payment'}) — PO gate may pass`);
    if(t.status==='Pending Override'&&!t.bossApproved&&!t.financeApproved) t.status='Pending';
  });
  if(affected.length) {
    pushNotification({
      type:'green',title:'Billing payment logged',
      text:`${affected.length} material ticket(s) for ${proj?.name||'project'} may proceed to PO.`,
      roles:['po_officer','accountant','admin'],source:'billing',
    });
  }
  updateOverrideNavBadge();
  if(currentPage==='po-dashboard') renderPODashboard();
  if(currentPage==='acc-dashboard') renderAccDashboard();
}

let _billingGateTicketId=null;

function openBillingGateModal(ticket) {
  _billingGateTicketId=ticket?.id||null;
  const proj=DB.projects.find(p=>p.id===ticket?.projectId);
  const gate=getBillingGateStatus(ticket?.projectId);
  const client=proj?.client||ticket?.client||'Unknown Client';
  const projectName=ticket?.project||proj?.name||'Unknown Project';
  const msgEl=document.getElementById('billing-gate-msg');
  if(msgEl) {
    let extra='';
    if(gate.reason==='no_record') extra=' No billing record exists yet for this project.';
    else if(gate.reason==='no_paid_invoice') extra=' No customer invoice is marked Paid yet.';
    msgEl.textContent=`No received payment on record for ${client} — ${projectName}.${extra}`;
  }
  const hid=document.getElementById('billing-gate-project-id');
  if(hid) hid.value=ticket?.projectId||'';
  openMo('mo-billing-gate');
}

function billingGateNotifyOverride() {
  if(!_billingGateTicketId) { closeMo('mo-billing-gate'); return; }
  notifyOverrideRequest(_billingGateTicketId);
}

function notifyOverrideRequest(ticketId) {
  const ticket=DB.tickets.find(t=>t.id===ticketId);
  if(!ticket) { toast('Error: Ticket not found.'); return; }
  const proj=DB.projects.find(p=>p.id===ticket.projectId);
  const projectName=ticket.project||proj?.name||'Unknown Project';
  const client=proj?.client||ticket.client||'';
  const requester=_currentUser?.name||'PO Officer';
  const gate=getBillingGateStatus(ticket.projectId);
  const gateNote=gate.message||'No paid customer invoice on file';

  if(ticket.status!=='Pending Override') {
    ticket.status='Pending Override';
    ticket.bossApproved=false;
    ticket.financeApproved=false;
    appendTicketAudit(ticket,'Override requested',`${requester} asked Boss & Finance for a billing exception — ${projectName}`);
  } else {
    appendTicketAudit(ticket,'Override reminder sent',`${requester} re-notified Boss & Finance — ${projectName}`);
  }

  pushNotification({
    type:'orange',
    title:'Override / exception requested',
    text:`${ticket.no} · ${projectName}${client?` (${client})`:''} — ${gateNote}. ${requester} is requesting Boss & Finance approval to allow PO creation without paid billing.`,
    roles:['boss','accountant'],
    source:'override-request',
  });

  logSystemActivity('Override notification sent',ticket.no,`Boss & Finance notified for ${projectName}`);
  saveDB();
  closeMo('mo-billing-gate');
  updateOverrideNavBadge();
  if(currentPage==='po-dashboard') renderPODashboard();
  if(currentPage==='acc-dashboard') renderAccDashboard();
  if(currentPage==='boss-dashboard') renderBossDashboard();
  if(currentPage==='emp-ticket-detail') viewTicketDetail(ticketId);
  toast('Boss and Finance have been notified to review this override request.','ok');
}

function renderBillingGatePanel(ticket, {compact=false,forPO=false}={}) {
  if(!ticket?.projectId) return '';
  const gate=getBillingGateStatus(ticket.projectId);
  const record=gate.record;
  const paidCnt=gate.paidInvoices?.length||0;
  const cls=gate.passed?'billing-gate-ok':'billing-gate-blocked';
  const icon=gate.passed?'✓':'⛔';
  const label=gate.passed?`PO gate open — ${paidCnt} paid invoice(s) on file`:`PO gate blocked — ${gate.message}`;
  if(compact) {
    return `<div class="${cls}" style="padding:10px 12px;border-radius:var(--r);font-size:12px;margin-bottom:12px;">${icon} ${esc(label)}</div>`;
  }
  const recordBtn=forPO?'':(record
    ?`<button type="button" class="btn btn-ol btn-sm" onclick="blOpenDetail('${record.id}')">Open billing record</button>`
    :`<button type="button" class="btn btn-ol btn-sm" onclick="blOpenAddRecordModal('${ticket.projectId}')">+ Create billing record</button>`);
  const overrideBtn=!gate.passed
    ?(forPO
      ?`<button type="button" class="btn btn-or btn-sm" onclick="notifyOverrideRequest('${ticket.id}')">Notify for Override</button>`
      :`<button type="button" class="btn btn-bl btn-sm" onclick="navigate('boss-override-queue',document.querySelector('[data-page=boss-override-queue]'))">Override queue</button>`)
    :'';
  return `<div class="${cls}" style="padding:14px 16px;border-radius:var(--r);margin-bottom:14px;">
    <div style="font-weight:700;font-size:13px;margin-bottom:6px;">${icon} Billing / PO Gate</div>
    <div style="font-size:12px;line-height:1.55;margin-bottom:10px;">${esc(label)}</div>
    ${!forPO&&record?`<div style="font-size:11.5px;color:var(--soft);margin-bottom:10px;">Record: <strong>${esc(record.company)}</strong> · Contract ${peso(record.contractAmount)} · Collected ${peso(getBillingCollectedNet(record.id))}</div>`:''}
    ${forPO&&!gate.passed?`<div style="font-size:11.5px;color:var(--soft);margin-bottom:10px;">Notify Boss and Finance to approve an exception if PO must proceed without paid billing.</div>`:''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;">${recordBtn}${overrideBtn}
    </div>
  </div>`;
}

function getPendingOverrideTickets() {
  return DB.tickets.filter(t=>t.status==='Pending Override');
}

// ── DEMO USERS ────────────────────────────────────────────────
const DEMO_USERS = {
  admin:             { name:'Ana Santos',      email:'admin@rsconstruction.com',    role:'admin',             initials:'AS' },
  accountant:        { name:'Benito Navarro',  email:'accountant@rsconstruction.com',role:'accountant',        initials:'BN' },
  po_officer:        { name:'Liza Mercado',    email:'po@rsconstruction.com',        role:'po_officer',        initials:'LM' },
  engineer:          { name:'Marco Rivera',    email:'engineer@rsconstruction.com',  role:'engineer',          initials:'MR', assignedProjectIds:['PROJ001','PROJ002'] },
  inventory_manager: { name:'Danny Pascual',   email:'inv@rsconstruction.com',       role:'inventory_manager', initials:'DP' },
  boss:              { name:'Ricardo Santos',  email:'boss@rsconstruction.com',      role:'boss',              initials:'RS' },
};

function roleEmailsFor(roles) {
  return (roles||[]).map(r=>(Object.values(DEMO_USERS).find(u=>u.role===r)||{}).email).filter(Boolean);
}

let _currentUser = null;

// ── DATABASE (seed via cloneInitialDB) ────────────────────────
function cloneInitialDB() {
  const ago=(n)=>addDays(today(),-n);
  const ahead=(n)=>addDays(today(),n);
  const ts=(daysAgo,h=9,m=0)=>`${ago(daysAgo)}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
  return {
  // ─── PROJECTS (Feature 1: Project-First Flow) ───
  projects: [
    {id:'PROJ001',name:'Maxicare Pulilan — 3F Renovation',client:'Maxicare Healthcare Corp.',code:'MAY_005',contractAmount:8500000,status:'Active',location:'Pulilan, Bulacan',remarks:'MEP scope only',createdAt:'2025-01-10'},
    {id:'PROJ002',name:'Smilee Monumento — Interior Fit-out',client:'Smilee Dental Group',code:'MAY_006',contractAmount:4200000,status:'Active',location:'Monumento, Caloocan',remarks:'',createdAt:'2025-02-01'},
    {id:'PROJ003',name:'Residential Complex Phase 1',client:'GreenVista Development Corp.',code:'GV_P1',contractAmount:12500000,status:'Active',location:'Quezon City',remarks:'',createdAt:'2025-01-15'},
    {id:'PROJ004',name:'Phase 2 Foundation',client:'GreenVista Development Corp.',code:'GV_P2',contractAmount:9800000,status:'Active',location:'Quezon City',remarks:'Structural phase',createdAt:'2025-03-01'},
    {id:'PROJ005',name:'GF Reception Area',client:'Metro Commercial Holdings Inc.',code:'MCH_GF',contractAmount:3100000,status:'Completed',location:'Makati City',remarks:'',createdAt:'2024-11-01'},
    {id:'PROJ006',name:'Warehouse Stock',client:'RSCI Internal',code:'WH_STOCK',contractAmount:0,status:'Active',location:'RSCI Warehouse',remarks:'For warehouse stock replenishment',createdAt:'2025-01-01'},
  ],

  // ─── SUPPLIERS (Feature 3: Credit Terms + Feature 4: Item Prices) ───
  suppliers: [
    {id:'SUP001',name:'Conduit Pro Supply Co.',terms:30,tin:'111-222-333-000',address:'Quezon Avenue, QC',contact:'Joey Cruz - 09171234567',
     itemPrices:[
       {itemId:'INV001',itemName:'ELECTRICAL:EMT STRAIGHT_CONNECTOR 1/2',unit:'PCS',price:13.50},
       {itemId:'INV002',itemName:'ELECTRICAL:EMT STRAIGHT_CONNECTOR 3/4',unit:'PCS',price:21.00},
     ]},
    {id:'SUP002',name:'Holcim Philippines Inc.',terms:60,tin:'444-555-666-000',address:'Makati City',contact:'Sales Dept - 02-8123456',
     itemPrices:[
       {itemId:'INV018',itemName:'CIVIL:CEMENT TYPE I 40KG',unit:'BAGS',price:275.00},
     ]},
    {id:'SUP003',name:'Pag-asa Steel Corp.',terms:45,tin:'777-888-999-000',address:'Valenzuela City',contact:'Romy Santos - 09281234567',
     itemPrices:[
       {itemId:'INV019',itemName:'CIVIL:REINFORCING BAR 12MM DEFORMED',unit:'LEN',price:370.00},
       {itemId:'INV020',itemName:'CIVIL:REINFORCING BAR 16MM DEFORMED',unit:'LEN',price:665.00},
     ]},
    {id:'SUP004',name:'Davies Paints PH',terms:30,tin:'101-202-303-000',address:'Mandaluyong City',contact:'Sales - 02-7654321',
     itemPrices:[
       {itemId:'INV025',itemName:'FINISHING:PAINT WHITE LATEX 4L',unit:'GAL',price:540.00},
     ]},
    {id:'SUP005',name:'Neltex Development Co.',terms:30,tin:'102-203-304-000',address:'Bulacan',contact:'Mark Lim - 09189876543',
     itemPrices:[
       {itemId:'INV014',itemName:'PLUMBING:PVC B Coupling 25mm',unit:'PCS',price:18.00},
       {itemId:'INV015',itemName:'PLUMBING:PVC ELBOW 90deg 50mm',unit:'PCS',price:32.00},
       {itemId:'INV016',itemName:'PLUMBING:PVC PIPE 2 INCH',unit:'LEN',price:268.00},
     ]},
    {id:'SUP006',name:'Goldentown Supply',terms:30,tin:'103-204-305-000',address:'Valenzuela, Metro Manila',contact:'Tina Reyes - 09171112222',
     itemPrices:[
       {itemId:'INV016',itemName:'PLUMBING:PVC PIPE 2 INCH',unit:'LEN',price:320.00},
     ]},
    {id:'SUP007',name:'Sheraton Hardware',terms:0,tin:'104-205-306-000',address:'Caloocan City',contact:'Ben Aguilar - 09283334444',
     itemPrices:[
       {itemId:'INV016',itemName:'PLUMBING:PVC PIPE 2 INCH',unit:'LEN',price:450.00},
     ]},
  ],

  inventory: [
    {id:'INV001',name:'ELECTRICAL:EMT STRAIGHT_CONNECTOR 1/2',price:15,qty:342,reserved:0,unit:'PCS',min:50,brand:'Conduit Pro',expected:0},
    {id:'INV002',name:'ELECTRICAL:EMT STRAIGHT_CONNECTOR 3/4',price:23,qty:181,unit:'PCS',min:50,brand:'Conduit Pro',expected:0},
    {id:'INV003',name:'ELECTRICAL:GT_CONDUIT_HANGER 1/2',price:25,qty:399,unit:'PCS',min:80,brand:'Generic',expected:0},
    {id:'INV004',name:'ELECTRICAL:GT_CONDUIT_HANGER 3/4',price:30,qty:215,unit:'PCS',min:80,brand:'Generic',expected:0},
    {id:'INV005',name:'ELECTRICAL:GT_METAL JUNCTION BOX COVER',price:50,qty:376,unit:'PCS',min:60,brand:'Greenfield',expected:0},
    {id:'INV006',name:'ELECTRICAL:METAL_SQUARE_BOX 4X4',price:120,qty:101,unit:'PCS',min:40,brand:'Greenfield',expected:0},
    {id:'INV007',name:'ELECTRICAL:METAL_UTILITY_BOX',price:150,qty:106,unit:'PCS',min:40,brand:'Greenfield',expected:0},
    {id:'INV008',name:'ELECTRICAL:ROYAL CORD THHN 5.5mm2 - BLACK',price:220,qty:8,unit:'PCS',min:20,brand:'Royal Cord',expected:0},
    {id:'INV009',name:'ELECTRICAL:ROYAL CORD THHN 3.5mm2 - RED',price:180,qty:3,unit:'PCS',min:20,brand:'Royal Cord',expected:0},
    {id:'INV010',name:'MECHANICAL:AIR_DUCT_4X10M',price:9000,qty:2,unit:'PCS',min:2,brand:'Greenfield',expected:0},
    {id:'INV011',name:'MECHANICAL:COPPER_TUBE_1/2',price:6500,qty:1,unit:'PCS',min:2,brand:'PipeMaster',expected:0},
    {id:'INV012',name:'MECHANICAL:DUCT_TAPE',price:450,qty:13,unit:'PCS',min:5,brand:'Generic',expected:0},
    {id:'INV013',name:'MECHANICAL:FREON_T32_BIG_BLUE',price:5200,qty:0,unit:'PCS',min:1,brand:'Freon PH',expected:0},
    {id:'INV014',name:'PLUMBING:PVC B Coupling 25mm',price:20,qty:7,unit:'PCS',min:20,brand:'Neltex',expected:0},
    {id:'INV015',name:'PLUMBING:PVC ELBOW 90deg 50mm',price:35,qty:45,reserved:24,unit:'PCS',min:15,brand:'Neltex',expected:0},
    {id:'INV016',name:'PLUMBING:PVC PIPE 2 INCH',price:280,qty:22,reserved:17,unit:'LEN',min:10,brand:'Neltex',expected:0},
    {id:'INV017',name:'PLUMBING:GATE VALVE 3/4',price:450,qty:0,unit:'PCS',min:5,brand:'Brass Co.',expected:0},
    {id:'INV018',name:'CIVIL:CEMENT TYPE I 40KG',price:285,qty:120,reserved:20,unit:'BAGS',min:30,brand:'Holcim',expected:0},
    {id:'INV019',name:'CIVIL:REINFORCING BAR 12MM DEFORMED',price:380,qty:85,unit:'LEN',min:20,brand:'Pag-asa Steel',expected:0},
    {id:'INV020',name:'CIVIL:REINFORCING BAR 16MM DEFORMED',price:680,qty:40,unit:'LEN',min:15,brand:'Pag-asa Steel',expected:0},
    {id:'INV021',name:'CIVIL:CHB 6 INCH',price:22,qty:450,unit:'PCS',min:100,brand:'Local',expected:0},
    {id:'INV022',name:'CIVIL:WELDING ROD 6013',price:950,qty:4,unit:'BOX',min:5,brand:'Lincoln',expected:0},
    {id:'INV023',name:'CIVIL:PLYWOOD 3/4 MARINE',price:1800,qty:18,unit:'SHT',min:8,brand:'Generic',expected:0},
    {id:'INV024',name:'CIVIL:SCAFFOLDING JACK BASE',price:850,qty:12,unit:'PCS',min:6,brand:'SteelTech',expected:0},
    {id:'INV025',name:'FINISHING:PAINT WHITE LATEX 4L',price:550,qty:15,unit:'GAL',min:10,brand:'Davies',expected:0},
    {id:'INV026',name:'CIVIL:SAND',price:3200,qty:10,unit:'per load',min:2,brand:'Local Quarry',expected:0},
    {id:'INV027',name:'CIVIL:GRAVEL 3/4"',price:4500,qty:8,unit:'per cu.m',min:2,brand:'Local Quarry',expected:0},
  ],
  inventory_log: [
    {id:'L001',dt:new Date(Date.now()-3600000).toISOString(),type:'in',itemName:'CIVIL:CEMENT TYPE I 40KG',qtyChange:50,balanceAfter:120,remarks:'From: Holcim. Regular delivery'},
    {id:'L002',dt:new Date(Date.now()-7200000).toISOString(),type:'ticket',itemName:'ELECTRICAL:EMT STRAIGHT_CONNECTOR 1/2',qtyChange:-20,balanceAfter:342,remarks:'Ticket #TKT001 - 3F Hallway'},
    {id:'L003',dt:new Date(Date.now()-86400000).toISOString(),type:'out',itemName:'CIVIL:REINFORCING BAR 12MM DEFORMED',qtyChange:-15,balanceAfter:85,remarks:'Consumed on site. Project: Phase 2 Foundation'},
    {id:'L004',dt:new Date(Date.now()-172800000).toISOString(),type:'in',itemName:'PLUMBING:PVC PIPE 2 INCH',qtyChange:20,balanceAfter:22,remarks:'From: Neltex Direct'},
    {id:'L005',dt:new Date(Date.now()-259200000).toISOString(),type:'adjust',itemName:'MECHANICAL:FREON_T32_BIG_BLUE',qtyChange:-1,balanceAfter:0,remarks:'Inventory count adjustment'},
  ],
  user_assignments: {
    engineer:{assignedProjectIds:['PROJ001','PROJ002']},
  },
  tickets: [
    {id:'TKT001',no:'ORD-2026-001',pm:'Marco Rivera',project:'Maxicare Pulilan — 3F Renovation',projectId:'PROJ001',urgent:false,dateNeeded:ahead(12),submittedBy:'Marco Rivera',submittedRole:'engineer',engineerName:'Marco Rivera',submittedAt:ts(8,8,30),status:'At PO',inventoryReviewedAt:ts(8,9,0),inventoryReviewedBy:'Danny Pascual',sentToPOAt:ts(8,9,5),remarks:'3F hallway electrical — partial issue from warehouse',bossApproved:false,financeApproved:false,siteLocation:'3F East wing corridor',auditTrail:[{action:'Created',by:'Marco Rivera',at:ts(8,8,30),note:'Material order submitted.'},{action:'Warehouse release',by:'Danny Pascual',at:ts(8,9,0),note:'Released available stock; 20 EMT connectors still need purchase.'},{action:'Sent to PO',by:'Danny Pascual',at:ts(8,9,5),note:'Shortages forwarded to PO Officer.'}],
      materials:[{name:'ELECTRICAL:EMT STRAIGHT_CONNECTOR 1/2',requestedQty:40,unit:'PCS',fulfilledQty:20,remainingQty:20,brand:'Conduit Pro'},{name:'ELECTRICAL:METAL_UTILITY_BOX',requestedQty:10,unit:'PCS',fulfilledQty:10,remainingQty:0,brand:'Greenfield'}]},
    {id:'TKT002',no:'ORD-2026-002',pm:'Ramon dela Cruz',project:'Phase 2 Foundation',projectId:'PROJ004',urgent:true,dateNeeded:ahead(5),submittedBy:'Ramon dela Cruz',submittedAt:ts(3,10,15),status:'Pending Inventory',remarks:'Urgent — rainy season; need cement before weekend',bossApproved:false,financeApproved:false,siteLocation:'Basement footing Grid B',auditTrail:[{action:'Created',by:'Ramon dela Cruz',at:ts(3,10,15),note:'Material order submitted — awaiting inventory review.'}],
      materials:[{name:'CIVIL:CEMENT TYPE I 40KG',requestedQty:20,unit:'BAGS',fulfilledQty:0,remainingQty:20,brand:'Holcim'},{name:'PLUMBING:PVC PIPE 2 INCH',requestedQty:5,unit:'LEN',fulfilledQty:0,remainingQty:5,brand:'Neltex'}]},
    {id:'TKT003',no:'ORD-2026-003',pm:'Jose Cruz',project:'GF Reception Area',projectId:'PROJ005',urgent:false,dateNeeded:ahead(20),submittedBy:'Jose Cruz',submittedAt:ts(14,14,0),status:'Completed',inventoryReviewedAt:ts(14,15,0),inventoryReviewedBy:'Danny Pascual',remarks:'Paint and plywood delivered',bossApproved:false,financeApproved:false,siteLocation:'GF lobby',auditTrail:[{action:'Created',by:'Jose Cruz',at:ts(14,14,0),note:'Material order submitted.'},{action:'Warehouse release',by:'Danny Pascual',at:ts(14,15,0),note:'Fully released from warehouse — no purchase needed.'}],
      materials:[{name:'FINISHING:PAINT WHITE LATEX 4L',requestedQty:8,unit:'GAL',fulfilledQty:8,remainingQty:0,brand:'Davies'},{name:'CIVIL:PLYWOOD 3/4 MARINE',requestedQty:5,unit:'SHT',fulfilledQty:5,remainingQty:0,brand:'Generic'}]},
    {id:'TKT004',no:'ORD-2026-004',pm:'Marco Rivera',project:'Maxicare Pulilan — 3F Renovation',projectId:'PROJ001',urgent:true,dateNeeded:ahead(7),submittedBy:'Marco Rivera',submittedRole:'engineer',engineerName:'Marco Rivera',submittedAt:ts(2,9,0),status:'Pending Override',inventoryReviewedAt:ts(2,9,10),inventoryReviewedBy:'Danny Pascual',sentToPOAt:ts(2,9,12),remarks:'THHN wire — no mobilization billed yet',bossApproved:false,financeApproved:false,siteLocation:'3F electrical room',
      auditTrail:[{action:'Created',by:'Marco Rivera',at:ts(2,9,0),note:'Material order submitted.'},{action:'Warehouse release',by:'Danny Pascual',at:ts(2,9,10),note:'No stock on hand — all items need purchase.'},{action:'Sent to PO',by:'Danny Pascual',at:ts(2,9,12),note:'Forwarded to PO Officer.'},{action:'Entry gate blocked',by:'Liza Mercado',at:ts(2,9,15),note:'Billing gate blocked — no paid invoice for Maxicare Pulilan — 3F Renovation'}],
      materials:[{name:'ELECTRICAL:ROYAL CORD THHN 5.5mm2 - BLACK',requestedQty:10,unit:'PCS',fulfilledQty:0,remainingQty:10,brand:'Royal Cord'}]},
    {id:'TKT005',no:'ORD-2026-005',pm:'Marco Rivera',project:'Smilee Monumento — Interior Fit-out',projectId:'PROJ002',urgent:false,dateNeeded:ahead(10),submittedBy:'Marco Rivera',submittedRole:'engineer',engineerName:'Marco Rivera',submittedAt:ts(1,11,20),status:'Pending Inventory',remarks:'Dental operatory fit-out — PVC rough-in',bossApproved:false,financeApproved:false,siteLocation:'Ground floor, operatory wing',auditTrail:[{action:'Created',by:'Marco Rivera',at:ts(1,11,20),note:'Material order submitted — awaiting inventory review.'}],
      materials:[{name:'PLUMBING:PVC PIPE 2 INCH',requestedQty:12,unit:'LEN',fulfilledQty:0,remainingQty:12,brand:'Neltex'},{name:'PLUMBING:PVC ELBOW 90deg 50mm',requestedQty:24,unit:'PCS',fulfilledQty:0,remainingQty:24,brand:'Neltex'}]},
    {id:'TKT006',no:'ORD-2026-006',pm:'Marco Rivera',project:'Residential Complex Phase 1',projectId:'PROJ003',urgent:false,dateNeeded:ahead(14),submittedBy:'Marco Rivera',submittedRole:'engineer',engineerName:'Marco Rivera',submittedAt:ts(4,8,45),status:'Pending Override',inventoryReviewedAt:ts(4,8,55),inventoryReviewedBy:'Danny Pascual',sentToPOAt:ts(4,9,0),remarks:'Awaiting finance sign-off',bossApproved:true,financeApproved:false,siteLocation:'Tower A, 5F MEP',auditTrail:[{action:'Created',by:'Marco Rivera',at:ts(4,8,45),note:'Material order submitted.'},{action:'Warehouse release',by:'Danny Pascual',at:ts(4,8,55),note:'No stock — forwarded entire order to PO.'},{action:'Entry gate blocked',by:'Liza Mercado',at:ts(4,9,0),note:'Billing gate blocked — no paid invoice for Residential Complex Phase 1'},{action:'Boss approved',by:'Ricardo Santos',at:ts(3,16,30),note:'Override approved by Ricardo Santos'}],
      materials:[{name:'ELECTRICAL:GT_CONDUIT_HANGER 3/4',requestedQty:80,unit:'PCS',fulfilledQty:0,remainingQty:80,brand:'Generic'}]},
  ],
  purchase_orders: [
    {id:'PO001',no:'RS2026_0041',vendor:'Conduit Pro Supply Co.',supplierId:'SUP001',project:'Maxicare Pulilan — 3F Renovation',pm:'Jose Cruz',date:ago(6),terms:30,dueDate:ahead(24),status:'Pending',remarks:'Rush order — 3F electrical',
      items:[
        {desc:'EMT Straight Connector 1/2"',qty:200,unit:'PCS',unitPrice:13.50,project:'Maxicare Pulilan — 3F Renovation',whOrderNo:'MAY_005'},
        {desc:'EMT Coupling 1/2"',qty:150,unit:'PCS',unitPrice:13.50,project:'Maxicare Pulilan — 3F Renovation',whOrderNo:'MAY_005'},
      ],createdBy:'Benito Navarro'},
    {id:'PO002',no:'RS2026_0040',vendor:'Holcim Philippines Inc.',supplierId:'SUP002',project:'Phase 2 Foundation',pm:'Ramon dela Cruz',date:ago(12),terms:60,dueDate:ahead(48),status:'Received',remarks:'Cement batch delivered',
      items:[{desc:'Cement Type I 40KG',qty:100,unit:'BAGS',unitPrice:275,project:'Phase 2 Foundation',whOrderNo:'GV_P2'}],createdBy:'Benito Navarro'},
    {id:'PO003',no:'RS2026_0039',vendor:'Pag-asa Steel Corp.',supplierId:'SUP003',project:'Phase 2 Foundation',pm:'Ramon dela Cruz',date:ago(4),terms:45,dueDate:ahead(41),status:'Pending',remarks:'Confirm rebar diameter before delivery',
      items:[
        {desc:'Deformed Bar 12mm x 6m',qty:50,unit:'LEN',unitPrice:370,project:'Phase 2 Foundation',whOrderNo:'GV_P2'},
        {desc:'Deformed Bar 16mm x 6m',qty:20,unit:'LEN',unitPrice:665,project:'Phase 2 Foundation',whOrderNo:'GV_P2'},
      ],createdBy:'Benito Navarro'},
    {id:'PO004',no:'RS2026_0038',vendor:'Davies Paints PH',supplierId:'SUP004',project:'GF Reception Area',pm:'Jose Cruz',date:ago(18),terms:30,dueDate:ahead(12),status:'Approved',remarks:'Paint for GF reception',
      items:[{desc:'White Latex Paint 4L',qty:20,unit:'GAL',unitPrice:540,project:'GF Reception Area',whOrderNo:'MCH_GF'}],createdBy:'Benito Navarro'},
  ],
  billing_records: [
    {id:'BL001',company:'GreenVista Development Corp.',project:'Residential Complex Phase 1',projectId:'PROJ003',contractAmount:12500000,taxType:'VAT',ewtRate:2,tin:'123-456-789-000',status:'active',createdAt:ago(120)},
    {id:'BL002',company:'Metro Commercial Holdings Inc.',project:'Office Tower Interior Fit-out',projectId:null,projectIdNote:'No matching project found in DB.projects.',contractAmount:8750000,taxType:'VAT',ewtRate:2,tin:'987-654-321-000',status:'active',createdAt:ago(90)},
    {id:'BL003',company:'Quezon City LGU',project:'Public Market Renovation',projectId:null,projectIdNote:'No matching project found in DB.projects.',contractAmount:5000000,taxType:'NON-VAT',ewtRate:0,tin:'000-000-000-LGU',status:'active',createdAt:ago(60)},
    {id:'BL004',company:'Maxicare Healthcare Corp.',project:'Maxicare Pulilan — 3F Renovation',projectId:'PROJ001',contractAmount:8500000,taxType:'VAT',ewtRate:2,tin:'555-666-777-000',status:'active',createdAt:ago(45)},
    {id:'BL005',company:'Smilee Dental Group',project:'Smilee Monumento — Interior Fit-out',projectId:'PROJ002',contractAmount:4200000,taxType:'VAT',ewtRate:2,tin:'888-999-000-000',status:'active',createdAt:ago(30)},
  ],
  billing_invoices: [
    {id:'BI001',recordId:'BL001',invoiceNo:'INV-001',invoiceDate:ago(75),dueDate:ago(45),desc:'15% Mobilization Fee',baseAmount:1875000,ewtRate:2,dedAmt:0,status:'Paid',paidDate:ago(50)},
    {id:'BI002',recordId:'BL001',invoiceNo:'INV-002',invoiceDate:ago(50),dueDate:ago(20),desc:'25% Progress Billing - Structural Works',baseAmount:3125000,ewtRate:2,dedAmt:0,status:'Paid',paidDate:ago(22)},
    {id:'BI003',recordId:'BL001',invoiceNo:'INV-003',invoiceDate:ago(15),dueDate:ahead(15),desc:'20% Progress Billing - MEP Rough-in',baseAmount:2500000,ewtRate:2,dedAmt:25000,status:'Unpaid',paidDate:''},
    {id:'BI004',recordId:'BL002',invoiceNo:'INV-001',invoiceDate:ago(60),dueDate:ago(30),desc:'30% Downpayment',baseAmount:2625000,ewtRate:2,dedAmt:0,status:'Paid',paidDate:ago(32)},
    {id:'BI005',recordId:'BL002',invoiceNo:'INV-002',invoiceDate:ago(25),dueDate:ahead(5),desc:'30% Progress - Partition Works',baseAmount:2625000,ewtRate:2,dedAmt:0,status:'Unpaid',paidDate:''},
    {id:'BI006',recordId:'BL003',invoiceNo:'INV-001',invoiceDate:ago(40),dueDate:ago(10),desc:'50% Mobilization & Site Clearing',baseAmount:2500000,ewtRate:0,dedAmt:0,status:'Paid',paidDate:ago(12)},
    {id:'BI007',recordId:'BL004',invoiceNo:'INV-001',invoiceDate:ago(20),dueDate:ahead(10),desc:'20% Mobilization',baseAmount:1700000,ewtRate:2,dedAmt:0,status:'Unpaid',paidDate:''},
    {id:'BI008',recordId:'BL005',invoiceNo:'INV-001',invoiceDate:ago(18),dueDate:ahead(12),desc:'30% Downpayment',baseAmount:1260000,ewtRate:2,dedAmt:0,status:'Paid',paidDate:ago(14)},
    {id:'BI009',recordId:'BL005',invoiceNo:'INV-002',invoiceDate:ago(5),dueDate:ahead(25),desc:'20% Progress - Rough-in',baseAmount:840000,ewtRate:2,dedAmt:0,status:'Unpaid',paidDate:''},
  ],
  subcontractors: [
    {id:'SC001',name:'Mendoza Electrical Works',trade:'Electrical',contractAmount:2800000,project:'Residential Complex Phase 1',contact:'Joven Mendoza - 09171234567',
      billings:[{id:'SB001',date:'2025-03-01',desc:'Rough-in wiring 3F-5F',amount:840000,status:'Paid'},{id:'SB002',date:'2025-04-15',desc:'Panel board installation',amount:560000,status:'Unpaid'}],
      deductions:[{id:'SD001',date:'2025-03-15',desc:'Materials advance deduction',amount:150000}]},
    {id:'SC002',name:'Rivera Plumbing Systems',trade:'Plumbing',contractAmount:1500000,project:'Residential Complex Phase 1',contact:'Ronnie Rivera - 09281234567',
      billings:[{id:'SB003',date:'2025-02-20',desc:'Water line rough-in',amount:450000,status:'Paid'},{id:'SB004',date:'2025-04-01',desc:'Drain line & fixtures',amount:300000,status:'Paid'}],
      deductions:[]},
    {id:'SC003',name:'ABC Concrete Specialists',trade:'Civil / Structural',contractAmount:4200000,project:'Phase 2 Foundation',contact:'Antonio Bautista - 09181234567',
      billings:[{id:'SB005',date:'2025-04-10',desc:'Footing & column concrete pour',amount:1260000,status:'Unpaid'}],
      deductions:[{id:'SD002',date:'2025-04-10',desc:'Retention 10%',amount:126000}]},
  ],
  expenses: [
    {id:'EX001',date:ago(7),category:'Materials',payee:'Holcim Philippines',sino:'SI-4521',project:'Phase 2 Foundation',particulars:'Cement 50 Bags',amount:14250,paymentType:'Check',status:'Released',remarks:''},
    {id:'EX002',date:ago(6),category:'Labor',payee:'RSCI Payroll',sino:'',project:'Maxicare Pulilan — 3F Renovation',particulars:'Weekly labor - 10 workers',amount:35000,paymentType:'Cash',status:'Released',remarks:'Week ending'},
    {id:'EX003',date:ago(5),category:'Equipment',payee:'PowerTool Rentals Inc.',sino:'OR-1892',project:'Phase 2 Foundation',particulars:'Scaffold rental 2 weeks',amount:12500,paymentType:'Bank Transfer',status:'Released',remarks:''},
    {id:'EX004',date:ago(4),category:'Professional Fees',payee:'Arch. David Sarmiento',sino:'OR-305',project:'GF Reception Area',particulars:'Design consultation',amount:25000,paymentType:'Check',status:'Pending',remarks:''},
    {id:'EX005',date:ago(3),category:'Transportation',payee:'Logistics Express',sino:'OR-8821',project:'Phase 2 Foundation',particulars:'Rebar delivery - Pag-asa to site',amount:8500,paymentType:'Cash',status:'Released',remarks:''},
  ],
  vendors: [
    {id:'V001',name:'Conduit Pro Supply Co.',tin:'111-222-333-000',address:'Quezon Avenue, QC'},
    {id:'V002',name:'Holcim Philippines Inc.',tin:'444-555-666-000',address:'Makati City'},
  ],
  system_logs: [
    {id:'SL001',dt:ts(0,8,0),user:'Liza Mercado',action:'Billing gate',entity:'TKT-2026-004',details:'PO conversion blocked — Pending Override',status:'success'},
    {id:'SL002',dt:ts(3,16,30),user:'Ricardo Santos',action:'Override approved',entity:'TKT-2026-006',details:'Boss approval recorded',status:'success'},
    {id:'SL003',dt:ts(1,14,0),user:'Benito Navarro',action:'PO approved',entity:'RS2026_0041',details:'Pending PO sent to vendor',status:'success'},
  ],
  notifications: [
    {id:'N001',dt:ts(0,7,30),type:'orange',title:'Override needed',text:'TKT-2026-004 blocked at billing gate — Boss & Finance approval required.',roles:['boss','accountant','po_officer'],source:'billing-gate'},
    {id:'N005',dt:ts(3,10,20),type:'blue',title:'New material order',text:'ORD-2026-002 from Ramon dela Cruz — Phase 2 Foundation. Review warehouse stock first.',roles:['inventory_manager','po_officer'],source:'material-order'},
    {id:'N006',dt:ts(8,9,10),type:'orange',title:'Purchase needed',text:'ORD-2026-001 — shortages after warehouse release. Create PO for remaining items.',roles:['po_officer'],source:'material-order'},
    {id:'N002',dt:ts(1,11,25),type:'blue',title:'New engineer request',text:'Marco Rivera submitted TKT-2026-005 for Smilee Monumento.',roles:['po_officer','admin'],source:'ticket'},
    {id:'N003',dt:ts(3,16,35),type:'green',title:'Boss approved override',text:'TKT-2026-006 awaiting Finance approval.',roles:['accountant'],source:'override'},
    {id:'N004',dt:ts(0,6,0),type:'red',title:'Low stock alert',text:'3 inventory items at or below minimum.',roles:['inventory_manager','admin'],source:'inventory'},
  ],
  po_release_queue: [],
  release_monitors: [
    {id:'RM001',projectId:'PROJ001',projectName:'Maxicare Pulilan — 3F Renovation',ticketId:'TKT001',orderRef:'ORD-2026-001',pm:'Marco Rivera',siteLocation:'3F East wing corridor',remarks:'3F hallway electrical',status:'partial',createdAt:ts(8,8,30),createdBy:'Marco Rivera'},
    {id:'RM002',projectId:'PROJ004',projectName:'Phase 2 Foundation',ticketId:'TKT002',orderRef:'ORD-2026-002',pm:'Ramon dela Cruz',siteLocation:'Basement footing Grid B',remarks:'Urgent cement order',status:'ongoing',createdAt:ts(3,10,15),createdBy:'Ramon dela Cruz'},
    {id:'RM003',projectId:'PROJ002',projectName:'Smilee Monumento — Interior Fit-out',ticketId:'TKT005',orderRef:'ORD-2026-005',pm:'Marco Rivera',siteLocation:'Ground floor, operatory wing',remarks:'PVC rough-in',status:'ongoing',createdAt:ts(1,11,20),createdBy:'Marco Rivera'},
    {id:'RM004',projectId:'PROJ003',projectName:'Residential Complex Phase 1',ticketId:null,orderRef:null,pm:'Marco Rivera',siteLocation:'Tower A equipment yard',remarks:'Tool tracking — scaffolding & jacks',status:'partial',createdAt:ts(10,9,0),createdBy:'Danny Pascual'},
  ],
  release_items: [
    {id:'RI001',monitorId:'RM001',ticketId:'TKT001',itemName:'ELECTRICAL:EMT STRAIGHT_CONNECTOR 1/2',inventoryId:'INV001',reservedQty:40,releasedQty:20,unit:'PCS',status:'Partially Released',createdAt:ts(8,8,30)},
    {id:'RI002',monitorId:'RM001',ticketId:'TKT001',itemName:'ELECTRICAL:METAL_UTILITY_BOX',inventoryId:'INV007',reservedQty:10,releasedQty:10,unit:'PCS',status:'Released All',createdAt:ts(8,8,30)},
    {id:'RI003',monitorId:'RM002',ticketId:'TKT002',itemName:'CIVIL:CEMENT TYPE I 40KG',inventoryId:'INV018',reservedQty:20,releasedQty:0,unit:'BAGS',status:'Reserved',createdAt:ts(3,10,15)},
    {id:'RI004',monitorId:'RM002',ticketId:'TKT002',itemName:'PLUMBING:PVC PIPE 2 INCH',inventoryId:'INV016',reservedQty:5,releasedQty:0,unit:'LEN',status:'Reserved',createdAt:ts(3,10,15)},
    {id:'RI005',monitorId:'RM003',ticketId:'TKT005',itemName:'PLUMBING:PVC PIPE 2 INCH',inventoryId:'INV016',reservedQty:12,releasedQty:0,unit:'LEN',status:'Reserved',createdAt:ts(1,11,20)},
    {id:'RI006',monitorId:'RM003',ticketId:'TKT005',itemName:'PLUMBING:PVC ELBOW 90deg 50mm',inventoryId:'INV015',reservedQty:24,releasedQty:0,unit:'PCS',status:'Reserved',createdAt:ts(1,11,20)},
    {id:'RI007',monitorId:'RM004',ticketId:null,itemName:'CIVIL:SCAFFOLDING JACK BASE',inventoryId:'INV024',reservedQty:6,releasedQty:4,unit:'PCS',status:'Partially Released',createdAt:ts(10,9,0)},
    {id:'RI008',monitorId:'RM004',ticketId:null,itemName:'CIVIL:WELDING ROD 6013',inventoryId:'INV022',reservedQty:2,releasedQty:2,unit:'BOX',status:'Released All',createdAt:ts(10,9,0)},
  ],
  pullout_records: [
    {id:'PU001',releaseItemId:'RI007',monitorId:'RM004',itemName:'CIVIL:SCAFFOLDING JACK BASE',projectName:'Residential Complex Phase 1',qty:4,pulloutDate:ts(8,7,30),pulledBy:'Ramon dela Cruz',returned:false,returnDate:null,remarks:'Tower A exterior scaffold'},
    {id:'PU002',releaseItemId:'RI008',monitorId:'RM004',itemName:'CIVIL:WELDING ROD 6013',projectName:'Residential Complex Phase 1',qty:2,pulloutDate:ts(9,8,0),pulledBy:'Site Welder Team',returned:true,returnDate:ts(5,16,0),remarks:'Structural tie-ins — returned unused'},
  ],
  };
}
let DB = cloneInitialDB();

// ── INIT ──────────────────────────────────────────────────────
function buildDatalist() {
  loadDB();
  initLandingBindings();
  // item datalist
  const dl = document.getElementById('item-datalist');
  if(dl) dl.innerHTML = DB.inventory.map(i=>`<option value="${esc(i.name)}">`).join('');
  // project datalists
  document.querySelectorAll('[id$="-project-datalist"], [id="project-datalist"]').forEach(el=>{
    el.innerHTML = DB.projects.map(p=>`<option value="${esc(p.name)}">`).join('');
  });
  // supplier datalists
  document.querySelectorAll('[id*="supplier-datalist"]').forEach(el=>{
    el.innerHTML = DB.suppliers.map(s=>`<option value="${esc(s.name)}">`).join('');
  });
  // subcontractor project datalist
  const scdl = document.getElementById('sc-project-datalist');
  if(scdl) scdl.innerHTML = DB.projects.map(p=>`<option value="${esc(p.name)}">`).join('');
  // billing project datalist
  const bldl = document.getElementById('bl-project-datalist');
  if(bldl) bldl.innerHTML = DB.projects.map(p=>`<option value="${esc(p.name)}">`).join('');
  // expense project datalist
  const exdl = document.getElementById('exp-project-datalist');
  if(exdl) exdl.innerHTML = DB.projects.map(p=>`<option value="${esc(p.name)}">`).join('');
  // inventory log project filter
  const logProjectFilter = document.getElementById('log-project-filter');
  if(logProjectFilter) logProjectFilter.innerHTML = `<option value="">All Projects</option>` + DB.projects.map(p=>`<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
  initDemoLoginUI();
}

function initLandingBindings() {
  const rolePicker = document.getElementById('role-picker');
  if(rolePicker) {
    rolePicker.querySelectorAll('.rp-btn').forEach(btn=>{
      if(btn.dataset.boundRole) return;
      btn.addEventListener('click', (e)=>{ e.preventDefault(); pickRole(btn); });
      btn.dataset.boundRole = '1';
    });
  }
  const demo = document.getElementById('demo-mode');
  if(demo && !demo.dataset.boundDemo) {
    demo.addEventListener('change', onDemoToggle);
    demo.dataset.boundDemo = '1';
  }
  const loginBtn = document.getElementById('login-btn');
  if(loginBtn && !loginBtn.dataset.boundLogin) {
    loginBtn.addEventListener('click', (e)=>{ e.preventDefault(); doLogin(); });
    loginBtn.dataset.boundLogin = '1';
  }
  const pass = document.getElementById('login-pass');
  if(pass && !pass.dataset.boundEnter) {
    pass.addEventListener('keydown', (e)=>{ if(e.key==='Enter') doLogin(); });
    pass.dataset.boundEnter = '1';
  }
}

// ── AUTH ──────────────────────────────────────────────────────
let _selectedRole = 'admin';

function pickRole(btn) {
  document.querySelectorAll('.rp-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  _selectedRole = btn.dataset.role;
  if(document.getElementById('demo-mode')?.checked) {
    const u = DEMO_USERS[_selectedRole];
    if(u) document.getElementById('login-email').value = u.email;
  }
}

function onDemoToggle() {
  const enabled = document.getElementById('demo-mode')?.checked;
  const pass = document.getElementById('login-pass');
  const hint = document.getElementById('demo-pass-hint');
  if(enabled) {
    const u = DEMO_USERS[_selectedRole];
    if(u) document.getElementById('login-email').value = u.email;
    if(pass) pass.value = DEMO_PASSWORD;
  } else {
    document.getElementById('login-email').value = '';
    if(pass) pass.value = '';
  }
  if(hint) hint.style.display = enabled ? 'block' : 'none';
}

function doLogin() {
  const err = document.getElementById('login-err');
  const demoOn = document.getElementById('demo-mode')?.checked;
  const pass = (document.getElementById('login-pass')?.value || '').trim();
  if(demoOn && pass !== DEMO_PASSWORD) {
    if(err) err.textContent = `Use demo password: ${DEMO_PASSWORD}`;
    return;
  }
  if(err) err.textContent = '';
  try {
    sessionStorage.setItem('rsci_demo_session', demoOn ? '1' : '0');
  } catch(e) {}
  const btn = document.getElementById('login-btn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  setTimeout(()=>{
    _currentUser = mergeUserAssignments(_selectedRole, {...DEMO_USERS[_selectedRole]});
    btn.disabled = false; btn.textContent = 'Sign In';
    setupApp();
  }, 600);
}

function doLogout() {
  _currentUser = null;
  document.getElementById('screen-app').style.display = 'none';
  document.getElementById('screen-landing').style.display = 'block';
}

// ── NAV DEFINITIONS ───────────────────────────────────────────
const NAV_DEFS = {
  admin: [
    {section:'Overview'},
    {label:'Dashboard',      page:'acc-dashboard',    icon:'<path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/>'},
    {section:'Projects & People'},
    {label:'Projects',       page:'projects',         icon:'<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"/>'},
    {label:'Subcontractors', page:'acc-subcon',       icon:'<path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3z"/>'},
    {section:'Procurement'},
    {label:'P.O. Inbox',     page:'acc-po-inbox',     icon:'<path d="M19 3H5c-1.1 0-2 .9-2 2v14l4-4h12c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>'},
    {label:'Suppliers',      page:'suppliers',        icon:'<path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z"/>'},
    {section:'Finance'},
    {label:'Billing',        page:'billing-list',     icon:'<path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/>'},
    {label:'Expenses',       page:'acc-expenses',     icon:'<path d="M20 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z"/>'},
    {label:'Exp. by Project', page:'expenses-report', icon:'<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>'},
    {section:'Operations'},
    {label:'Ticket History',  page:'acc-history',     icon:'<path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>'},
    {label:'Activity Log',    page:'admin-logs',      icon:'<path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11z"/>'},
    {label:'Inventory',       page:'inv-dashboard',   icon:'<path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/>'},
  ],
  accountant: [
    {section:'Overview'},
    {label:'Dashboard',      page:'acc-dashboard',    icon:'<path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/>'},
    {section:'Procurement'},
    {label:'P.O. Inbox',     page:'acc-po-inbox',     icon:'<path d="M19 3H5c-1.1 0-2 .9-2 2v14l4-4h12c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>'},
    {section:'Finance'},
    {label:'Billing',        page:'billing-list',     icon:'<path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/>'},
    {label:'Expenses',       page:'acc-expenses',     icon:'<path d="M20 4H4c-1.11 0-2 .89-2 2v12c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z"/>'},
    {label:'Exp. by Project', page:'expenses-report', icon:'<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>'},
    {label:'Subcontractors', page:'acc-subcon',       icon:'<path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3z"/>'},
  ],
  po_officer: [
    {section:'Overview'},
    {label:'Dashboard',      page:'po-dashboard',     icon:'<path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/>', badge:'po-orders'},
    {section:'Procurement'},
    {label:'My POs',         page:'req-dashboard',    icon:'<path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/>'},
    {label:'Create P.O.',    page:'po-new-po',        icon:'<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>'},
    {section:'Master Data'},
    {label:'Suppliers',      page:'suppliers',        icon:'<path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z"/>'},
  ],
  engineer: [
    {section:'Overview'},
    {label:'Requests',       page:'emp-dashboard',    icon:'<path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/>'},
    {label:'New Request',    page:'emp-new-ticket',   icon:'<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>'},
  ],
  inventory_manager: [
    {label:'Dashboard',      page:'inv-dashboard',    icon:'<path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/>'},
    {label:'Material Orders',page:'inv-orders',       icon:'<path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>', badge:'inv-orders'},
    {label:'All Inventory',  page:'inv-all',          icon:'<path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/>'},
    {label:'Stock In',       page:'inv-stock-in',     icon:'<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>'},
    {label:'Stock Out',      page:'inv-stock-out',    icon:'<path d="M19 13H5v-2h14v2z"/>'},
    {label:'Release Monitor',page:'inv-release',      icon:'<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM9 17H7v-7h2v7zm4 0h-2V7h2v10zm4 0h-2v-4h2v4z"/>'},
    {label:'Pull-Out Monitor',page:'inv-pullout',     icon:'<path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2z"/>'},
    {label:'Movement Log',   page:'inv-log',          icon:'<path d="M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>'},
  ],
  boss: [
    {section:'Overview'},
    {label:'Dashboard',      page:'boss-dashboard',        icon:'<path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/>'},
    {label:'Override Queue', page:'boss-override-queue',   icon:'<path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>', badge:'override-pend'},
    {section:'View Only'},
    {label:'Projects',       page:'boss-projects',         icon:'<path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"/>'},
    {label:'PO List',        page:'boss-po-list',          icon:'<path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6z"/>'},
    {label:'Billing Summary',page:'boss-billing',          icon:'<path d="M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z"/>'},
  ],
};

// ── APP SETUP ─────────────────────────────────────────────────
let currentPage = '';

function setupApp() {
  const u = _currentUser;
  document.getElementById('screen-landing').style.display = 'none';
  document.getElementById('screen-app').style.display = 'block';

  document.getElementById('sb-uname').textContent  = u.name;
  document.getElementById('sb-urole').textContent  = u.role.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
  document.getElementById('sb-badge').textContent  = u.role.replace(/_/g,' ').toUpperCase();
  document.getElementById('sb-avatar').textContent = u.initials;
  document.getElementById('tb-user').textContent   = u.name;

  // Build sidebar nav
  const nav = document.getElementById('sb-nav');
  const defs = NAV_DEFS[u.role] || NAV_DEFS.po_officer;
  nav.innerHTML = defs.map(n=>{
    if(n.section) return `<div class="sb-nav-section">${n.section}</div>`;
    return `<button class="nb" data-page="${n.page}" onclick="navigate('${n.page}',this)">
      <svg viewBox="0 0 24 24">${n.icon}</svg>${n.label}
      ${n.badge==='po-pend'?`<span class="nb-badge" id="nb-po-pend">${DB.purchase_orders.filter(p=>p.status==='Pending').length||''}</span>`:''}
      ${n.badge==='override-pend'?`<span class="nb-badge" id="nb-override-pend">${getPendingOverrideTickets().length||''}</span>`:''}
      ${n.badge==='inv-orders'?`<span class="nb-badge" id="nb-inv-orders">${getTicketsPendingInventory().length||''}</span>`:''}
      ${n.badge==='po-orders'?`<span class="nb-badge" id="nb-po-orders">${getTicketsForPOOfficer().length||''}</span>`:''}
    </button>`;
  }).join('');

  buildDatalist();
  updateInvPill();
  buildNotifications();
  showDemoPresentBar();

  // Navigate to default page
  const defaults = {
    admin:'acc-dashboard',accountant:'acc-dashboard',po_officer:'po-dashboard',
    inventory_manager:'inv-dashboard', engineer:'emp-dashboard', boss:'boss-dashboard'
  };
  updateOrderNavBadges();
  navigate(defaults[u.role] || 'po-dashboard', null);
}

// ── NAVIGATION ────────────────────────────────────────────────
function navigate(page, btn) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nb').forEach(b=>b.classList.remove('active'));

  const pageEl = document.getElementById('page-'+page);
  if(pageEl) pageEl.classList.add('active');
  if(btn) btn.classList.add('active');
  else { const b=document.querySelector(`[data-page="${page}"]`); if(b) b.classList.add('active'); }
  currentPage = page;

  const titles = {
    'emp-dashboard':'My Tickets','emp-new-ticket':'Submit a Ticket','emp-ticket-detail':'Ticket Details',
    'acc-dashboard':'Main Dashboard','acc-po-inbox':'P.O. Inbox','acc-po-detail':'P.O. Details',
    'acc-history':'Ticket History','acc-subcon':'Subcontractors','acc-expenses':'General Expenses',
    'admin-logs':'System Activity Log','billing-list':'Customer Billing','billing-detail':'Billing Detail',
    'req-dashboard':'My Purchase Orders','req-new-po':'Create Purchase Order',
    'po-dashboard':'PO Officer Dashboard','po-new-po':'Create Purchase Order',
    'inv-dashboard':'Inventory Dashboard','inv-orders':'Material Orders','inv-all':'All Inventory',
    'inv-stock-in':'Stock In','inv-stock-out':'Stock Out','inv-release':'Release Monitoring','inv-pullout':'Pull-Out Monitoring','inv-log':'Movement Log',
    'projects':'Awarded Projects','suppliers':'Suppliers / Vendors','expenses-report':'Expenses by Project',
    'boss-dashboard':'Executive Dashboard','boss-override-queue':'Override Queue',
    'boss-projects':'Awarded Projects','boss-po-list':'Purchase Orders','boss-billing':'Billing Summary',
  };
  if(_currentUser?.role==='engineer') {
    titles['emp-dashboard']='Engineer Requests';
    titles['emp-new-ticket']='New Material Request';
    titles['emp-ticket-detail']='Request Details';
  }
  document.getElementById('tb-title').textContent = titles[page] || page.replace(/-/g,' ').toUpperCase();
  window.scrollTo(0,0);
  closeSidebar();

  if(page==='emp-dashboard')   renderEmpDashboard();
  if(page==='emp-new-ticket')  initNewTicket();
  if(page==='acc-dashboard')   renderAccDashboard();
  if(page==='acc-po-inbox')    poRenderInbox();
  if(page==='acc-history')     initHistory();
  if(page==='admin-logs')      initActivityLog();
  if(page==='acc-subcon')      renderSubcon();
  if(page==='acc-expenses')    expRenderList();
  if(page==='billing-list')    blRenderList();
  if(page==='req-dashboard')   renderReqDashboard();
  if(page==='req-new-po')      initPOForm('req-po-form-wrap');
  if(page==='po-dashboard')    renderPODashboard();
  if(page==='po-new-po')       initPOForm('po-officer-form-wrap');
  if(page==='inv-dashboard')   renderDashboard();
  if(page==='inv-orders')      renderInvOrdersList();
  if(page==='inv-all')         renderInventoryTable();
  if(page==='inv-log')         renderLog();
  if(page==='inv-release')     renderReleaseMonitor();
  if(page==='inv-pullout')     renderPulloutMonitor();
  if(page==='inv-stock-in')    { document.getElementById('si-date').value=today(); if(isDemoSession()) prefillStockInDemo(); }
  if(page==='inv-stock-out')   { document.getElementById('so-date').value=today(); }
  if(page==='projects')        { projectsGoTab('list', document.querySelector('#projects-tab-nav .exp-sub-btn')); renderProjectsList(); }
  if(page==='suppliers')       renderSuppliersList();
  if(page==='expenses-report') initExpensesReport();
  if(page==='boss-dashboard')       renderBossDashboard();
  if(page==='boss-override-queue')  renderBossOverrideQueue();
  if(page==='boss-projects')        renderBossProjectsList();
  if(page==='boss-po-list')          renderBossPOList();
  if(page==='boss-billing')         renderBossBillingSummary();
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}
window.addEventListener('resize',()=>{ if(window.innerWidth>768) closeSidebar(); });

// ── TOAST ─────────────────────────────────────────────────────
let _toastTimer;
function toast(msg, type='') {
  const t=document.getElementById('toast');
  const tt=document.getElementById('toast-text');
  tt.textContent = msg.replace(/^(Success|Error|Warning):\s*/,'');
  t.className = 'show' + (type?` toast-${type}`:msg.startsWith('Error')?' toast-err':msg.startsWith('Warning')?' toast-warn':msg.startsWith('Success')?' toast-ok':'');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(()=>t.classList.remove('show'), 3500);
}

// ── MODAL ─────────────────────────────────────────────────────
function openMo(id) { document.getElementById(id)?.classList.add('open'); }
function closeMo(id) { document.getElementById(id)?.classList.remove('open'); }
document.addEventListener('click', e=>{
  if(e.target.classList.contains('mo')) e.target.classList.remove('open');
});

// ── NOTIFICATIONS ─────────────────────────────────────────────
function pushNotification({type='blue',title='',text='',roles=[],source=''}) {
  DB.notifications = DB.notifications || [];
  DB.notifications.unshift({id:uid(),dt:nowISO(),type,title,text,roles,emails:roleEmailsFor(roles),source});
  DB.notifications = DB.notifications.slice(0,40);
}

function buildNotifications() {
  const lowItems = DB.inventory.filter(i=>(i.qty||0)<=(i.min||5));
  const pendPOs  = DB.purchase_orders.filter(p=>p.status==='Pending');
  const overdueInvs = DB.billing_invoices.filter(i=>i.status!=='Paid'&&i.dueDate&&new Date(i.dueDate+'T00:00:00')<new Date());
  // PO due-date alerts
  const duePOs = DB.purchase_orders.filter(p=>p.status!=='Received'&&p.status!=='Cancelled'&&p.dueDate&&dueDateStatus(p.dueDate)!=='ok');

  const systemItems = [];
  if(lowItems.length) systemItems.push({dot:'red',title:'Low stock review',text:`${lowItems.length} item(s) are low or out of stock.`,roles:['admin','accountant','inventory_manager']});
  if(pendPOs.length)  systemItems.push({dot:'blue',title:'PO approval queue',text:`${pendPOs.length} purchase order(s) are pending review.`,roles:['admin','accountant','po_officer']});
  if(overdueInvs.length) systemItems.push({dot:'orange',title:'Overdue billing',text:`${overdueInvs.length} invoice(s) are overdue.`,roles:['admin','accountant']});
  if(duePOs.length)   systemItems.push({dot:'orange',title:'PO payment due',text:`${duePOs.length} PO(s) have payments due soon or overdue.`,roles:['admin','accountant']});
  systemItems.push({dot:'green',title:'Local data mode',text:'System running on local data.',roles:['admin','accountant','po_officer','inventory_manager']});

  const items = [...(DB.notifications||[]),...systemItems];
  const role = _currentUser?.role||'admin';
  const visible = items.filter(n=>!n.roles||n.roles.includes(role)||['admin','accountant'].includes(role));
  document.getElementById('notif-list').innerHTML = visible.length
    ? visible.map(n=>`<div class="notif-item"><div class="notif-item-dot ${n.dot||'blue'}"></div><div style="flex:1;min-width:0;"><div class="notif-item-title">${esc(n.title||'')}</div><div style="line-height:1.5;font-size:12px;">${esc(n.text||'')}</div></div></div>`).join('')
    : '<div style="padding:20px;text-align:center;color:var(--faint);font-size:12px;">No notifications</div>';
}

let _notifOpen = false;
function toggleNotifPanel() {
  const p = document.getElementById('notif-panel');
  _notifOpen = !_notifOpen;
  p.classList.toggle('open', _notifOpen);
  if(_notifOpen) buildNotifications();
}
document.addEventListener('click', e=>{
  if(!e.target.closest('.notif-btn')&&!e.target.closest('.notif-panel')) {
    document.getElementById('notif-panel')?.classList.remove('open');
    _notifOpen = false;
  }
});

// ── INV PILL ──────────────────────────────────────────────────
function updateInvPill() {
  const low = DB.inventory.filter(i=>(i.qty||0)<=(i.min||5));
  const pill = document.getElementById('inv-pill');
  const txt  = document.getElementById('inv-pill-txt');
  if(!pill) return;
  pill.className = 'tb-pill';
  if(!low.length) { pill.classList.add('ok'); txt.textContent='Stock OK'; }
  else if(low.filter(i=>(i.qty||0)===0).length) { pill.classList.add('alert'); txt.textContent=`${low.length} Stock Alert`; }
  else { pill.classList.add('warn'); txt.textContent=`${low.length} Low Stock`; }
}

// ── ACC STATS ─────────────────────────────────────────────────
function updateAccStats() {
  const lo = document.getElementById('acc-low-cnt');   if(lo) lo.textContent=DB.inventory.filter(i=>(i.qty||0)<=(i.min||5)).length;
  const po = document.getElementById('acc-po-cnt');    if(po) po.textContent=DB.purchase_orders.filter(p=>p.status==='Pending').length;
  const tc = document.getElementById('acc-ticket-cnt');if(tc) tc.textContent=DB.tickets.filter(t=>t.status==='Pending Inventory'||t.status==='At PO').length;
  const bv = document.getElementById('acc-billed-val');
  if(bv) {
    const tot=DB.billing_invoices.reduce((s,i)=>s+(parseFloat(i.baseAmount)||0),0);
    bv.textContent=tot>=1000000?`₱${(tot/1000000).toFixed(1)}M`:`₱${(tot/1000).toFixed(0)}K`;
    bv.style.fontSize='18px';
  }
  // Update sidebar PO badge
  const nb = document.getElementById('nb-po-pend');
  if(nb) nb.textContent = DB.purchase_orders.filter(p=>p.status==='Pending').length || '';
}

// ── ACC DASHBOARD ─────────────────────────────────────────────
function renderAccDashboard() {
  updateAccStats();
  const el=document.getElementById('acc-datetime');
  if(el) el.textContent=new Date().toLocaleDateString('en-PH',{weekday:'long',year:'numeric',month:'long',day:'numeric'});

  const cols=document.getElementById('acc-dash-cols');
  if(!cols) return;
  const pendPOs  = DB.purchase_orders.filter(p=>p.status==='Pending');
  const partTkts = DB.tickets.filter(t=>t.status==='Pending Inventory'||t.status==='At PO'||t.status==='Partial');
  const lowStock = DB.inventory.filter(i=>(i.qty||0)<=(i.min||5)).slice(0,6);
  // Due date alerts for non-received POs
  const duePOs   = DB.purchase_orders.filter(p=>p.status!=='Received'&&p.status!=='Cancelled'&&p.dueDate&&dueDateStatus(p.dueDate)!=='ok').slice(0,5);

  cols.innerHTML = `
    <div class="dash-widget">
      <div class="dash-widget-head"><div class="dash-widget-title" style="color:var(--bl);">📋 Incoming P.O.s</div><span class="badge badge-partial">${pendPOs.length}</span></div>
      <div class="dash-widget-body no-pad">
        ${!pendPOs.length?'<div class="empty-state"><div class="empty-icon">✓</div>No pending POs</div>':
          pendPOs.map(p=>`<div class="alert-row" onclick="openPODetail('${p.id}')" style="cursor:pointer;">
            <div style="flex:1;"><div style="font-weight:700;font-size:12px;">${p.no}</div><div style="font-size:11px;color:var(--faint);">${p.vendor}</div></div>
            <div style="text-align:right;"><div style="font-size:11px;color:var(--soft);">${fmtDate(p.date)}</div>
            ${p.dueDate?`<div class="due-tag ${dueDateStatus(p.dueDate)}" style="font-size:9.5px;padding:2px 6px;">Due ${fmtDate(p.dueDate)}</div>`:''}
            </div></div>`).join('')}
      </div>
    </div>
    <div class="dash-widget">
      <div class="dash-widget-head"><div class="dash-widget-title" style="color:var(--or);">🎫 Pending Tickets</div><span class="badge badge-unpaid">${partTkts.length}</span></div>
      <div class="dash-widget-body no-pad">
        ${!partTkts.length?'<div class="empty-state"><div class="empty-icon">✓</div>All tickets processed</div>':
          partTkts.map(t=>`<div class="alert-row" style="cursor:pointer;">
            <div style="flex:1;"><div style="font-weight:700;font-size:12px;">${t.no} ${t.urgent?'<span class="badge badge-urgent" style="font-size:9px;">URGENT</span>':''}</div>
            <div style="font-size:11px;color:var(--faint);">${t.project}</div></div>
            <span class="badge badge-${statusBadgeClass(t.status)}">${t.status}</span></div>`).join('')}
      </div>
    </div>
    <div class="dash-widget">
      <div class="dash-widget-head"><div class="dash-widget-title" style="color:var(--rd);">⚠ Low Stock Alerts</div><span class="badge badge-out">${lowStock.length}</span></div>
      <div class="dash-widget-body no-pad">
        ${!lowStock.length?'<div class="empty-state"><div class="empty-icon">✓</div>All items stocked</div>':
          lowStock.map(i=>{const s=stockStatus(i);return `<div class="alert-row"><div class="alert-item-name">${i.name.split(':').pop()}</div><span class="badge badge-${s.cls}" style="font-size:9.5px;">${i.qty} ${i.unit}</span></div>`}).join('')}
        ${duePOs.length?`<div style="border-top:1px solid var(--bd);margin-top:4px;padding:10px 14px 4px;font-size:10px;font-weight:700;color:var(--or);text-transform:uppercase;letter-spacing:.5px;">💳 Payment Reminders</div>`+''+duePOs.map(p=>{const ds=dueDateStatus(p.dueDate);return `<div class="alert-row"><div style="flex:1;font-size:11.5px;font-weight:600;">${p.no} – ${p.vendor}</div><span class="due-tag ${ds}" style="font-size:9.5px;padding:2px 6px;">${ds==='overdue'?'OVERDUE':'Due '+fmtDate(p.dueDate)}</span></div>`}).join(''):''}
      </div>
    </div>`;

  const billingGateSec=document.getElementById('acc-dash-billing-gate');
  if(billingGateSec) billingGateSec.innerHTML=buildBillingGateDashboardHTML();

  const overrideSec=document.getElementById('acc-dash-override-section');
  if(overrideSec) overrideSec.innerHTML=buildOverrideQueueHTML('finance', {compact:false, showViewAll:true});
}

// ── MATERIAL TICKETS ──────────────────────────────────────────
function renderEmpDashboard() {
  const el=document.getElementById('emp-ticket-list');
  if(!el) return;
  const myTickets=_currentUser?.role==='engineer'
    ? DB.tickets.filter(t=>t.submittedRole==='engineer'||t.submittedBy===_currentUser?.name)
    : DB.tickets;
  if(!myTickets.length) { el.innerHTML='<div class="empty-state"><div class="empty-icon">📋</div>No tickets submitted yet.</div>'; return; }
  el.innerHTML=myTickets.map(t=>`
    <div class="ticket-row" onclick="viewTicketDetail('${t.id}')">
      <div><div class="ticket-no">${t.no} ${t.urgent?'<span class="badge badge-urgent" style="font-size:9px;">URGENT</span>':''}</div><div class="ticket-project">${t.project}</div></div>
      <div style="flex:1;"><div class="ticket-mats">${t.materials.map(m=>m.name.split(':').pop()).join(', ')}</div><div class="ticket-date">PM: ${t.pm} · ${fmtDate(t.submittedAt.split('T')[0])}</div></div>
      <div><span class="badge badge-${statusBadgeClass(t.status)}">${t.status}</span></div>
      <div style="color:var(--mg);">→</div>
    </div>`).join('');
}

function getOrderFlowLabel(t) {
  if(t.status==='Completed') return 'Complete — all materials released and/or purchased.';
  if(t.status==='Pending Inventory') return 'Step 1: Inventory Manager checks warehouse stock and releases what is available.';
  if(t.status==='At PO'||(t.inventoryReviewedAt&&ticketNeedsPurchase(t))) return 'Step 2: PO Officer creates a purchase order for remaining shortages.';
  if(t.inventoryReviewedAt&&!ticketNeedsPurchase(t)) return 'Released fully from warehouse — no purchase required.';
  if(t.status==='Pending Override') return 'Billing override required before PO can proceed.';
  return 'Material order in progress.';
}

function renderInvOrdersList() {
  const el=document.getElementById('inv-orders-list');
  if(!el) return;
  const pending=getTicketsPendingInventory();
  const cntEl=document.getElementById('inv-orders-page-cnt');
  if(cntEl) cntEl.textContent=pending.length;
  if(!pending.length) {
    el.innerHTML='<div class="empty-state"><div class="empty-icon">📦</div>No orders awaiting warehouse review.<br><span style="font-size:11.5px;">New engineer requests appear here first.</span></div>';
    return;
  }
  el.innerHTML=pending.map(t=>{
    const materials=t.materials.map(m=>m.name.split(':').pop()).join(', ');
    return `<div class="ticket-row" onclick="viewTicketDetail('${t.id}')">
      <div><div class="ticket-no">${esc(t.no)} ${t.urgent?'<span class="badge badge-urgent" style="font-size:9px;">URGENT</span>':''}</div><div class="ticket-project">${esc(t.project)}</div></div>
      <div style="flex:1;"><div class="ticket-mats">${esc(materials)}</div><div class="ticket-date">Engineer: ${esc(t.engineerName||t.submittedBy||'–')} · Needed ${fmtDate(t.dateNeeded)}</div></div>
      <div><span class="badge badge-pending-inventory">Pending Inventory</span></div>
      <div style="color:var(--mg);">→</div>
    </div>`;
  }).join('');
}

function renderInvOrdersDashWidget() {
  const el=document.getElementById('inv-orders-dash');
  if(!el) return;
  const pending=getTicketsPendingInventory();
  if(!pending.length) {
    el.innerHTML='';
    return;
  }
  el.innerHTML=`<div class="dash-widget" style="margin-bottom:0;">
    <div class="dash-widget-head">
      <div class="dash-widget-title" style="color:var(--bl);">📋 Material Orders — Warehouse Review</div>
      <span class="badge badge-pending-inventory">${pending.length}</span>
      <button class="btn btn-ol btn-sm" style="margin-left:auto;" onclick="navigate('inv-orders',document.querySelector('[data-page=inv-orders]'))">View all</button>
    </div>
    <div class="dash-widget-body no-pad">
      ${pending.slice(0,5).map(t=>`<div class="ticket-row" onclick="viewTicketDetail('${t.id}')" style="cursor:pointer;">
        <div><div class="ticket-no">${esc(t.no)}</div><div class="ticket-project">${esc(t.project)}</div></div>
        <div style="flex:1;font-size:11px;color:var(--soft);">${esc(t.engineerName||t.submittedBy||'–')} · ${t.materials.length} item(s)</div>
        <div style="color:var(--mg);">Review →</div>
      </div>`).join('')}
    </div>
  </div>`;
}

function processInventoryRelease(ticketId) {
  const t=DB.tickets.find(x=>x.id===ticketId);
  if(!t||t.status!=='Pending Inventory') { toast('Error: This order is not awaiting inventory review.'); return; }
  const reviewer=_currentUser?.name||'Inventory Manager';
  let totalReleased=0;
  const shortageItems=[];
  t.materials.forEach((m,idx)=>{
    const pendingQty=Math.max(0,(m.requestedQty||0)-(m.fulfilledQty||0));
    const available=getStockAvailableForMaterial(m.name);
    const inputEl=document.getElementById(`inv-rel-${ticketId}-${idx}`);
    let releaseQty=inputEl?parseInt(inputEl.value,10):Math.min(pendingQty,available);
    if(isNaN(releaseQty)||releaseQty<0) releaseQty=0;
    releaseQty=Math.min(releaseQty,pendingQty,available);
    const inv=findInventoryItem(m.name);
    if(inv&&releaseQty>0) {
      inv.qty=Math.max(0,(inv.qty||0)-releaseQty);
      syncWarehouseReleaseToMonitor(t,m.name,releaseQty);
      DB.inventory_log.unshift({id:uid(),dt:nowISO(),type:'release',itemName:inv.name,project:t.project||'',qtyChange:-releaseQty,balanceAfter:inv.qty,remarks:`${t.no} warehouse release · ${t.project}${t.siteLocation?` · ${t.siteLocation}`:''}`});
      totalReleased+=releaseQty;
    }
    m.fulfilledQty=(m.fulfilledQty||0)+releaseQty;
    m.remainingQty=Math.max(0,(m.requestedQty||0)-m.fulfilledQty);
    if(m.remainingQty>0) shortageItems.push(`${m.name.split(':').pop()} (${m.remainingQty} ${m.unit})`);
  });
  t.inventoryReviewedAt=nowISO();
  t.inventoryReviewedBy=reviewer;
  if(!ticketNeedsPurchase(t)) {
    t.status='Completed';
    finalizeReleaseToMovementLog(t);
    appendTicketAudit(t,'Warehouse release',`Fully released from stock (${totalReleased} unit(s) total).`,reviewer);
    toast(`Order ${t.no} completed from warehouse.`,'ok');
  } else {
    t.status='At PO';
    t.sentToPOAt=nowISO();
    appendTicketAudit(t,'Warehouse release',`Released ${totalReleased} unit(s) from stock.`,reviewer);
    appendTicketAudit(t,'Sent to PO',`Shortages forwarded to PO Officer: ${shortageItems.join('; ')}`,reviewer);
    pushNotification({type:'orange',title:'Purchase needed',text:`${t.no} · ${t.project} — create PO for items still needed after warehouse release.`,roles:['po_officer'],source:'material-order'});
    toast('Warehouse release recorded. Shortages sent to PO Officer.','ok');
  }
  logSystemActivity('Inventory review completed',t.no,ticketNeedsPurchase(t)?'Shortages sent to PO':'Fully released from warehouse');
  saveDB();
  updateInvPill();
  updateOrderNavBadges();
  if(currentPage==='inv-orders') renderInvOrdersList();
  if(currentPage==='inv-dashboard') renderDashboard();
  if(currentPage==='po-dashboard') renderPODashboard();
  viewTicketDetail(ticketId);
}

function viewTicketDetail(id) {
  const t=DB.tickets.find(x=>x.id===id);
  if(!t) return;
  const el=document.getElementById('emp-detail-content');
  const role=_currentUser?.role||'';
  const pct=t.materials.length?Math.round(t.materials.reduce((s,m)=>s+((m.fulfilledQty||0)/(m.requestedQty||1)),0)/t.materials.length*100):0;
  const canInvReview=role==='inventory_manager'&&t.status==='Pending Inventory';
  const canPO=['admin','accountant','po_officer'].includes(role);
  const poReady=t.inventoryReviewedAt&&ticketNeedsPurchase(t)&&t.status!=='Completed'&&!t.linkedPOId;
  const showBilling=canPO&&t.inventoryReviewedAt&&poReady;
  const invReviewTable=canInvReview?`<div style="background:var(--mg-lt);border:1px solid var(--mg);border-radius:var(--r);padding:14px 16px;margin-bottom:16px;">
    <div style="font-weight:700;font-size:13px;color:var(--mg);margin-bottom:8px;">Warehouse release</div>
    <div style="font-size:12px;color:var(--soft);margin-bottom:12px;line-height:1.55;">Release available stock first. Any remaining quantity will be forwarded to the PO Officer to purchase.</div>
    <div class="tbl-wrap" style="box-shadow:none;border:none;"><table>
      <thead><tr><th>Material</th><th>Requested</th><th>In stock</th><th>Release qty</th></tr></thead>
      <tbody>${t.materials.map((m,idx)=>{
        const pending=Math.max(0,(m.requestedQty||0)-(m.fulfilledQty||0));
        const avail=getStockAvailableForMaterial(m.name);
        const def=Math.min(pending,avail);
        return `<tr>
          <td style="font-weight:600;">${esc(m.name.split(':').pop())}</td>
          <td style="text-align:center;">${pending} ${esc(m.unit)}</td>
          <td style="text-align:center;font-weight:700;color:${avail>0?'var(--gn)':'var(--rd)'};">${avail}</td>
          <td style="text-align:center;"><input class="fc" type="number" id="inv-rel-${id}-${idx}" min="0" max="${Math.min(pending,avail)}" value="${def}" style="width:80px;margin:0 auto;text-align:center;padding:6px 8px;"></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    <button class="btn btn-gn btn-lg" onclick="processInventoryRelease('${id}')" style="width:100%;justify-content:center;margin-top:14px;">✓ Confirm warehouse release</button>
  </div>`:'';
  const convertBtn=canPO&&poReady
    ?`<div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-mg" onclick="convertTicketToPO('${id}')" style="width:100%;justify-content:center;">📋 Create PO for shortages</button></div>`
    :'';
  const matHeader=canInvReview?'Review materials':'Materials';
  const matCols=canInvReview
    ?`<thead><tr><th>Material</th><th>Requested</th><th>In stock</th></tr></thead>
    <tbody>${t.materials.map(m=>`<tr>
      <td style="font-weight:600;">${esc(m.name.split(':').pop())}</td>
      <td style="text-align:center;">${m.requestedQty} ${esc(m.unit)}</td>
      <td style="text-align:center;font-weight:700;color:${getStockAvailableForMaterial(m.name)>0?'var(--gn)':'var(--rd)'};">${getStockAvailableForMaterial(m.name)}</td>
    </tr>`).join('')}</tbody>`
    :`<thead><tr><th>Material</th><th>Requested</th><th>Released</th><th>Still needed</th><th>Status</th></tr></thead>
    <tbody>${t.materials.map(m=>{const done=(m.remainingQty||0)===0;return`<tr>
      <td style="font-weight:600;">${esc(m.name.split(':').pop())}</td>
      <td style="text-align:center;">${m.requestedQty} ${esc(m.unit)}</td>
      <td style="text-align:center;color:var(--gn);font-weight:700;">${m.fulfilledQty||0}</td>
      <td style="text-align:center;color:${done?'var(--gn)':'var(--rd)'};font-weight:700;">${m.remainingQty||0}</td>
      <td><span class="badge ${done?'badge-completed':'badge-pending'}">${done?'Done':'Need PO'}</span></td>
    </tr>`}).join('')}</tbody>`;
  el.innerHTML=`<div style="padding:22px 28px;">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
      <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:var(--mg);">${esc(t.no)}</div>
      <span class="badge badge-${statusBadgeClass(t.status)}">${t.status}</span>
      ${t.urgent?'<span class="badge badge-urgent">⚡ URGENT</span>':''}
    </div>
    <div style="font-size:12px;color:var(--soft);background:var(--paper);border-radius:var(--r);padding:10px 14px;margin-bottom:16px;line-height:1.55;">${esc(getOrderFlowLabel(t))}</div>
    ${showBilling?renderBillingGatePanel(t,{forPO:role==='po_officer'}):''}
    <div class="fr2">
      <div><div class="form-lbl">Order No.</div><div style="font-weight:600;">${esc(t.no)}</div></div>
      <div><div class="form-lbl">Engineer</div><div style="font-weight:600;">${esc(t.engineerName||t.submittedBy||'–')}</div></div>
      <div><div class="form-lbl">PM</div><div style="font-weight:600;">${esc(t.pm)}</div></div>
      <div><div class="form-lbl">Project</div><div style="font-weight:600;">${esc(t.project)}</div></div>
      ${t.siteLocation?`<div><div class="form-lbl">Site / Location</div><div style="font-weight:600;">${esc(t.siteLocation)}</div></div>`:''}
      <div><div class="form-lbl">Date Needed</div><div>${fmtDate(t.dateNeeded)}</div></div>
      <div><div class="form-lbl">Submitted</div><div>${fmtDT(t.submittedAt)}</div></div>
      ${t.inventoryReviewedAt?`<div><div class="form-lbl">Inventory reviewed</div><div>${fmtDT(t.inventoryReviewedAt)} · ${esc(t.inventoryReviewedBy||'–')}</div></div>`:''}
    </div>
    ${t.remarks?`<div style="margin-bottom:14px;"><div class="form-lbl">Remarks</div><div>${esc(t.remarks)}</div></div>`:''}
    ${invReviewTable}
    ${canInvReview?'':`<div style="border-top:1px solid var(--bd);margin:12px 0 16px;"></div>
    <div style="font-family:'Syne',sans-serif;font-size:11px;font-weight:700;color:var(--soft);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px;">${matHeader} (${pct}% released)</div>
    <div style="height:6px;background:var(--paper);border-radius:3px;margin-bottom:14px;overflow:hidden;"><div style="height:6px;background:var(--gn);border-radius:3px;width:${pct}%;transition:width .5s;"></div></div>
    <div class="tbl-wrap"><table>${matCols}</table></div>`}
    ${t.linkedPOId?`<div style="margin-top:16px;padding:12px 16px;background:var(--mg-lt);border:1.5px solid var(--mg);border-radius:var(--r);font-size:12.5px;">📋 Linked PO: <strong>${esc(t.linkedPONo||'–')}</strong></div>`:''}
    ${(t.bossApproved||t.financeApproved)?`<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
      <span class="approval-pill ${t.bossApproved?'yes':'no'}">Boss: ${t.bossApproved?'Approved':'Pending'}</span>
      <span class="approval-pill ${t.financeApproved?'yes':'no'}">Finance: ${t.financeApproved?'Approved':'Pending'}</span>
    </div>`:''}
    ${(t.auditTrail&&t.auditTrail.length)?`<div style="border-top:1px solid var(--bd);margin:16px 0 10px;padding-top:12px;">
      <div style="font-family:'Syne',sans-serif;font-size:11px;font-weight:700;color:var(--soft);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Audit Trail</div>
      <div class="audit-trail-list">${t.auditTrail.slice().reverse().map(a=>`<div class="audit-trail-row"><div style="font-weight:600;font-size:12px;">${esc(a.action)}</div><div style="font-size:11px;color:var(--faint);">${esc(a.by)} · ${fmtDT(a.at)}</div>${a.note?`<div style="font-size:11.5px;color:var(--soft);margin-top:2px;">${esc(a.note)}</div>`:''}</div>`).join('')}</div>
    </div>`:''}
    ${convertBtn}
  </div>`;
  navigate('emp-ticket-detail', null);
}

function completeTicketAndDeductInventory(id) {
  const t=DB.tickets.find(x=>x.id===id); if(!t) return;
  t.materials.forEach(m=>{
    if(m.fulfilledQty>0) {
      const inv=DB.inventory.find(i=>i.name===m.name||i.name.split(':').pop()===m.name);
      if(inv) { const dq=Math.min(m.fulfilledQty,inv.qty||0); if(dq>0) { inv.qty-=dq; DB.inventory_log.unshift({id:uid(),dt:nowISO(),type:'ticket',itemName:inv.name,project:t.project||'',qtyChange:-dq,balanceAfter:inv.qty,remarks:`${t.no} · ${t.project}${t.siteLocation?` · ${t.siteLocation}`:''}`}); } }
    }
  });
  t.status='Completed'; saveDB(); updateInvPill(); renderDashboard();
  toast(`Ticket ${t.no} marked as completed.`,'ok');
  navigate('emp-dashboard', document.querySelector('[data-page="emp-dashboard"]'));
}

let matRows=[];
function initNewTicket() {
  matRows=[];
  document.getElementById('mat-entries').innerHTML='';
  document.getElementById('nt-pm').value=_currentUser?.role==='engineer' ? (_currentUser?.name||'') : '';
  const projCountBefore=DB.projects.length;
  (DB.billing_records||[]).forEach(r=>ensureProjectForBillingRecord(r));
  if(DB.projects.length>projCountBefore) saveDB();
  buildDatalist();
  const opts=getTicketProjectOptions();
  const dl=document.getElementById('nt-pn-datalist');
  if(dl) dl.innerHTML=opts.map(p=>`<option value="${esc(p.name)}">`).join('');
  const pn=document.getElementById('nt-pn');
  const hid=document.getElementById('nt-project-id');
  if(pn) pn.value='';
  if(hid) hid.value='';
  const clientRow=document.getElementById('nt-client-row');
  const clientEl=document.getElementById('nt-client');
  if(clientRow) clientRow.style.display='none';
  if(clientEl) clientEl.value='';
  const siteEl=document.getElementById('nt-site'); if(siteEl) siteEl.value='';
  document.getElementById('nt-date-needed').value='';
  document.getElementById('nt-urg').checked=false;
  document.getElementById('nt-remarks').value='';
  addMatRow();
  if(isDemoSession()) fillSampleTicketForm();
}

function prefillStockInDemo() {
  const d=document.getElementById('si-date'); if(d) d.value=today();
  const item=document.getElementById('si-item'); if(item) item.value='PLUMBING:PVC PIPE 2 INCH';
  const qty=document.getElementById('si-qty'); if(qty) qty.value='20';
  const sup=document.getElementById('si-supplier'); if(sup) sup.value='Neltex Development Co.';
  const rem=document.getElementById('si-remarks'); if(rem) rem.value='Demo receipt DR-2026-0142 — warehouse delivery';
}

function fillSampleTicketForm() {
  const assigned=_currentUser?.assignedProjectIds||['PROJ002'];
  const projId=assigned.includes('PROJ002')?'PROJ002':assigned[0];
  const proj=DB.projects.find(p=>p.id===projId);
  const pn=document.getElementById('nt-pn');
  if(pn&&proj) { pn.value=proj.name; onTicketProjectInput(); }
  const site=document.getElementById('nt-site');
  if(site) site.value='Ground floor, operatory wing';
  const dn=document.getElementById('nt-date-needed');
  if(dn) dn.value=addDays(today(),10);
  const urg=document.getElementById('nt-urg');
  if(urg) urg.checked=false;
  const rem=document.getElementById('nt-remarks');
  if(rem) rem.value='Demo request — PVC rough-in for dental operatory';
  if(matRows.length) {
    const id=matRows[0];
    const n=document.getElementById('matn-'+id);
    const q=document.getElementById('matq-'+id);
    const u=document.getElementById('matu-'+id);
    if(n) n.value='PLUMBING:PVC PIPE 2 INCH';
    if(q) q.value='8';
    if(u) u.value='LEN';
  }
  toast('Sample values loaded — edit or submit.','ok');
}

function onTicketProjectInput() {
  const name=document.getElementById('nt-pn')?.value||'';
  const resolved=resolveTicketProjectByName(name);
  const hid=document.getElementById('nt-project-id');
  const clientRow=document.getElementById('nt-client-row');
  const clientEl=document.getElementById('nt-client');
  if(resolved) {
    if(hid) hid.value=resolved.id;
    if(clientRow&&clientEl) {
      clientRow.style.display='block';
      clientEl.value=resolved.client;
    }
    return;
  }
  if(hid) hid.value='';
  const q=name.trim().toLowerCase();
  if(q.length>=2) {
    const br=(DB.billing_records||[]).find(r=>(r.project||'').toLowerCase()===q
      ||(r.project||'').toLowerCase().startsWith(q));
    if(br&&clientRow&&clientEl) {
      clientRow.style.display='block';
      clientEl.value=br.company||'';
      return;
    }
  }
  if(clientRow) {
    clientRow.style.display='none';
    if(clientEl) clientEl.value='';
  }
}

function addMatRow() {
  const id=uid(); matRows.push(id);
  const wrap=document.getElementById('mat-entries');
  const div=document.createElement('div');
  div.className='mat-row'; div.id='mat-'+id;
  div.innerHTML=`
    <datalist id="matdl-${id}">${DB.inventory.map(i=>`<option value="${esc(i.name)}">`).join('')}</datalist>
    <div style="flex:3;min-width:160px;"><div class="form-lbl">Material</div><input class="fc" list="matdl-${id}" id="matn-${id}" placeholder="Search item…"></div>
    <div style="flex:1;min-width:70px;"><div class="form-lbl">Qty</div><input class="fc" id="matq-${id}" type="number" min="1" placeholder="0"></div>
    <div style="flex:1;min-width:60px;"><div class="form-lbl">Unit</div><input class="fc" id="matu-${id}" placeholder="PCS"></div>
    <div style="padding-bottom:14px;"><button class="btn btn-ol btn-sm" onclick="removeMatRow('${id}')">✕</button></div>`;
  wrap.appendChild(div);
}

function removeMatRow(id) { matRows=matRows.filter(x=>x!==id); document.getElementById('mat-'+id)?.remove(); }

function submitTicket() {
  const pm=document.getElementById('nt-pm').value.trim();
  const projectName=(document.getElementById('nt-pn')?.value||'').trim();
  let projectId=(document.getElementById('nt-project-id')?.value||'').trim();
  const siteLocation=(document.getElementById('nt-site')?.value||'').trim();
  const dn=document.getElementById('nt-date-needed').value;
  const urg=document.getElementById('nt-urg').checked;
  const remarks=document.getElementById('nt-remarks').value.trim();
  if(!pm||!projectName) { toast('Error: PM and Project are required.'); return; }
  let resolved=projectId?DB.projects.find(p=>p.id===projectId):null;
  if(!resolved) {
    const match=resolveTicketProjectByName(projectName);
    if(match) { projectId=match.id; resolved=DB.projects.find(p=>p.id===projectId); }
  }
  if(!resolved) {
    const br=(DB.billing_records||[]).find(r=>(r.project||'').toLowerCase()===projectName.toLowerCase());
    if(br) {
      ensureProjectForBillingRecord(br);
      projectId=br.projectId;
      resolved=DB.projects.find(p=>p.id===projectId);
      saveDB();
      buildDatalist();
    }
  }
  if(!resolved) {
    toast('Error: Project not found. Pick a name from the list (includes Customer Billing jobs).');
    return;
  }
  const allowed=getTicketProjectOptions();
  if(_currentUser?.role==='engineer'&&!allowed.some(o=>o.id===resolved.id)) {
    toast('Error: This project is not available for your account.');
    return;
  }
  const pn=resolved.name;
  const mats=[];
  for(const id of matRows) {
    const n=document.getElementById('matn-'+id)?.value.trim();
    const q=parseInt(document.getElementById('matq-'+id)?.value)||0;
    const u=document.getElementById('matu-'+id)?.value.trim()||'PCS';
    if(n&&q>0) mats.push({name:n,requestedQty:q,unit:u,fulfilledQty:0,remainingQty:q,brand:''});
  }
  if(!mats.length) { toast('Error: Add at least one material.'); return; }
  const no=generateOrderNumber();
  const submittedAt=nowISO();
  DB.tickets.unshift({
    id:uid(),no,pm,project:pn,projectId,bossApproved:false,financeApproved:false,
    urgent:urg,dateNeeded:dn,submittedBy:_currentUser?.name||'–',submittedRole:_currentUser?.role||'',
    engineerName:_currentUser?.role==='engineer'?_currentUser?.name||'':'',siteLocation,submittedAt,
    status:'Pending Inventory',remarks,materials:mats,
    auditTrail:[{action:'Created',by:_currentUser?.name||'–',at:submittedAt,note:'Material order submitted — sent to Inventory Manager.'}],
  });
  reserveMaterialsForTicket(DB.tickets[0]);
  pushNotification({type:'blue',title:'New material order',text:`${no} from ${_currentUser?.name||'Engineer'} — ${pn}. Stock reserved where available.`,roles:['inventory_manager','po_officer'],source:'material-order'});
  logSystemActivity('Material order submitted',no,`Project: ${pn} — materials reserved`);
  saveDB();
  updateOrderNavBadges();
  toast(`Order ${no} submitted. Inventory Manager will review stock first.`,'ok');
  navigate('emp-dashboard', document.querySelector('[data-page="emp-dashboard"]'));
}

// ── PROJECTS (Feature 1) ───────────────────────────────────────
let projEditId = null;
function projectsGoTab(tab, btn) {
  document.querySelectorAll('#projects-tab-nav .exp-sub-btn').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  const engTabBtn=document.getElementById('projects-eng-tab-btn');
  if(engTabBtn) engTabBtn.style.display=_currentUser?.role==='admin'?'':'none';
  const listWrap=document.getElementById('projects-list-wrap');
  const assignWrap=document.getElementById('projects-assignments-wrap');
  if(tab==='assignments'&&_currentUser?.role==='admin') {
    if(listWrap) listWrap.style.display='none';
    if(assignWrap) { assignWrap.style.display='block'; renderEngineerAssignments(); }
  } else {
    if(listWrap) listWrap.style.display='block';
    if(assignWrap) assignWrap.style.display='none';
    if(tab==='list') renderProjectsList();
  }
}

function renderEngineerAssignments() {
  const el=document.getElementById('projects-assignments-wrap');
  if(!el) return;
  const activeProjects=DB.projects.filter(p=>p.status==='Active');
  const engineers=Object.entries(DEMO_USERS).filter(([,u])=>u.role==='engineer');
  if(!engineers.length) { el.innerHTML='<div class="empty-state">No engineer users configured.</div>'; return; }
  el.innerHTML=`
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
      <button class="btn btn-mg btn-sm" onclick="saveAllEngineerAssignments()">Save All</button>
    </div>
    <div class="tbl-wrap"><table class="eng-assign-table">
      <thead><tr><th>Engineer</th><th>Assigned Projects</th><th style="width:100px;"></th></tr></thead>
      <tbody>${engineers.map(([key,u])=>{
        const assigned=getAssignedProjectIds(key);
        return `<tr>
          <td style="vertical-align:top;padding-top:14px;">
            <div style="font-weight:700;">${esc(u.name)}</div>
            <span class="badge badge-bl" style="font-size:9px;margin-top:4px;display:inline-block;">Engineer</span>
          </td>
          <td><div class="eng-proj-checks">${activeProjects.map(p=>`
            <label class="eng-proj-check"><input type="checkbox" data-eng-key="${esc(key)}" data-proj-id="${esc(p.id)}" ${assigned.includes(p.id)?'checked':''}>
            <span>${esc(p.name)}</span></label>`).join('')}</div></td>
          <td style="vertical-align:top;padding-top:14px;"><button class="btn btn-ol btn-sm" onclick="saveEngineerAssignment('${key}')">Save</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

function saveEngineerAssignment(userKey) {
  const ids=[...document.querySelectorAll(`input[data-eng-key="${userKey}"]:checked`)].map(c=>c.dataset.projId);
  DB.user_assignments[userKey]={assignedProjectIds:ids};
  if(DEMO_USERS[userKey]) DEMO_USERS[userKey].assignedProjectIds=ids;
  saveDB();
  toast('Engineer assignments saved.','ok');
}

function saveAllEngineerAssignments() {
  Object.keys(DEMO_USERS).filter(k=>DEMO_USERS[k].role==='engineer').forEach(saveEngineerAssignment);
}

function renderProjectsList() {
  const el=document.getElementById('projects-list-wrap');
  if(!el) return;
  const engTabBtn=document.getElementById('projects-eng-tab-btn');
  if(engTabBtn) engTabBtn.style.display=_currentUser?.role==='admin'?'':'none';
  if(!DB.projects.length) { el.innerHTML='<div class="empty-state"><div class="empty-icon">🏗</div>No projects yet. Add an awarded project first.</div>'; return; }
  el.innerHTML=`<div class="tbl-wrap"><table>
    <thead><tr><th>Project Name</th><th>Client</th><th>Code</th><th style="text-align:right;">Contract</th><th>Status</th><th>Location</th><th></th></tr></thead>
    <tbody>${DB.projects.map(p=>`<tr>
      <td style="font-family:'Syne',sans-serif;font-weight:700;color:var(--mg);">${esc(p.name)}</td>
      <td style="font-size:12px;color:var(--soft);">${esc(p.client||'–')}</td>
      <td><span class="project-code">${esc(p.code||'–')}</span></td>
      <td style="text-align:right;font-weight:700;">${p.contractAmount>0?peso(p.contractAmount):'–'}</td>
      <td><span class="${p.status==='Active'?'badge-active':p.status==='Completed'?'badge-completed-proj':'badge-on-hold'}" style="padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700;">${esc(p.status)}</span></td>
      <td style="font-size:12px;color:var(--faint);">${esc(p.location||'–')}</td>
      <td><button class="btn btn-ol btn-sm" onclick="openEditProjectModal('${p.id}')">Edit</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}

function openAddProjectModal() {
  projEditId=null;
  document.getElementById('proj-mo-title').textContent='Add Awarded Project';
  document.getElementById('proj-delete-btn').style.display='none';
  ['proj-f-name','proj-f-client','proj-f-code','proj-f-location','proj-f-remarks'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('proj-f-amount').value='';
  document.getElementById('proj-f-status').value='Active';
  openMo('mo-add-project');
}

function openEditProjectModal(id) {
  const p=DB.projects.find(x=>x.id===id); if(!p) return;
  projEditId=id;
  document.getElementById('proj-mo-title').textContent='Edit Project';
  document.getElementById('proj-delete-btn').style.display='';
  document.getElementById('proj-f-name').value=p.name||'';
  document.getElementById('proj-f-client').value=p.client||'';
  document.getElementById('proj-f-code').value=p.code||'';
  document.getElementById('proj-f-amount').value=p.contractAmount||'';
  document.getElementById('proj-f-status').value=p.status||'Active';
  document.getElementById('proj-f-location').value=p.location||'';
  document.getElementById('proj-f-remarks').value=p.remarks||'';
  openMo('mo-add-project');
}

function saveProject() {
  const name=document.getElementById('proj-f-name').value.trim();
  if(!name) { toast('Error: Project name is required.'); return; }
  const proj={
    id:projEditId||uid(), name,
    client:document.getElementById('proj-f-client').value.trim(),
    code:document.getElementById('proj-f-code').value.trim(),
    contractAmount:parseFloat(document.getElementById('proj-f-amount').value)||0,
    status:document.getElementById('proj-f-status').value,
    location:document.getElementById('proj-f-location').value.trim(),
    remarks:document.getElementById('proj-f-remarks').value.trim(),
    createdAt:today(),
  };
  if(projEditId) { const idx=DB.projects.findIndex(x=>x.id===projEditId); if(idx>=0) DB.projects[idx]=proj; }
  else DB.projects.unshift(proj);
  saveDB(); buildDatalist(); renderProjectsList();
  closeMo('mo-add-project'); toast('Project saved.','ok');
}

function deleteProject() {
  if(!confirm('Delete this project?')) return;
  DB.projects=DB.projects.filter(x=>x.id!==projEditId);
  saveDB(); buildDatalist(); renderProjectsList();
  closeMo('mo-add-project'); toast('Project deleted.','ok');
}

// ── SUPPLIERS (Feature 3 + 4) ─────────────────────────────────
let supEditId = null;
let supPriceRows = [];

function renderSuppliersList() {
  const el=document.getElementById('suppliers-list-wrap');
  if(!el) return;
  if(!DB.suppliers.length) { el.innerHTML='<div class="empty-state"><div class="empty-icon">🏪</div>No suppliers yet.</div>'; return; }
  el.innerHTML=`<div class="tbl-wrap"><table>
    <thead><tr><th>Supplier Name</th><th>Credit Terms</th><th>Contact</th><th>TIN</th><th>Item Prices</th><th></th></tr></thead>
    <tbody>${DB.suppliers.map(s=>`<tr>
      <td style="font-family:'Syne',sans-serif;font-weight:700;">${esc(s.name)}</td>
      <td><span class="supplier-terms">${s.terms>0?s.terms+' days':'COD'}</span></td>
      <td style="font-size:12px;color:var(--soft);">${esc(s.contact||'–')}</td>
      <td style="font-size:12px;color:var(--faint);">${esc(s.tin||'–')}</td>
      <td style="font-size:12px;color:var(--soft);">${(s.itemPrices||[]).length} item(s)</td>
      <td><button class="btn btn-ol btn-sm" onclick="openEditSupplierModal('${s.id}')">Edit</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}

function openAddSupplierModal() {
  supEditId=null; supPriceRows=[];
  document.getElementById('sup-mo-title').textContent='Add Supplier';
  document.getElementById('sup-delete-btn').style.display='none';
  ['sup-f-name','sup-f-tin','sup-f-contact','sup-f-address'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('sup-f-terms').value='30';
  document.getElementById('sup-item-prices').innerHTML='';
  openMo('mo-add-supplier');
}

function openEditSupplierModal(id) {
  const s=DB.suppliers.find(x=>x.id===id); if(!s) return;
  supEditId=id; supPriceRows=[];
  document.getElementById('sup-mo-title').textContent='Edit Supplier';
  document.getElementById('sup-delete-btn').style.display='';
  document.getElementById('sup-f-name').value=s.name||'';
  document.getElementById('sup-f-terms').value=s.terms||30;
  document.getElementById('sup-f-tin').value=s.tin||'';
  document.getElementById('sup-f-contact').value=s.contact||'';
  document.getElementById('sup-f-address').value=s.address||'';
  document.getElementById('sup-item-prices').innerHTML='';
  (s.itemPrices||[]).forEach(ip=>addSupplierPriceRow(ip));
  openMo('mo-add-supplier');
}

function addSupplierPriceRow(existing) {
  const id=uid(); supPriceRows.push(id);
  const wrap=document.getElementById('sup-item-prices');
  const div=document.createElement('div');
  div.className='mat-row'; div.id='sprow-'+id;
  div.innerHTML=`
    <datalist id="spdl-${id}">${DB.inventory.map(i=>`<option value="${esc(i.name)}">`).join('')}</datalist>
    <div style="flex:3;min-width:160px;"><div class="form-lbl">Item</div><input class="fc" list="spdl-${id}" id="spitem-${id}" value="${esc(existing?.itemName||'')}" placeholder="Item name…" oninput="spFillUnit('${id}')"></div>
    <div style="flex:1;min-width:60px;"><div class="form-lbl">Unit</div><input class="fc" id="spunit-${id}" value="${esc(existing?.unit||'')}" placeholder="PCS"></div>
    <div style="flex:1;min-width:90px;"><div class="form-lbl">Price (₱)</div><input class="fc" id="spprice-${id}" type="number" min="0" value="${existing?.price||''}" placeholder="0.00"></div>
    <div style="padding-bottom:14px;"><button class="btn btn-ol btn-sm" onclick="removeSupPriceRow('${id}')">✕</button></div>`;
  wrap.appendChild(div);
}

function spFillUnit(id) {
  const name=document.getElementById('spitem-'+id)?.value;
  const item=findInventoryItem(name);
  if(item) document.getElementById('spunit-'+id).value=item.unit;
}

function removeSupPriceRow(id) { supPriceRows=supPriceRows.filter(x=>x!==id); document.getElementById('sprow-'+id)?.remove(); }

function saveSupplier() {
  const name=document.getElementById('sup-f-name').value.trim();
  if(!name) { toast('Error: Supplier name is required.'); return; }
  const itemPrices=[];
  for(const id of supPriceRows) {
    const itemName=document.getElementById('spitem-'+id)?.value.trim();
    const unit=document.getElementById('spunit-'+id)?.value.trim()||'PCS';
    const price=parseFloat(document.getElementById('spprice-'+id)?.value)||0;
    if(itemName&&price>0) {
      const inv=findInventoryItem(itemName);
      itemPrices.push({itemId:inv?.id||'',itemName:inv?.name||itemName,unit,price});
    }
  }
  const sup={
    id:supEditId||uid(), name,
    terms:parseInt(document.getElementById('sup-f-terms').value)||0,
    tin:document.getElementById('sup-f-tin').value.trim(),
    contact:document.getElementById('sup-f-contact').value.trim(),
    address:document.getElementById('sup-f-address').value.trim(),
    itemPrices,
  };
  if(supEditId) { const idx=DB.suppliers.findIndex(x=>x.id===supEditId); if(idx>=0) DB.suppliers[idx]=sup; }
  else DB.suppliers.unshift(sup);
  saveDB(); renderSuppliersList();
  closeMo('mo-add-supplier'); toast('Supplier saved.','ok');
}

function deleteSupplier() {
  if(!confirm('Delete this supplier?')) return;
  DB.suppliers=DB.suppliers.filter(x=>x.id!==supEditId);
  saveDB(); renderSuppliersList();
  closeMo('mo-add-supplier'); toast('Supplier deleted.','ok');
}

// Helper: get price for an item from a specific supplier
function getSupplierItemPrice(supplierId, itemName) {
  if(!supplierId) return null;
  const sup=DB.suppliers.find(s=>s.id===supplierId);
  if(!sup) return null;
  const inv=findInventoryItem(itemName);
  if(!inv) return null;
  return (sup.itemPrices||[]).find(ip=>ip.itemId===inv.id||ip.itemName===inv.name||ip.itemName===itemName)||null;
}

function getSupplierPriceOptions(itemName) {
  const inv=findInventoryItem(itemName);
  if(!inv) return [];
  return DB.suppliers.map(s=>{
    const priceRec=getSupplierItemPrice(s.id, itemName);
    if(!priceRec) return null;
    return {
      supplier:s,
      priceRec,
      price:parseFloat(priceRec.price)||0,
    };
  }).filter(Boolean).sort((a,b)=>a.price-b.price||a.supplier.name.localeCompare(b.supplier.name));
}

function getBestSupplierForItem(itemName) {
  return getSupplierPriceOptions(itemName)[0]||null;
}

function formatSupplierPriceLabel(entry) {
  const price=Number(entry?.price)||0;
  const unit=entry?.priceRec?.unit||'unit';
  return `${entry.supplier.name} - ${peso(price)} / ${unit}`;
}

function updatePOLineSupplierOptions(id, itemName) {
  const select=poEl('polsup-'+id);
  const info=poEl('polsupinfo-'+id);
  if(!select) return;

  const options=getSupplierPriceOptions(itemName);
  const defaultVendorId='';
  const best=options[0]||null;

  const optionHtml = [
    '<option value="">Auto-select best price</option>',
    ...options.map(entry=>`<option value="${esc(entry.supplier.id)}">${esc(formatSupplierPriceLabel(entry))}</option>`),
    '<option value="__add_new__">+ Add new supplier…</option>',
  ].join('');
  select.innerHTML=optionHtml;

  select.value=best?.supplier?.id||defaultVendorId||'';

  if(info) {
    if(!options.length) {
      info.innerHTML='<span style="color:var(--faint);">No supplier price found yet. Add this item in the Suppliers page, or use manual pricing.</span>';
    } else {
      const altCount=Math.max(0, options.length-1);
      info.innerHTML=`<span class="terms-tag">Best: ${esc(formatSupplierPriceLabel(best))}</span>${altCount?` <span style="margin-left:8px;color:var(--soft);">+${altCount} other supplier(s)</span>`:''}`;
    }
  }
}

function addSupplierFromLineItem(id) {
  const name = (prompt('Enter new supplier name:')||'').trim();
  if(!name) { const sel=poEl('polsup-'+id); if(sel) sel.value=''; return; }
  const termsStr = prompt(`Credit terms (days) for ${name} (leave blank for 0):`,`30`);
  const terms = parseInt(termsStr)||0;
  const contact = (prompt(`Contact info (phone/email) for ${name} (optional):`)||'').trim();
  const newSup = {id:uid(), name, terms, tin:'', address:'', contact, itemPrices:[]};

  // If the line item has an item and a unit price entered, save that price under the new supplier
  const itemName = (poEl('polid-'+id)?.value||'').trim();
  const currentPrice = (poEl('polip-'+id)?.value||'').trim();
  if(itemName) {
    const inv = findInventoryItem(itemName);
    let priceToSave = '';
    if(currentPrice) priceToSave = currentPrice;
    else {
      const p = prompt(`Unit price for ${itemName} from ${name} (₱):`,``);
      priceToSave = (p||'').trim();
    }
    if(priceToSave) {
      const priceNum = parseFloat(priceToSave)||0;
      newSup.itemPrices.push({itemId:inv?.id||'', itemName:inv?.name||itemName, unit:inv?.unit||'unit', price:priceNum});
    }
  }

  DB.suppliers.push(newSup);
  saveDB();
  try{ buildDatalist(); }catch(e){}
  try{ if(typeof renderSuppliersList==='function') renderSuppliersList(); }catch(e){}
  // refresh options for all line items
  poLineItems.forEach(lid=>updatePOLineSupplierOptions(lid, poEl('polid-'+lid)?.value||''));
  const sel=poEl('polsup-'+id);
  if(sel) sel.value=newSup.id;
  // If we saved a price for this item, set the line item price input
  if(itemName && newSup.itemPrices.length) {
    const rec = newSup.itemPrices.find(ip=> (ip.itemName===itemName) || (ip.itemId && ip.itemId===findInventoryItem(itemName)?.id));
    if(rec) {
      const priceEl=poEl('polip-'+id);
      if(priceEl) priceEl.value = rec.price;
    }
  }
  updatePOLineItemPriceFromSupplier(id);
  toast(`Supplier "${name}" added.`,'ok');
}

function resolvePOLineSupplier(id, itemName) {
  const selectedId=poEl('polsup-'+id)?.value||'';
  const options=getSupplierPriceOptions(itemName);
  if(selectedId) {
    const chosen=options.find(entry=>entry.supplier.id===selectedId);
    if(chosen) return chosen;
  }
  return options[0]||null;
}

function getPOLineShortageState(id) {
  const itemName=(poEl('polid-'+id)?.value||'').trim();
  const requestedQty=parseFloat(poEl('poliq-'+id)?.value)||0;
  const item=findInventoryItem(itemName);
  const availableQty=item?getAvailableQty(item):0;
  const shortageQty=Math.max(0, requestedQty-availableQty);
  const purchaseQty=requestedQty;
  return {itemName, requestedQty, availableQty, shortageQty, purchaseQty, item};
}

function ensurePoReleaseQueue() {
  DB.po_release_queue = DB.po_release_queue || [];
  return DB.po_release_queue;
}

function syncPoReleaseQueueFromPO(po) {
  if(!po) return;
  const queue=ensurePoReleaseQueue();
  const stage=po.status==='Approved' ? 'Expected Delivery' : 'For Purchase';
  (po.items||[]).forEach((item, index)=>{
    const inv=findInventoryItem(item.desc);
    const requestedQty=Number(item.requestedQty ?? item.qty ?? 0);
    const availableQty=Number(item.availableQty ?? (inv?getAvailableQty(inv):0) ?? 0);
    // determine shortage (to be purchased) and release (to be prepared from warehouse)
    const shortageQty=Math.max(0, requestedQty - availableQty);
    const releaseQty=Math.max(0, Math.min(requestedQty, availableQty));

    // Purchase entry (shortage)
    if(shortageQty>0) {
      const queueIdBuy=`${po.id}:${index}:buy`;
      const existingBuy=queue.find(q=>q.queueId===queueIdBuy || q.queueId===`${po.id}:${index}`);
      const payloadBuy={
        queueId:queueIdBuy,
        kind:'purchase',
        poId:po.id,
        poNo:po.no,
        poDate:po.date,
        vendor:po.vendor,
        project:item.project||po.project||'–',
        itemName:item.desc,
        itemLabel:inv?.name||item.desc,
        qty:shortageQty,
        requestedQty,
        availableQty,
        unit:item.unit||inv?.unit||'PCS',
        supplierName:item.supplierName||po.vendor||'–',
        whOrderNo:item.whOrderNo||'–',
        status:existingBuy?.status&&existingBuy.status==='Prepared' ? 'Prepared' : stage,
        acknowledgedBy:existingBuy?.acknowledgedBy||'',
        acknowledgedAt:existingBuy?.acknowledgedAt||'',
        preparedBy:existingBuy?.preparedBy||'',
        preparedAt:existingBuy?.preparedAt||'',
        updatedAt:nowISO(),
      };
      if(existingBuy) Object.assign(existingBuy, payloadBuy);
      else queue.unshift(payloadBuy);
    }

    // Release entry (available stock to prepare/release)
    if(releaseQty>0) {
      const queueIdRel=`${po.id}:${index}:avail`;
      const existingRel=queue.find(q=>q.queueId===queueIdRel);
      const relStatus = po.status==='Approved' ? 'Expected Delivery' : 'For Release';
      const payloadRel={
        queueId:queueIdRel,
        kind:'release',
        poId:po.id,
        poNo:po.no,
        poDate:po.date,
        vendor:po.vendor,
        project:item.project||po.project||'–',
        itemName:item.desc,
        itemLabel:inv?.name||item.desc,
        qty:releaseQty,
        requestedQty,
        availableQty,
        unit:item.unit||inv?.unit||'PCS',
        supplierName:item.supplierName||po.vendor||'–',
        whOrderNo:item.whOrderNo||'–',
        status: existingRel?.status==='Prepared' ? 'Prepared' : relStatus,
        acknowledgedBy:existingRel?.acknowledgedBy||'',
        acknowledgedAt:existingRel?.acknowledgedAt||'',
        preparedBy:existingRel?.preparedBy||'',
        preparedAt:existingRel?.preparedAt||'',
        updatedAt:nowISO(),
      };
      if(existingRel) Object.assign(existingRel, payloadRel);
      else queue.unshift(payloadRel);
    }
  });
  DB.po_release_queue = queue.slice(0,100);
}

function acknowledgePoRelease(queueId) {
  const entry=ensurePoReleaseQueue().find(q=>q.queueId===queueId);
  if(!entry) return;
  entry.acknowledgedBy=_currentUser?.name||'–';
  entry.acknowledgedAt=nowISO();
  entry.updatedAt=nowISO();
  saveDB(); renderDashboard();
  toast('Success: Release request acknowledged.','ok');
}

function preparePoRelease(queueId) {
  const entry=ensurePoReleaseQueue().find(q=>q.queueId===queueId);
  if(!entry) return;
  // Allow preparing both purchase (mark as prepared) and release (deduct inventory)
  if(!['Expected Delivery','For Release'].includes(entry.status)) {
    toast('Warning: This item is not ready to be prepared yet.');
    return;
  }
  // If this is a release-type entry, actually deduct stock (limited by current inventory)
  if(entry.kind==='release') {
    const inv=findInventoryItem(entry.itemLabel||entry.itemName);
    const availableNow=inv?.qty||0;
    const toRelease=Math.min(entry.qty||0, availableNow);
    if(toRelease<=0) { toast('Warning: No stock available to prepare for release.','warn'); return; }
    // deduct inventory
    inv.qty = Math.max(0, (inv.qty||0) - toRelease);
    inv.expected = Math.max(0, (inv.expected||0) - toRelease);
    DB.inventory_log.unshift({id:uid(),dt:nowISO(),type:'out',itemName:inv.name,qtyChange:-toRelease,balanceAfter:inv.qty,remarks:`Prepared for PO ${entry.poNo}`});
    entry.preparedQty = (entry.preparedQty||0) + toRelease;
    entry.qty = Math.max(0, (entry.qty||0) - toRelease);
    entry.preparedBy=_currentUser?.name||'–';
    entry.preparedAt=nowISO();
    entry.updatedAt=nowISO();
    entry.status = entry.qty>0 ? 'Partial' : 'Prepared';
    saveDB(); renderDashboard(); updateInvPill();
    toast(`Success: Prepared ${toRelease} ${entry.unit||'unit(s)'} for release.`,'ok');
    return;
  }
  // For purchase-kind entries, just mark as prepared/expected
  entry.status='Prepared';
  entry.preparedBy=_currentUser?.name||'–';
  entry.preparedAt=nowISO();
  entry.updatedAt=nowISO();
  saveDB(); renderDashboard();
  toast('Success: Item prepared for release.','ok');
}

// ── AUTO-GENERATE PO NUMBER (Feature 2) ───────────────────────
function normalizePONumber(raw) {
  const m=String(raw||'').trim().toUpperCase().match(/^RS(\d{4})[-_]?(\d+)$/);
  if(!m) return String(raw||'').trim();
  return `RS${m[1]}_${String(parseInt(m[2],10)).padStart(4,'0')}`;
}

function parsePONumber(no) {
  const m=normalizePONumber(no).match(/^RS(\d{4})_(\d+)$/i);
  if(!m) return null;
  return {year:parseInt(m[1],10),seq:parseInt(m[2],10)};
}

function generateNextPONumber(forYear) {
  const year=forYear||new Date().getFullYear();
  const prefix=`RS${year}_`;
  const nums=DB.purchase_orders.map(p=>{
    const parsed=parsePONumber(p.no);
    return parsed&&parsed.year===year?parsed.seq:0;
  });
  const next=(nums.length?Math.max(...nums):0)+1;
  return prefix+String(next).padStart(4,'0');
}

function isPONumberDuplicate(no, excludeId) {
  const n=String(no||'').trim();
  if(!n) return false;
  return DB.purchase_orders.some(p=>String(p.no||'').trim().toLowerCase()===n.toLowerCase()&&p.id!==excludeId);
}

function ensureUniquePONumber(preferred) {
  let no=String(preferred||'').trim();
  if(!parsePONumber(no)) no=generateNextPONumber();
  let parsed=parsePONumber(no);
  let guard=0;
  while(isPONumberDuplicate(no,null)&&guard<500) {
    const year=parsed?.year||new Date().getFullYear();
    const seq=(parsed?.seq||0)+1;
    no=`RS${year}_`+String(seq).padStart(4,'0');
    parsed=parsePONumber(no);
    guard++;
  }
  if(isPONumberDuplicate(no,null)) no=generateNextPONumber();
  return no;
}

let _pendingTicketConversion = null;

function prefillPOFromTicket(ticket) {
  if(!ticket) return;
  const pmEl=poEl('po-f-pm');
  const remarksEl=poEl('po-f-remarks');
  const projEl=poEl('po-f-project');
  if(pmEl) pmEl.value=ticket.pm||ticket.engineerName||_currentUser?.name||'';
  if(projEl) projEl.value=ticket.project||'';
  if(remarksEl) {
    remarksEl.value=`Converted from ${ticket.no}${ticket.siteLocation?` · ${ticket.siteLocation}`:''}${ticket.remarks?` · ${ticket.remarks}`:''}`;
    remarksEl.dataset.fromTicketId = ticket.id;
    remarksEl.dataset.fromTicketNo = ticket.no;
  }
  poLineItems.slice().forEach(id=>poEl('poli-'+id)?.remove());
  poLineItems=[];
  (ticket.materials||[]).forEach(m=>{
    if((m.remainingQty||0) > 0) {
      addPOLineItem();
      const id=poLineItems[poLineItems.length-1];
      const descEl=poEl('polid-'+id);
      const qtyEl=poEl('poliq-'+id);
      const unitEl=poEl('poliu-'+id);
      const projTagEl=poEl('polipj-'+id);
      if(descEl) descEl.value=m.name||'';
      if(qtyEl) qtyEl.value=m.remainingQty||m.requestedQty||'';
      if(unitEl) unitEl.value=m.unit||'';
      if(projTagEl) projTagEl.value=ticket.project||'';
      updatePOItemStatus(id);
    }
  });
  calcPOTotal();
}

function proceedConvertTicketToPO(ticket) {
  _pendingTicketConversion=ticket;
  const targetPage=_currentUser?.role==='po_officer' ? 'po-new-po' : 'req-new-po';
  navigate(targetPage, document.querySelector(`[data-page="${targetPage}"]`));
}

function convertTicketToPO(ticketId) {
  const ticket=DB.tickets.find(x=>x.id===ticketId);
  if(!ticket) { toast('Error: Order not found.'); return; }
  if(ticket.linkedPOId) { toast('Warning: This order is already linked to a PO.'); return; }
  if(!ticket.inventoryReviewedAt) {
    toast('Error: Inventory Manager must review warehouse stock and release available items first.');
    return;
  }
  if(!ticketNeedsPurchase(ticket)) {
    toast('Warning: This order has no purchase shortages — nothing to buy.');
    return;
  }

  if(ticket.bossApproved&&ticket.financeApproved) {
    appendTicketAudit(ticket,'PO bypassed gate','Billing gate bypassed — Boss & Finance approved');
    saveDB();
    proceedConvertTicketToPO(ticket);
    return;
  }

  if(ticketHasPaidBilling(ticket.projectId)) {
    appendTicketAudit(ticket,'Billing gate passed','Paid customer invoice on file — PO allowed');
    saveDB();
    proceedConvertTicketToPO(ticket);
    return;
  }

  const proj=DB.projects.find(p=>p.id===ticket.projectId);
  const client=proj?.client||ticket.client||'Unknown Client';
  const projectName=ticket.project||proj?.name||'Unknown Project';
  appendTicketAudit(ticket,'Entry gate blocked',`Billing gate blocked — no paid invoice for ${projectName}`);
  ticket.status='Pending Override';
  ticket.bossApproved=false;
  ticket.financeApproved=false;
  saveDB();

  openBillingGateModal(ticket);
  toast('Billing gate blocked. Use Notify for Override to alert Boss and Finance.','warn');

  if(currentPage==='po-dashboard') renderPODashboard();
  if(currentPage==='acc-dashboard') renderAccDashboard();
  if(currentPage==='boss-dashboard') renderBossDashboard();
  if(currentPage==='boss-override-queue') renderBossOverrideQueue();
  updateOverrideNavBadge();
}

// ── PO FORM (Features 2,3,4,5) ────────────────────────────────
let poLineItems=[];
let _poFormWrapId='req-po-form-wrap';

function poFormWrap() { return document.getElementById(_poFormWrapId); }
function poEl(id) { const w=poFormWrap(); return w?w.querySelector('#'+id):document.getElementById(id); }

function initPOForm(wrapId) {
  _poFormWrapId = wrapId||'req-po-form-wrap';
  poLineItems=[];
  const otherWrapId=_poFormWrapId==='po-officer-form-wrap'?'req-po-form-wrap':'po-officer-form-wrap';
  const otherWrap=document.getElementById(otherWrapId);
  if(otherWrap) otherWrap.innerHTML='';
  const wrap=document.getElementById(_poFormWrapId);
  if(!wrap) return;
  const poNo=generateNextPONumber();
  const cancelPage=_poFormWrapId==='po-officer-form-wrap'?'po-dashboard':'req-dashboard';

  const suppliersOptions=DB.suppliers.map(s=>`<option value="${esc(s.name)}" data-id="${s.id}">`).join('');
  const projectOptions=DB.projects.map(p=>`<option value="${esc(p.name)}">`).join('');

  wrap.innerHTML=`
    ${isDemoSession()?`<div class="demo-form-banner"><span>Prototype demo — forms are fully functional.</span><button type="button" class="btn btn-ol btn-sm" onclick="fillSamplePOForm()">Load sample PO</button></div>`:''}
    <div class="fr2">
      <div class="fl">
        <div class="form-lbl">PO Number <span style="color:var(--rd);">*</span></div>
        <input class="fc" id="po-f-no" value="${poNo}" placeholder="e.g. RS2026_0042">
        <div style="font-size:10.5px;color:var(--faint);margin-top:4px;">Auto-generated · You may override manually.</div>
      </div>
      <div class="fl"><div class="form-lbl">Date</div><input class="fc" id="po-f-date" type="date" value="${today()}" onchange="poUpdateDueDate()"></div>
    </div>
    
    <div class="fr2">
      <div class="fl"><div class="form-lbl">Credit Terms (days)</div>
        <input class="fc" id="po-f-terms" type="number" min="0" value="0" placeholder="0 = COD" oninput="poUpdateDueDate()">
        <div style="font-size:10.5px;color:var(--faint);margin-top:4px;">Auto-filled from supplier · Editable</div>
      </div>
      <div class="fl"><div class="form-lbl">Due Date (auto-computed)</div>
        <input class="fc" id="po-f-duedate" type="date" readonly style="background:var(--paper);">
        <div style="font-size:10.5px;color:var(--faint);margin-top:4px;">PO Date + Terms Days</div>
      </div>
    </div>
    <div class="fr2">
      <div class="fl"><div class="form-lbl">Project Manager</div><input class="fc" id="po-f-pm" placeholder="PM name"></div>
      <div class="fl"><div class="form-lbl">Warehouse Handler / Buyer</div><input class="fc" id="po-f-warehouse" placeholder="Person buying the materials"></div>
    </div>
    <div class="fr2">
      <div class="fl"><div class="form-lbl">Payment Option</div>
        <select class="fc" id="po-f-payoption">
          <option value="COD">COD</option>
          <option value="Check">Check</option>
          <option value="Cash">Cash</option>
          <option value="Bank Transfer">Bank Transfer</option>
        </select>
      </div>
      <div class="fl"><div class="form-lbl">Bank Details</div><input class="fc" id="po-f-bank" placeholder="Bank name, account name, or account no."></div>
    </div>
    <div class="fl"><div class="form-lbl">Requested By</div><input class="fc" id="po-f-requisitor" readonly value="${_currentUser?.name||''}"></div>
    <div style="font-family:'Syne',sans-serif;font-size:11px;font-weight:700;color:var(--soft);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;margin-top:6px;">Line Items</div>
    <div id="po-li-items"></div>
    <button class="add-mat-btn" onclick="addPOLineItem()">+ Add Line Item</button>
    <div class="fl" style="margin-top:14px;"><div class="form-lbl">Remarks</div><input class="fc" id="po-f-remarks" placeholder="Notes or special instructions"></div>
    <div style="margin-top:8px;padding:12px 16px;background:var(--paper);border-radius:var(--r);font-family:'Syne',sans-serif;font-size:13px;font-weight:800;">
      Total: <span id="po-total-preview">₱0.00</span>
    </div>
    <div style="display:flex;gap:8px;margin-top:18px;flex-wrap:wrap;">
      <button type="button" class="btn btn-ol" onclick="navigate('${cancelPage}')">Cancel</button>
      <button type="button" class="btn btn-mg btn-lg" id="po-submit-btn">Submit P.O.</button>
    </div>`;

  poUpdateDueDate();
  addPOLineItem();
  wrap.querySelector('#po-submit-btn')?.addEventListener('click', savePO);
  if(_pendingTicketConversion) prefillPOFromTicket(_pendingTicketConversion);
  else if(isDemoSession()) setTimeout(fillSamplePOForm, 80);
}

function fillSamplePOForm() {
  if(_pendingTicketConversion) {
    toast('Ticket data already loaded for this PO.','ok');
    return;
  }
  poLineItems.slice().forEach(id=>poEl('poli-'+id)?.remove());
  poLineItems=[];
  addPOLineItem();
  const id=poLineItems[0];
  if(!id) return;
  const set=(suffix,val)=>{const el=poEl('pol'+suffix+'-'+id)||poEl('po-f-'+suffix);if(el)el.value=val;};
  const desc=poEl('polid-'+id);
  if(desc) { desc.value='PLUMBING:PVC PIPE 2 INCH'; updatePOItemStatus(id); }
  const qty=poEl('poliq-'+id); if(qty) qty.value='12';
  const unit=poEl('poliu-'+id); if(unit) unit.value='LEN';
  const proj=poEl('polipj-'+id);
  if(proj) proj.value='Smilee Monumento — Interior Fit-out';
  const wh=poEl('polwh-'+id); if(wh) wh.value='MAY_006';
  const supSel=poEl('polsup-'+id);
  if(supSel) {
    const neltex=[...supSel.options].find(o=>o.textContent.includes('Neltex'));
    if(neltex) supSel.value=neltex.value;
    else if(supSel.options.length>1) supSel.selectedIndex=1;
    updatePOLineItemPriceFromSupplier(id);
  }
  const pm=poEl('po-f-pm'); if(pm) pm.value='Marco Rivera';
  const whb=poEl('po-f-warehouse'); if(whb) whb.value='Danny Pascual';
  const rem=poEl('po-f-remarks'); if(rem) rem.value='Demo PO — Smilee operatory PVC rough-in';
  calcPOTotal();
  toast('Sample PO loaded — review and submit.','ok');
}

function poOnSupplierChange() {
  const name=poEl('po-f-vendor')?.value||'';
  const sup=DB.suppliers.find(s=>s.name===name);
  const infoEl=poEl('po-supplier-info');
  if(sup) {
    if(infoEl) infoEl.innerHTML=`<span class="terms-tag">💳 ${sup.terms>0?sup.terms+' day terms':'COD'}</span> ${sup.contact?`<span style="margin-left:8px;color:var(--soft);">${esc(sup.contact)}</span>`:''}`;
    // Auto-fill terms
    const termsEl=poEl('po-f-terms');
    if(termsEl) { termsEl.value=sup.terms||0; poUpdateDueDate(); }
    // Refresh all line item prices for this supplier
    poLineItems.forEach(id=>updatePOLineItemPriceFromSupplier(id));
  } else {
    if(infoEl) infoEl.innerHTML='';
  }
}

function poOnProjectChange() {
  const name=poEl('po-f-project')?.value||'';
  const proj=DB.projects.find(p=>p.name===name);
  const infoEl=poEl('po-project-info');
  if(proj) {
    if(infoEl) infoEl.innerHTML=`<span class="project-code">${esc(proj.code||'')}</span> <span style="color:var(--soft);font-size:11px;">${esc(proj.client||'')}</span>`;
    // Default all item project tags to this project
    poLineItems.forEach(id=>{
      const projSel=poEl('polipj-'+id);
      if(projSel&&!projSel.value) projSel.value=name;
    });
  } else {
    if(infoEl) infoEl.innerHTML='';
  }
}

function poUpdateDueDate() {
  const date=poEl('po-f-date')?.value||today();
  const terms=parseInt(poEl('po-f-terms')?.value)||0;
  const dueEl=poEl('po-f-duedate');
  if(dueEl) {
    if(terms>0) {
      const due=addDays(date,terms);
      dueEl.value=due;
      const ds=dueDateStatus(due);
      dueEl.style.background=ds==='ok'?'var(--paper)':ds==='warn'?'#fff3cd':'#f8d7da';
    } else {
      dueEl.value='';
      dueEl.style.background='var(--paper)';
    }
  }
}

function addPOLineItem() {
  const id=uid(); poLineItems.push(id);
  const wrap=poEl('po-li-items');
  if(!wrap) return;
  const projectOptions=DB.projects.map(p=>`<option value="${esc(p.name)}">`).join('');
  const currentProject='';
  const div=document.createElement('div');
  div.className='po-li-row'; div.id='poli-'+id;
  div.innerHTML=`
    <datalist id="poidl-${id}">${DB.inventory.map(i=>`<option value="${esc(i.name)}">`).join('')}</datalist>
    <datalist id="popdl-${id}">${projectOptions}</datalist>
    <div class="po-li-top">
      <div class="po-li-field">
        <div class="form-lbl">Description</div>
        <input class="fc" list="poidl-${id}" id="polid-${id}" placeholder="Item description" oninput="updatePOItemStatus('${id}')">
        <div id="politeminfo-${id}" class="po-li-meta po-li-inline-info">&nbsp;</div>
      </div>
      <div class="po-li-field" id="po-li-supplier-wrap-${id}">
        <div class="form-lbl">Supplier for Item</div>
        <select class="fc" id="polsup-${id}" onchange="updatePOLineItemPriceFromSupplier('${id}')">
        <option value="">Auto-select best price</option>
        </select>
        <div id="polsupinfo-${id}" class="po-li-meta">Choose an item to see matching suppliers.</div>
      </div>
    </div>
    <div class="po-li-bottom">
      <div class="po-li-field">
        <div class="form-lbl">Qty</div><input class="fc" id="poliq-${id}" type="number" min="1" placeholder="0" oninput="updatePOItemStatus('${id}')">
      </div>
      <div class="po-li-field">
        <div class="form-lbl">Unit</div><input class="fc" id="poliu-${id}" placeholder="PCS">
      </div>
      <div class="po-li-field" id="po-li-price-wrap-${id}">
        <div class="form-lbl">Unit Price (₱)</div><input class="fc" id="polip-${id}" type="number" min="0" placeholder="0.00" oninput="calcPOTotal()">
      </div>
      <div class="po-li-field">
        <div class="form-lbl">Stock</div>
        <div id="polis-${id}" class="po-li-stockbox">–</div>
      </div>
      <div class="po-li-field">
        <div class="form-lbl">Project Tag <span style="color:var(--rd);">*</span></div>
        <input class="fc" list="popdl-${id}" id="polipj-${id}" value="${esc(currentProject)}" placeholder="Tag to project…">
      </div>
      <div class="po-li-actions">
        <button class="btn btn-ol btn-sm" onclick="removePOLine('${id}')">✕</button>
      </div>
    </div>
    <div class="po-li-bottom" style="margin-top:12px;grid-template-columns:minmax(220px,1fr) minmax(160px,.7fr) auto;">
      <div class="po-li-field">
        <div class="form-lbl">WH Order No.</div><input class="fc" id="polwh-${id}" placeholder="e.g. MAY_005">
      </div>
      <div class="po-li-field">
        <div class="form-lbl">Supplier Note</div>
        <div id="polsupnote-${id}" class="po-li-meta">Best price will be selected automatically when available.</div>
      </div>
      <div></div>
    </div>`;
  wrap.appendChild(div);
  // Auto-fill WH order from project
  if(currentProject) {
    const proj=DB.projects.find(p=>p.name===currentProject);
    if(proj) { const whEl=poEl('polwh-'+id); if(whEl&&proj.code) whEl.value=proj.code; }
  }
}

function updatePOItemStatus(id) {
  const itemName=poEl('polid-'+id)?.value.trim();
  const statusEl=poEl('polis-'+id);
  const supplierWrap=poEl('po-li-supplier-wrap-'+id);
  const priceWrap=poEl('po-li-price-wrap-'+id);
  const itemInfo=poEl('politeminfo-'+id);
  const supplierInfo=poEl('polsupinfo-'+id);
  if(!statusEl) return;
  const item=findInventoryItem(itemName);
  if(item) {
    const s=stockStatus(item);
    statusEl.textContent=`${getAvailableQty(item)} avail`;
    statusEl.style.background=s.cls==='ok'?'#d4edda':s.cls==='low'?'#fff3cd':'#f8d7da';
    statusEl.style.color=s.cls==='ok'?'#155724':s.cls==='low'?'#856404':'#721c24';
    const unitEl=poEl('poliu-'+id); if(unitEl) unitEl.value=item.unit;
    const shortageState=getPOLineShortageState(id);
    const buyingNeeded=shortageState.purchaseQty>0;
    if(itemInfo) {
      if(shortageState.requestedQty<=0) {
        itemInfo.innerHTML='<span style="color:var(--faint);">Enter a quantity to see whether the item should be bought.</span>';
      } else if(shortageState.shortageQty>0) {
        itemInfo.innerHTML=`<span class="terms-tag">Need to buy ${shortageState.shortageQty} ${esc(item.unit||'PCS')}</span> <span style="margin-left:8px;color:var(--soft);">${shortageState.availableQty} available · ${shortageState.requestedQty} requested</span>`;
      } else {
        itemInfo.innerHTML=`<span class="terms-tag">PO qty ${shortageState.purchaseQty} ${esc(item.unit||'PCS')}</span> <span style="margin-left:8px;color:var(--soft);">${shortageState.availableQty} available in warehouse</span>`;
      }
    }
    if(supplierWrap) supplierWrap.style.display=buyingNeeded?'':'none';
    if(priceWrap) priceWrap.style.display=buyingNeeded?'':'none';
    if(buyingNeeded) {
      updatePOLineSupplierOptions(id, itemName);
      updatePOLineItemPriceFromSupplier(id);
    } else {
      const select=poEl('polsup-'+id);
      const price=poEl('polip-'+id);
      if(select) select.innerHTML='<option value="">Warehouse item</option>';
      if(price) price.value='';
      if(supplierInfo) supplierInfo.innerHTML='';
    }
  } else {
    statusEl.textContent='–';
    statusEl.style.background='var(--paper)';
    statusEl.style.color='var(--faint)';
    if(itemInfo) itemInfo.innerHTML='<span style="color:var(--faint);">Select a valid item to see warehouse status and supplier options.</span>';
    if(supplierWrap) supplierWrap.style.display='';
    if(priceWrap) priceWrap.style.display='';
    const select=poEl('polsup-'+id);
    const info=poEl('polsupinfo-'+id);
    if(select) select.innerHTML='<option value="">Auto-select best price</option>';
    if(info) info.innerHTML='<span style="color:var(--faint);">Select a valid item to see supplier matches.</span>';
  }
  calcPOTotal();
}

function updatePOLineItemPriceFromSupplier(id) {
  const itemName=poEl('polid-'+id)?.value.trim();
  const supEl=poEl('polsup-'+id);
  const infoEl=poEl('polsupinfo-'+id);
  const priceEl=poEl('polip-'+id);
  if(!itemName) return;

  // If user picked the inline 'Add new supplier' option, launch add flow
  if(supEl && supEl.value==='__add_new__') { addSupplierFromLineItem(id); return; }

  const shortageState=getPOLineShortageState(id);
  if(shortageState.purchaseQty<=0) {
    if(priceEl) priceEl.value='';
    if(infoEl) infoEl.innerHTML='<span style="color:var(--faint);">Enter a quantity to price this line.</span>';
    calcPOTotal();
    return;
  }

  const resolved=resolvePOLineSupplier(id, itemName);
  if(resolved) {
    if(supEl && supEl.value!==resolved.supplier.id) supEl.value=resolved.supplier.id;
    if(priceEl) priceEl.value=resolved.priceRec.price;
    if(infoEl) {
      const altCount=Math.max(0, getSupplierPriceOptions(itemName).length-1);
      infoEl.innerHTML=`<span class="terms-tag">Using ${esc(formatSupplierPriceLabel(resolved))}</span>${altCount?` <span style="margin-left:8px;color:var(--soft);">${altCount} other price option(s)</span>`:''}`;
    }
    calcPOTotal();
  } else {
    if(infoEl) infoEl.innerHTML='<span style="color:var(--faint);">No supplier price found for this item yet. You can still enter a manual price.</span>';
  }
}

function removePOLine(id) { poLineItems=poLineItems.filter(x=>x!==id); poEl('poli-'+id)?.remove(); calcPOTotal(); }

function calcPOTotal() {
  let total=0;
  for(const id of poLineItems) {
    const shortageState=getPOLineShortageState(id);
    const p=parseFloat(poEl('polip-'+id)?.value)||0;
    total+=shortageState.purchaseQty*p;
  }
  const el=poEl('po-total-preview'); if(el) el.textContent=peso(total);
}

function inferPOItemProject(id) {
  let proj=(poEl('polipj-'+id)?.value||'').trim();
  if(proj) return proj;
  const wh=(poEl('polwh-'+id)?.value||'').trim();
  if(wh) {
    const match=DB.projects.find(p=>(p.code||'').toLowerCase()===wh.toLowerCase());
    if(match) return match.name;
  }
  const fromTicketId=poEl('po-f-remarks')?.dataset.fromTicketId;
  if(fromTicketId) {
    const t=DB.tickets.find(x=>x.id===fromTicketId);
    if(t?.project) return t.project;
  }
  if(_pendingTicketConversion?.project) return _pendingTicketConversion.project;
  return '';
}

function savePO() {
  let no=normalizePONumber(poEl('po-f-no')?.value||'');
  const noEl=poEl('po-f-no');
  if(noEl) noEl.value=no;
  // Vendor and project are derived from line items (per-item supplier/project).
  let vendor = '';
  let project = '';
  const pm=(poEl('po-f-pm')?.value||'').trim();
  const warehouseHandler=(poEl('po-f-warehouse')?.value||'').trim();
  const paymentOption=(poEl('po-f-payoption')?.value||'COD').trim();
  const bankDetails=(poEl('po-f-bank')?.value||'').trim();
  const requisitor=(poEl('po-f-requisitor')?.value||_currentUser?.name||'').trim();
  const remarks=(poEl('po-f-remarks')?.value||'').trim();
  const date=(poEl('po-f-date')?.value)||today();
  const terms=parseInt(poEl('po-f-terms')?.value)||0;
  const dueDate=poEl('po-f-duedate')?.value||'';
  const remarksEl=poEl('po-f-remarks');
  const fromTicketId=remarksEl?.dataset.fromTicketId||'';
  const fromTicketNo=remarksEl?.dataset.fromTicketNo||'';

  if(!no) { toast('Error: PO Number is required.'); return; }
  if(!parsePONumber(no)) { toast('Error: PO number must follow format RS2026_0042 (RS + year + _ + sequence).'); return; }
  if(isPONumberDuplicate(no,null)) {
    no=ensureUniquePONumber(no);
    const noEl=poEl('po-f-no');
    if(noEl) noEl.value=no;
  }


  const items=[];
  for(const id of poLineItems) {
    const desc=(poEl('polid-'+id)?.value||'').trim();
    if(!desc) continue;
    const shortageState=getPOLineShortageState(id);
    if(shortageState.requestedQty<=0) continue;
    const unit=(poEl('poliu-'+id)?.value||'PCS').trim();
    let unitPrice=parseFloat(poEl('polip-'+id)?.value)||0;
    const itemProject=inferPOItemProject(id)||project;
    const whOrderNo=(poEl('polwh-'+id)?.value||'').trim();
    const qty=shortageState.purchaseQty;
    if(qty<=0) continue;
    const supplierChoice=resolvePOLineSupplier(id, desc);
    const supplierId=supplierChoice?.supplier?.id||'';
    const supplierName=supplierChoice?.supplier?.name||'';
    const supplierPrice=supplierChoice?.priceRec?.price||'';
    if(!unitPrice&&supplierChoice?.priceRec?.price) unitPrice=parseFloat(supplierChoice.priceRec.price)||0;
    if(!supplierName) { toast('Error: Select a supplier for each line item (or pick a registered inventory item with supplier prices).'); return; }
    if(unitPrice<=0) { toast('Error: Enter a unit price for each line item.'); return; }
    items.push({desc,qty,requestedQty:shortageState.requestedQty,availableQty:shortageState.availableQty,unit,unitPrice,project:itemProject,whOrderNo,supplierId,supplierName,supplierPrice});
  }
  // Derive PO-level vendor/project from line items when possible
  const distinctVendors = [...new Set(items.map(i=>i.supplierName).filter(Boolean))];
  const distinctProjects = [...new Set(items.map(i=>i.project).filter(Boolean))];
  vendor = distinctVendors.length===1 ? distinctVendors[0] : (distinctVendors.length ? distinctVendors.join(', ') : '');
  project = distinctProjects.length===1 ? distinctProjects[0] : (distinctProjects.length ? distinctProjects.join(', ') : '');
  if(!items.length) { toast('Error: Add at least one line item.'); return; }

  // Feature 5: validate each item is tagged to a project
  const untagged=items.filter(i=>!i.project);
  if(untagged.length) { toast(`Error: All line items must be tagged to a project. ${untagged.length} item(s) missing project tag.`); return; }

  const primarySupplier=items[0]?.supplierId
    ?DB.suppliers.find(s=>s.id===items[0].supplierId)
    :DB.suppliers.find(s=>s.name===vendor);
  const po={
    id:uid(), no, vendor, supplierId:primarySupplier?.id||items[0]?.supplierId||'', project, pm, date,
    terms, dueDate, paymentOption, bankDetails, remarks, status:'Pending',
    createdBy:_currentUser?.name||'–', requisitor, warehouseHandler, items,
    audit_trail:[{action:'Created', by:_currentUser?.name||'–', at:nowISO(), note:'Submitted for approval.'}],
  };
  DB.purchase_orders.unshift(po);
  syncPoReleaseQueueFromPO(po);
  if(fromTicketId) {
    po.fromTicketId=fromTicketId;
    po.fromTicketNo=fromTicketNo;
    pushPOAudit(po,'Converted from Ticket',`Created from ticket ${fromTicketNo}.`);
    const ticket=DB.tickets.find(t=>t.id===fromTicketId);
    if(ticket) {
      ticket.linkedPOId=po.id;
      ticket.linkedPONo=po.no;
    }
    if(remarksEl) {
      delete remarksEl.dataset.fromTicketId;
      delete remarksEl.dataset.fromTicketNo;
    }
    _pendingTicketConversion=null;
  }
  saveDB(); updateAccStats();
  const queuedItems=(DB.po_release_queue||[]).filter(q=>q.poId===po.id).slice(0,3).map(q=>q.itemLabel).join(', ');
  pushNotification({type:'blue',title:'PO waiting for approval',text:`${no} has shortage items queued for purchase${queuedItems?`: ${queuedItems}`:''}.`,roles:['admin','accountant','po_officer','inventory_manager'],source:'po-created'});
  toast('Success: Purchase order submitted!','ok');
  showPOReceipt(po.id);
  const backPage=_poFormWrapId==='po-officer-form-wrap'?'po-dashboard':'req-dashboard';
  navigate(backPage, document.querySelector(`[data-page="${backPage}"]`));
}

// ── PO INBOX & DETAIL ─────────────────────────────────────────
function poRenderInbox() {
  const q=(document.getElementById('po-inbox-search')?.value||'').toLowerCase();
  const f=document.getElementById('po-inbox-filter')?.value||'all';
  const filtered=DB.purchase_orders.filter(p=>{
    const mq=!q||p.no.toLowerCase().includes(q)||p.vendor.toLowerCase().includes(q)||(p.project||'').toLowerCase().includes(q);
    const mf=f==='all'||p.status===f;
    return mq&&mf;
  });
  const el=document.getElementById('acc-po-inbox-content');
  if(!el) return;
  const badgeMap={'Pending':'pending','Approved':'ok','Received':'completed','Cancelled':'overdue'};
  el.innerHTML = !filtered.length
    ? '<div class="empty-state"><div class="empty-icon">📋</div>No purchase orders found.</div>'
    : `<table style="width:100%;border-collapse:collapse;min-width:700px;">
        <thead><tr style="background:#fafafa;border-bottom:2px solid var(--bd);">
          <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--faint);">PO #</th>
          <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--faint);">Vendor</th>
          <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--faint);">Project</th>
          <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--faint);">Date</th>
          <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--faint);">Due Date</th>
          <th style="padding:10px 14px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--faint);">Total</th>
          <th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--faint);">Status</th>
          <th style="padding:10px 14px;"></th>
        </tr></thead>
        <tbody>${filtered.map(p=>{
          const total=p.items.reduce((s,i)=>s+(i.qty||0)*(i.unitPrice||0),0);
          const ds=p.dueDate?dueDateStatus(p.dueDate):'ok';
          const dueTxt=p.dueDate?`<span class="due-tag ${ds}" style="padding:2px 8px;font-size:10px;">${ds==='overdue'?'OVERDUE':'Due '+fmtDate(p.dueDate)}</span>`:'<span style="color:var(--faint);font-size:11px;">COD</span>';
          return `<tr style="border-bottom:1px solid var(--bd);cursor:pointer;" onmouseover="this.style.background='#fdf5fa'" onmouseout="this.style.background=''" onclick="openPODetail('${p.id}')">
            <td style="padding:10px 14px;font-family:'Syne',sans-serif;font-size:12px;font-weight:800;color:var(--mg);">${p.no}</td>
            <td style="padding:10px 14px;font-weight:500;font-size:12.5px;">${esc(p.vendor)}</td>
            <td style="padding:10px 14px;font-size:12px;"><span class="po-item-project-tag">${esc(p.project||'–')}</span></td>
            <td style="padding:10px 14px;font-size:11.5px;color:var(--faint);">${fmtDate(p.date)}</td>
            <td style="padding:10px 14px;">${dueTxt}</td>
            <td style="padding:10px 14px;text-align:right;font-weight:700;">${peso(total)}</td>
            <td style="padding:10px 14px;"><span class="badge badge-${badgeMap[p.status]||'pending'}">${p.status}</span></td>
            <td style="padding:10px 14px;"><button class="btn btn-ol btn-sm" onclick="event.stopPropagation();openPODetail('${p.id}')">View →</button></td>
          </tr>`;
        }).join('')}</tbody></table>`;
}

function openPODetail(id) {
  const p=DB.purchase_orders.find(x=>x.id===id); if(!p) return;
  const total=p.items.reduce((s,i)=>s+(i.qty||0)*(i.unitPrice||0),0);
  const ds=p.dueDate?dueDateStatus(p.dueDate):'ok';

  document.getElementById('po-detail-side-info').innerHTML=`
    <div class="si-row"><div class="si-label">PO Number</div><div class="si-val" style="font-family:'Syne',sans-serif;font-weight:800;color:#fff;">${esc(p.no)}</div></div>
    <div class="si-row"><div class="si-label">Vendor</div><div class="si-val">${esc(p.vendor)}</div></div>
    <div class="si-row"><div class="si-label">Project</div><div class="si-val"><span class="po-item-project-tag">${esc(p.project||'–')}</span></div></div>
    <div class="si-row"><div class="si-label">Date</div><div class="si-val">${fmtDate(p.date)}</div></div>
    <div class="si-row"><div class="si-label">Credit Terms</div><div class="si-val"><span class="terms-tag">💳 ${p.terms>0?p.terms+' days':'COD'}</span></div></div>
    <div class="si-row"><div class="si-label">Payment Option</div><div class="si-val">${esc(p.paymentOption||'COD')}</div></div>
    ${p.bankDetails?`<div class="si-row"><div class="si-label">Bank Details</div><div class="si-val">${esc(p.bankDetails)}</div></div>`:''}
    ${p.dueDate?`<div class="si-row"><div class="si-label">Payment Due</div><div class="si-val"><span class="due-tag ${ds}">${ds==='overdue'?'OVERDUE':'Due '+fmtDate(p.dueDate)}</span></div></div>`:''}
    <div class="si-row"><div class="si-label">Total</div><div class="si-val" style="font-size:14px;font-weight:800;color:var(--mg);">${peso(total)}</div></div>
    <div class="si-row"><div class="si-label">Created By</div><div class="si-val">${esc(p.createdBy||'–')}</div></div>
    <div class="si-row"><div class="si-label">Requested By</div><div class="si-val">${esc(p.requisitor||'–')}</div></div>
    <div style="margin-top:14px;display:flex;flex-direction:column;gap:8px;">
      ${p.status==='Pending'?`<button class="btn btn-gn btn-sm" onclick="updatePOStatus('${p.id}','Approved')" style="justify-content:center;">✓ Approve</button><button class="btn btn-rd btn-sm" onclick="updatePOStatus('${p.id}','Cancelled')" style="justify-content:center;">✕ Cancel</button>`:''}
      ${p.status==='Approved'?`<button class="btn btn-bl btn-sm" onclick="updatePOStatus('${p.id}','Received')" style="justify-content:center;">📦 Mark Received</button>`:''}
      <button class="btn btn-ol btn-sm" onclick="navigate('acc-po-inbox',document.querySelector('[data-page=acc-po-inbox]'))" style="justify-content:center;background:rgba(255,255,255,.1);color:rgba(255,255,255,.7);border-color:rgba(255,255,255,.2);">← Back</button>
    </div>`;

  document.getElementById('po-detail-content').innerHTML=`
    <div style="padding:22px 28px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap;">
        <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:var(--mg);">${esc(p.no)}</div>
        <span class="badge badge-${p.status==='Pending'?'pending':p.status==='Approved'||p.status==='Received'?'completed':'overdue'}">${p.status}</span>
        ${p.dueDate?`<span class="due-tag ${ds}">${ds==='overdue'?'OVERDUE':ds==='warn'?'Due Soon':'Due '+fmtDate(p.dueDate)}</span>`:''}
      </div>
      <div class="fr2">
        <div><div class="form-lbl">PM</div><div style="font-weight:600;">${esc(p.pm||'–')}</div></div>
        <div><div class="form-lbl">Remarks</div><div>${esc(p.remarks||'–')}</div></div>
        <div><div class="form-lbl">Payment Option</div><div>${esc(p.paymentOption||'COD')}</div></div>
        ${p.bankDetails?`<div><div class="form-lbl">Bank Details</div><div>${esc(p.bankDetails)}</div></div>`:''}
      </div>
      <div style="border-top:1px solid var(--bd);margin:12px 0 16px;"></div>
      <div style="font-family:'Syne',sans-serif;font-size:11px;font-weight:700;color:var(--soft);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">Line Items</div>
      <div class="tbl-wrap" style="margin-top:0;">
        <table>
          <thead><tr>
            <th>Description</th><th>Supplier</th><th style="text-align:right;">Qty</th><th>Unit</th>
            <th style="text-align:right;">Unit Price</th><th style="text-align:right;">Subtotal</th>
            <th>Project Tag</th><th>WH Order #</th>
          </tr></thead>
          <tbody>${p.items.map(i=>`<tr>
            <td style="font-weight:500;">${esc(i.desc)}</td>
            <td style="font-size:11px;color:var(--soft);">${esc(i.supplierName||p.vendor||'–')}</td>
            <td style="text-align:right;">${i.qty}</td>
            <td style="color:var(--soft);">${esc(i.unit)}</td>
            <td style="text-align:right;">${peso(i.unitPrice||0)}</td>
            <td style="text-align:right;font-weight:700;">${peso((i.qty||0)*(i.unitPrice||0))}</td>
            <td><span class="po-item-project-tag">${esc(i.project||p.project||'–')}</span></td>
            <td style="font-size:11px;color:var(--soft);">${esc(i.whOrderNo||'–')}</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr style="background:#fafafa;border-top:2px solid var(--bd);">
            <td colspan="4" style="padding:10px 14px;text-align:right;font-weight:700;font-family:'Syne',sans-serif;">TOTAL</td>
            <td style="padding:10px 14px;text-align:right;font-family:'Syne',sans-serif;font-size:14px;font-weight:800;color:var(--mg);">${peso(total)}</td>
            <td colspan="2"></td>
          </tr></tfoot>
        </table>
      </div>
      ${p.audit_trail&&p.audit_trail.length?`<div style="margin-top:18px;">
        <div style="font-family:'Syne',sans-serif;font-size:11px;font-weight:700;color:var(--soft);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;">PO Audit Trail</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${p.audit_trail.map(a=>`<div style="border:1px solid var(--bd);border-radius:var(--r);padding:10px 14px;background:var(--white);">
            <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;"><strong style="color:var(--mg);font-size:12px;">${esc(a.action||'Action')}</strong><span style="font-size:11px;color:var(--faint);">${fmtDT(a.at)}</span></div>
            <div style="font-size:11.5px;color:var(--soft);margin-top:4px;">By ${esc(a.by||'–')}${a.note?` · ${esc(a.note)}`:''}</div>
          </div>`).join('')}
        </div>
      </div>`:''}
    </div>`;
  navigate('acc-po-detail', null);
}

function updatePOStatus(id, status) {
  const p=DB.purchase_orders.find(x=>x.id===id); if(!p) return;
  const old=p.status; p.status=status;
  if(old==='Pending'&&status==='Approved') {
    p.items.forEach(item=>{
      const inv=findInventoryItem(item.desc);
      if(inv) {
        const toBuy=Math.max(0,item.qty||0);
        item.expectedQty=toBuy;
        if(toBuy>0) {
          inv.expected=(inv.expected||0)+toBuy;
          DB.inventory_log.unshift({id:uid(),dt:nowISO(),type:'po',itemName:inv.name,qtyChange:toBuy,balanceAfter:inv.qty,remarks:`PO ${p.no} - ${toBuy} units expected from ${p.vendor}`});
        }
      }
    });
    p.approvedBy=_currentUser?.name||'–'; p.approvedAt=nowISO();
    syncPoReleaseQueueFromPO(p);
    updateInvPill();
    showPOReceipt(p.id);
    const pendingItems=(DB.po_release_queue||[]).filter(q=>q.poId===p.id&&q.status!=='Prepared');
    const itemSummary=pendingItems.slice(0,3).map(item=>item.itemLabel).join(', ');
    pushNotification({type:'orange',title:'PO approved',text:`${p.no} approved. Inventory can now expect delivery${itemSummary?`: ${itemSummary}${pendingItems.length>3?'...':''}`:''}.`,roles:['admin','accountant','inventory_manager','po_officer'],source:'po-approved'});
    pushPOAudit(p,'Approved',`Approved by ${_currentUser?.name||'–'}.`);
  }
  if(old==='Approved'&&status==='Received') {
    p.items.forEach(item=>{
      const inv=findInventoryItem(item.desc); const qty=item.expectedQty||0;
      if(inv&&qty>0) {
        inv.expected=Math.max(0,(inv.expected||0)-qty);
        inv.qty=(inv.qty||0)+qty;
        inv.lastSupplier=p.vendor; inv.lastBoughtAt=p.date||today();
        item.receivedQty=qty; item.expectedQty=0;
        DB.inventory_log.unshift({id:uid(),dt:nowISO(),type:'in',itemName:inv.name,qtyChange:qty,balanceAfter:inv.qty,remarks:`PO ${p.no} received from ${p.vendor} - ${qty} units added`});
      }
    });
    ensurePoReleaseQueue().forEach(entry=>{ if(entry.poId===p.id) { entry.status='Delivered'; entry.updatedAt=nowISO(); } });
    updateInvPill();
    pushNotification({type:'green',title:'PO received',text:`${p.no} received. Stock updated.`,roles:['admin','accountant','inventory_manager'],source:'po-received'});
    pushPOAudit(p,'Received',`Marked received by ${_currentUser?.name||'–'}.`);
  }
  if(status==='Cancelled') pushPOAudit(p,'Cancelled',`Cancelled by ${_currentUser?.name||'–'}.`);
  saveDB(); updateAccStats();
  toast(`P.O. ${p.no} marked as ${status}.`,'ok');
  openPODetail(id);
}

function showPOReceipt(id) {
  const p=DB.purchase_orders.find(x=>x.id===id); if(!p) return;
  const total=p.items.reduce((s,i)=>s+(i.qty||0)*(i.unitPrice||0),0);
  const statusLabel=p.status||'Pending';
  const approvedLine=p.status==='Approved'||p.status==='Received'
    ? `<div><strong>Approved by:</strong> ${esc(p.approvedBy||'–')}</div>`
    : `<div><strong>Status:</strong> ${esc(statusLabel)} (awaiting approval)</div><div><strong>Submitted by:</strong> ${esc(p.createdBy||'–')}</div>`;
  const html=`<html><head><title>PO Receipt - ${p.no}</title>
  <style>body{font-family:Arial,Helvetica,sans-serif;color:#222;padding:20px} .hz{display:flex;justify-content:space-between;align-items:center}
  table{width:100%;border-collapse:collapse;margin-top:12px} th,td{padding:8px;border:1px solid #ddd;text-align:left} th{background:#f5f5f5}
  .tot{font-weight:800;font-size:15px;text-align:right} .tag{background:#f9e6f2;color:#8a0052;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700;}
  .btn{display:inline-block;padding:8px 12px;margin:10px 4px;border-radius:6px;color:#fff;text-decoration:none;cursor:pointer;border:none;}</style>
  </head><body>
  <div class="hz"><div><h2 style="margin:0;">Purchase Order</h2><div style="color:#666;">${esc(p.vendor)}</div></div>
  <div style="text-align:right;"><strong style="font-size:15px;">${esc(p.no)}</strong><br><span style="color:#666;">Date: ${fmtDate(p.date)}</span>${p.dueDate?`<br><span style="color:#d42020;">Payment Due: ${fmtDate(p.dueDate)}</span>`:''}</div></div>
  <div style="margin-top:12px;display:flex;gap:16px;flex-wrap:wrap;background:#f9f9f9;padding:10px;border-radius:6px;">
    <div><strong>Project:</strong> ${esc(p.project||'–')}</div>
    <div><strong>Terms:</strong> ${p.terms>0?p.terms+' days':'COD'}</div>
    <div><strong>Payment:</strong> ${esc(p.paymentOption||'COD')}</div>
    ${p.bankDetails?`<div><strong>Bank:</strong> ${esc(p.bankDetails)}</div>`:''}
    ${approvedLine}
    <div><strong>Remarks:</strong> ${esc(p.remarks||'–')}</div>
  </div>
  <table><thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Unit Price</th><th>Subtotal</th><th>Project Tag</th><th>WH Order</th></tr></thead>
  <tbody>${p.items.map(i=>`<tr><td>${esc(i.desc)}</td><td style="text-align:right">${i.qty}</td><td>${esc(i.unit)}</td><td style="text-align:right">₱${(i.unitPrice||0).toLocaleString()}</td><td style="text-align:right;font-weight:700">₱${((i.qty||0)*(i.unitPrice||0)).toLocaleString()}</td><td><span class="tag">${esc(i.project||p.project||'')}</span></td><td style="font-size:11px;color:#666">${esc(i.whOrderNo||'–')}</td></tr>`).join('')}</tbody>
  <tfoot><tr><td colspan="4" class="tot">TOTAL</td><td style="text-align:right;font-weight:800;font-size:15px">₱${total.toLocaleString()}</td><td colspan="2"></td></tr></tfoot></table>
  <div style="margin-top:28px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;">
    <div style="text-align:center"><div style="height:50px"></div><div style="color:#666;font-size:12px;">________________________</div><div style="color:#666;font-size:11px;">Authorized Signature</div></div>
    <div><button class="btn" style="background:#0b6" onclick="window.print()">Print</button><button class="btn" style="background:#09f" onclick="window.close()">Close</button></div>
  </div></body></html>`;
  const win=window.open('','_blank','width=900,height=700');
  if(win) {
    win.document.write(html);
    win.document.close();
    setTimeout(()=>{ try{win.focus();win.print();}catch(e){} },600);
    return;
  }
  const frame=document.getElementById('po-print-frame');
  if(frame) {
    frame.srcdoc=html;
    frame.onload=()=>{ try{frame.contentWindow.focus();frame.contentWindow.print();}catch(e){} };
    return;
  }
  const el=document.createElement('iframe');
  el.id='po-print-frame';
  el.style.cssText='position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(el);
  el.srcdoc=html;
  el.onload=()=>{ try{el.contentWindow.focus();el.contentWindow.print();}catch(e){ toast('PO saved. Allow pop-ups to print, or open PO from inbox and approve to print again.','warn'); } };
}

// ── PO OFFICER DASHBOARD ──────────────────────────────────────
function renderPODashboard() {
  const total=DB.purchase_orders.length;
  const pend=DB.purchase_orders.filter(p=>p.status==='Pending').length;
  const appr=DB.purchase_orders.filter(p=>p.status==='Approved').length;
  const recv=DB.purchase_orders.filter(p=>p.status==='Received').length;
  const requests=getTicketsForPOOfficer();
  const stEl=id=>document.getElementById(id);
  if(stEl('po-stat-total')) stEl('po-stat-total').textContent=total;
  if(stEl('po-stat-pending')) stEl('po-stat-pending').textContent=pend;
  if(stEl('po-stat-approved')) stEl('po-stat-approved').textContent=appr;
  if(stEl('po-stat-received')) stEl('po-stat-received').textContent=recv;
  if(stEl('po-req-cnt')) stEl('po-req-cnt').textContent=requests.length;
  updateOrderNavBadges();

  const reqEl=document.getElementById('po-req-list');
  if(reqEl) {
    reqEl.innerHTML=!requests.length
      ? '<div class="empty-state"><div class="empty-icon">📋</div>No purchase shortages yet.<br><span style="font-size:11.5px;">Orders appear here after Inventory Manager releases warehouse stock.</span></div>'
      : `<div class="dash-grid" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;">
          ${requests.slice(0,6).map(t=>{
            const shortages=t.materials.filter(m=>(m.remainingQty||0)>0).map(m=>`${m.name.split(':').pop()} ×${m.remainingQty}`).join(', ');
            const gate=getBillingGateStatus(t.projectId);
            const gateLbl=t.status==='Pending Override'
              ?'<span class="badge badge-pending-override" style="font-size:9px;">Override</span>'
              :gate.passed
                ?'<span class="badge badge-ok" style="font-size:9px;">Billing OK</span>'
                :'<span class="badge badge-unpaid" style="font-size:9px;">No paid inv.</span>';
            return `<div class="dash-widget" style="margin:0;">
              <div class="dash-widget-head">
                <div class="dash-widget-title" style="color:var(--mg);font-size:12px;">${esc(t.no)}</div>
                <span class="badge badge-at-po" style="font-size:9px;">At PO</span>
                ${gateLbl}
                ${t.urgent?'<span class="badge badge-urgent" style="font-size:9px;">URGENT</span>':''}
              </div>
              <div class="dash-widget-body" style="padding:12px 14px;">
                <div style="font-size:12px;font-weight:700;margin-bottom:4px;">${esc(t.project)}</div>
                <div style="font-size:11px;color:var(--soft);margin-bottom:8px;">${esc(t.siteLocation||'No site location noted')}</div>
                <div style="font-size:11px;color:var(--faint);line-height:1.6;">Engineer: ${esc(t.engineerName||t.submittedBy||'–')}<br>Inventory reviewed: ${fmtDate((t.inventoryReviewedAt||'').split('T')[0])}<br><strong style="color:var(--or);">Still need:</strong> ${esc(shortages||'–')}</div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
                  <button class="btn btn-ol btn-sm" onclick="viewTicketDetail('${t.id}')">Review</button>
                  ${!gate.passed&&!(t.bossApproved&&t.financeApproved)?`<button class="btn btn-or btn-sm" onclick="notifyOverrideRequest('${t.id}')">${t.status==='Pending Override'?'Resend override notice':'Notify for Override'}</button>`:''}
                  <button class="btn btn-mg btn-sm" onclick="convertTicketToPO('${t.id}')">Create PO</button>
                </div>
              </div>
            </div>`;
          }).join('')}
        </div>`;
  }

  const q=(document.getElementById('po-dash-search')?.value||'').toLowerCase();
  const f=document.getElementById('po-dash-filter')?.value||'all';
  const filtered=DB.purchase_orders.filter(p=>{
    const mq=!q||p.no.toLowerCase().includes(q)||(p.vendor||'').toLowerCase().includes(q);
    const mf=f==='all'||p.status===f;
    return mq&&mf;
  });
  const el=document.getElementById('po-dash-list');
  if(!el) return;
  const badgeMap={'Pending':'pending','Approved':'ok','Received':'completed','Cancelled':'overdue'};
  el.innerHTML=!filtered.length?'<div class="empty-state">No POs found.</div>':
    `<div class="tbl-wrap"><table><thead><tr>
      <th>PO #</th><th>Vendor</th><th>Project</th><th>Date</th><th>Due Date</th><th style="text-align:right;">Total</th><th>Status</th><th></th>
    </tr></thead><tbody>${filtered.map(p=>{
      const total=p.items.reduce((s,i)=>s+(i.qty||0)*(i.unitPrice||0),0);
      const ds=p.dueDate?dueDateStatus(p.dueDate):'ok';
      return `<tr style="cursor:pointer;" onmouseover="this.style.background='#fdf5fa'" onmouseout="this.style.background=''" onclick="openPODetail('${p.id}')">
        <td style="font-family:'Syne',sans-serif;font-weight:800;color:var(--mg);">${esc(p.no)}</td>
        <td>${esc(p.vendor)}</td>
        <td><span class="po-item-project-tag">${esc(p.project||'–')}</span></td>
        <td style="font-size:11.5px;color:var(--faint);">${fmtDate(p.date)}</td>
        <td>${p.dueDate?`<span class="due-tag ${ds}" style="font-size:10px;padding:2px 8px;">${ds==='overdue'?'OVERDUE':'Due '+fmtDate(p.dueDate)}</span>`:'<span style="color:var(--faint);font-size:11px;">COD</span>'}</td>
        <td style="text-align:right;font-weight:700;">${peso(total)}</td>
        <td><span class="badge badge-${badgeMap[p.status]||'pending'}">${p.status}</span></td>
        <td><button class="btn btn-ol btn-sm" onclick="event.stopPropagation();openPODetail('${p.id}')">View</button></td>
      </tr>`;
    }).join('')}</tbody></table></div>`;
}

// ── PO OFFICER PURCHASE ORDERS ───────────────────────────────
function renderReqDashboard() {
  const el=document.getElementById('req-po-list');
  if(!el) return;
  if(!DB.purchase_orders.length) { el.innerHTML='<div class="empty-state"><div class="empty-icon">📋</div>No POs created yet.</div>'; return; }
  el.innerHTML=DB.purchase_orders.map(p=>{
    const total=p.items.reduce((s,i)=>s+(i.qty||0)*(i.unitPrice||0),0);
    const ds=p.dueDate?dueDateStatus(p.dueDate):'ok';
    return `<div class="ticket-row">
      <div><div class="ticket-no">${esc(p.no)}</div><div style="font-size:11px;color:var(--faint);">${fmtDate(p.date)}</div></div>
      <div style="flex:1;"><div class="ticket-project">${esc(p.vendor)}</div><div class="ticket-mats">${esc(p.project||'–')}</div></div>
      ${p.dueDate?`<div><span class="due-tag ${ds}" style="font-size:10px;">${ds==='overdue'?'OVERDUE':'Due '+fmtDate(p.dueDate)}</span></div>`:''}
      <div style="font-weight:700;">${peso(total)}</div>
      <div><span class="badge badge-${p.status==='Pending'?'pending':p.status==='Approved'||p.status==='Received'?'completed':'overdue'}">${p.status}</span></div>
      <button class="btn btn-ol btn-sm" onclick="showPOReceipt('${p.id}')">Print</button>
    </div>`;
  }).join('');
}

// ── EXPENSES REPORT (Feature 1 - per project) ─────────────────
function initExpensesReport() {
  const sel=document.getElementById('exp-rpt-project');
  if(sel) {
    sel.innerHTML='<option value="">All Projects</option>'+DB.projects.map(p=>`<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
  }
  const fromEl=document.getElementById('exp-rpt-from');
  const toEl=document.getElementById('exp-rpt-to');
  if(fromEl&&!fromEl.value) fromEl.value='2025-01-01';
  if(toEl&&!toEl.value) toEl.value=today();
  renderExpensesReport();
}

function renderExpensesReport() {
  const projFilter=document.getElementById('exp-rpt-project')?.value||'';
  const from=document.getElementById('exp-rpt-from')?.value||'';
  const to=document.getElementById('exp-rpt-to')?.value||'';

  // Combine manual expenses + PO-derived material costs
  const allExpenses=[];
  DB.expenses.forEach(e=>{
    if((!projFilter||e.project===projFilter)&&(!from||e.date>=from)&&(!to||e.date<=to)) allExpenses.push({...e,source:'manual'});
  });
  // Also pull PO line items as material expenses
  DB.purchase_orders.filter(p=>p.status==='Received').forEach(p=>{
    p.items.forEach(i=>{
      const proj=i.project||p.project||'';
      if((!projFilter||proj===projFilter)&&(!from||p.date>=from)&&(!to||p.date<=to)) {
        allExpenses.push({id:p.id+'-'+i.desc,date:p.date,category:'Materials (PO)',payee:p.vendor,sino:p.no,project:proj,particulars:i.desc+' × '+i.qty+' '+i.unit,amount:(i.qty||0)*(i.unitPrice||0),paymentType:'PO',status:'PO Received',source:'po'});
      }
    });
  });

  const el=document.getElementById('expenses-report-content');
  if(!el) return;
  if(!allExpenses.length) { el.innerHTML='<div class="empty-state"><div class="empty-icon">📊</div>No expenses found for the selected filters.</div>'; return; }

  // Group by project
  const byProject={};
  allExpenses.forEach(e=>{
    const k=e.project||'Untagged';
    if(!byProject[k]) byProject[k]=[];
    byProject[k].push(e);
  });

  const grandTotal=allExpenses.reduce((s,e)=>s+(parseFloat(e.amount)||0),0);

  el.innerHTML=`
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:22px;">
      <div class="stat-card"><div class="stat-lbl">Total Expenses</div><div class="stat-val" style="font-size:20px;">${peso(grandTotal)}</div></div>
      <div class="stat-card bl"><div class="stat-lbl">Projects Covered</div><div class="stat-val">${Object.keys(byProject).length}</div></div>
      <div class="stat-card or"><div class="stat-lbl">Transactions</div><div class="stat-val">${allExpenses.length}</div></div>
    </div>
    ${Object.entries(byProject).map(([projName,expenses])=>{
      const projTotal=expenses.reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
      const proj=DB.projects.find(p=>p.name===projName);
      return `<div class="rpt-proj-block">
        <div class="rpt-proj-head">
          <div><div class="rpt-proj-title">${esc(projName)}</div>${proj?`<div style="font-size:11px;opacity:.7;">${esc(proj.client||'')} · Code: ${esc(proj.code||'')}</div>`:''}</div>
          <div class="rpt-proj-total">${peso(projTotal)}</div>
        </div>
        <div class="tbl-wrap" style="border:none;border-radius:0;box-shadow:none;">
          <table>
            <thead><tr><th>Date</th><th>Category</th><th>Payee</th><th>SI/OR #</th><th>Particulars</th><th style="text-align:right;">Amount</th><th>Source</th></tr></thead>
            <tbody>${expenses.map(e=>`<tr>
              <td style="font-size:11.5px;color:var(--faint);">${fmtDate(e.date)}</td>
              <td><span class="item-cat-badge">${esc(e.category)}</span></td>
              <td style="font-weight:500;">${esc(e.payee)}</td>
              <td style="font-size:11.5px;color:var(--soft);">${esc(e.sino||'–')}</td>
              <td style="font-size:12px;">${esc(e.particulars)}</td>
              <td style="text-align:right;font-weight:700;font-family:'Syne',sans-serif;">${peso(e.amount)}</td>
              <td style="font-size:10.5px;"><span class="badge ${e.source==='po'?'badge-partial':'badge-ok'}" style="font-size:9px;">${e.source==='po'?'PO':'Manual'}</span></td>
            </tr>`).join('')}
            <tr style="background:#fafafa;border-top:2px solid var(--bd);">
              <td colspan="5" style="text-align:right;font-weight:700;padding:10px 14px;">Project Subtotal</td>
              <td style="text-align:right;font-weight:800;font-family:'Syne',sans-serif;color:var(--mg);padding:10px 14px;">${peso(projTotal)}</td>
              <td></td>
            </tr>
            </tbody>
          </table>
        </div>
      </div>`;
    }).join('')}
    <div style="padding:14px 18px;background:var(--mg-lt);border:1.5px solid var(--mg);border-radius:var(--r);display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
      <span style="font-weight:700;">Grand Total — All Projects</span>
      <span style="font-family:'Syne',sans-serif;font-size:16px;font-weight:800;color:var(--mg);">${peso(grandTotal)}</span>
    </div>`;
}

function exportExpensesReport() {
  const projFilter=document.getElementById('exp-rpt-project')?.value||'';
  const rows=[['Date','Project','Category','Payee','SI/OR #','Particulars','Amount','Source']];
  const all=[...DB.expenses,...DB.purchase_orders.filter(p=>p.status==='Received').flatMap(p=>p.items.map(i=>({date:p.date,project:i.project||p.project||'',category:'Materials (PO)',payee:p.vendor,sino:p.no,particulars:i.desc+' x '+i.qty+' '+i.unit,amount:(i.qty||0)*(i.unitPrice||0),source:'po'})))];
  all.filter(e=>!projFilter||e.project===projFilter).forEach(e=>rows.push([e.date,e.project||'',e.category,e.payee,e.sino||'',e.particulars||'',e.amount||0,e.source||'manual']));
  const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='RSCI_ExpensesReport_'+today()+'.csv'; a.click();
  toast('Report exported.','ok');
}

// ── INVENTORY ─────────────────────────────────────────────────
function renderDashboard() {
  renderInvOrdersDashWidget();
  updateOrderNavBadges();
  const low=DB.inventory.filter(i=>(i.qty||0)<=(i.min||5));
  const ok=DB.inventory.filter(i=>(i.qty||0)>(i.min||5));
  const out=DB.inventory.filter(i=>(i.qty||0)===0);
  const expItems=DB.inventory.filter(i=>(i.expected||0)>0);
  const set=(id,v)=>{ const el=document.getElementById(id); if(el) el.textContent=v; };
  set('is-total',DB.inventory.length); set('is-ok',ok.length); set('is-low',low.filter(i=>i.qty>0).length);
  set('is-out',out.length); set('is-expected',expItems.reduce((s,i)=>s+(i.expected||0),0)); set('is-expected-items',expItems.length);
  const ac=document.getElementById('alert-cnt'); if(ac) ac.textContent=low.length;

  const q=(document.getElementById('alert-search')?.value||'').toLowerCase();
  const alertEl=document.getElementById('alert-list');
  if(alertEl) alertEl.innerHTML=!low.length?'<div class="empty-state" style="padding:20px;">All items in stock ✓</div>':
    low.filter(i=>!q||i.name.toLowerCase().includes(q)).map(i=>{const s=stockStatus(i);return `<div class="alert-row"><div class="alert-item-name">${esc(i.name.split(':').pop())}</div><div style="text-align:right;"><span class="badge badge-${s.cls}">${i.qty} / min ${i.min} ${i.unit}</span>${(i.expected||0)>0?`<br><span style="font-size:10px;color:var(--bl);">+${i.expected} expected</span>`:''}</div></div>`;}).join('');

  const rl=document.getElementById('recent-log');
  if(rl) rl.innerHTML=DB.inventory_log.slice(0,8).map(l=>{const qc=l.qtyChange||0;return `<div class="alert-row"><div style="flex:1;"><div style="font-weight:600;font-size:12px;">${esc((l.itemName||'').split(':').pop())}</div><div style="font-size:10.5px;color:var(--faint);">${fmtDT(l.dt)}</div></div><div style="color:${qc>=0?'var(--gn)':'var(--rd)'};font-weight:700;">${qc>=0?'+':''}${qc}</div></div>`;}).join('')||'<div style="padding:16px;font-size:12px;color:var(--faint);">No recent movements.</div>';

  const ud=document.getElementById('upcoming-deliveries');
  const expList=DB.inventory.filter(i=>(i.expected||0)>0);
  const uc=document.getElementById('upcoming-cnt'); if(uc) uc.textContent=expList.length;
  if(ud) ud.innerHTML=!expList.length?'No upcoming deliveries.':expList.map(i=>`<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--bd);font-size:12.5px;"><span>${esc(i.name.split(':').pop())}</span><span style="color:var(--bl);font-weight:700;">+${i.expected} ${esc(i.unit)}</span></div>`).join('');

  const rq=ensurePoReleaseQueue();
  const rqPending=rq.filter(r=>r.status!=='Prepared'&&r.status!=='Delivered');
  const rqAck=document.getElementById('po-release-cnt'); if(rqAck) rqAck.textContent=rqPending.length;
  const rqEl=document.getElementById('po-release-queue');
  if(rqEl) {
    if(!rqPending.length) {
      rqEl.innerHTML='<div style="padding:14px;font-size:12px;color:var(--faint);">No PO items waiting for release acknowledgment.</div>';
    } else {
      rqEl.innerHTML=rqPending.map(r=>`
        <div style="border:1px solid var(--bd);border-radius:var(--r);padding:12px 14px;margin-bottom:10px;background:#fff;">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap;">
            <div style="min-width:0;flex:1;">
              <div style="font-family:'Syne',sans-serif;font-size:12px;font-weight:800;color:var(--mg);">${esc(r.itemLabel||r.itemName||'Item')}</div>
              <div style="font-size:11px;color:var(--soft);margin-top:3px;">PO ${esc(r.poNo||'–')} · ${esc(r.vendor||'–')} · ${esc(r.project||'–')}</div>
              <div style="font-size:11px;color:var(--soft);margin-top:3px;">
                ${r.kind==='release'?`Qty to release: ${esc(String(r.qty||0))} ${esc(r.unit||'PCS')}`:`Qty to buy: ${esc(String(r.qty||0))} ${esc(r.unit||'PCS')}`}
                · WH Order: ${esc(r.whOrderNo||'–')}
              </div>
              <div style="font-size:11px;color:var(--soft);margin-top:3px;">Status: <span class="badge badge-${r.status==='Expected Delivery'?'ok':r.status==='For Purchase'?'pending':'partial'}" style="font-size:9px;">${esc(r.status||'For Purchase')}</span>${r.acknowledgedAt?` <span style="margin-left:8px;color:var(--gn);font-weight:700;">Acknowledged by ${esc(r.acknowledgedBy||'–')}</span>`:''}</div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
              ${!r.acknowledgedAt?`<button class="btn btn-ol btn-sm" onclick="acknowledgePoRelease('${r.queueId}')">Acknowledge</button>`:''}
              ${r.status==='Expected Delivery'?`<button class="btn btn-mg btn-sm" onclick="preparePoRelease('${r.queueId}')">Prepare Release</button>`:''}
            </div>
          </div>
        </div>`).join('');
    }
  }
}

function renderInventoryTable() {
  const q=(document.getElementById('inv-search')?.value||'').toLowerCase();
  const f=document.getElementById('inv-filter')?.value||'all';
  const filtered=DB.inventory.filter(i=>{
    const mq=!q||i.name.toLowerCase().includes(q);
    const s=stockStatus(i);
    const mf=f==='all'||s.cls===f;
    return mq&&mf;
  });
  const tbody=document.getElementById('inv-tbody');
  if(!tbody) return;
  tbody.innerHTML=filtered.map((i,idx)=>{
    const s=stockStatus(i);
    return `<tr>
      <td style="font-size:11.5px;color:var(--faint);">${idx+1}</td>
      <td><div style="font-weight:600;font-size:12.5px;">${esc(i.name.split(':').pop())}</div><div class="item-source">${esc(categoryOf(i.name))}</div></td>
      <td style="font-size:12px;color:var(--soft);">${esc(i.unit)}</td>
      <td style="text-align:right;font-weight:600;">${peso(i.price||0)}</td>
      <td style="text-align:right;font-weight:700;">${i.qty}${getReservedQty(i)>0?`<div style="font-size:10px;color:var(--or);font-weight:500;">${getReservedQty(i)} res</div>`:''}</td>
      <td style="text-align:right;color:${(i.expected||0)>0?'var(--bl)':'var(--faint)'};">${(i.expected||0)>0?`+${i.expected}`:'–'}</td>
      <td style="text-align:right;font-weight:700;color:var(--gn);">${getAvailableQty(i)+(i.expected||0)}</td>
      <td style="text-align:right;color:var(--faint);">${i.min||5}</td>
      <td><span class="badge badge-${s.cls}">${s.label}</span></td>
      <td style="font-size:11.5px;color:var(--faint);">${esc(i.brand||'–')}</td>
      <td><button class="btn btn-ol btn-sm" onclick="openEditItem('${i.id}')">Edit</button></td>
    </tr>`;
  }).join('');
  const cnt=document.getElementById('inv-count'); if(cnt) cnt.textContent=`${filtered.length} of ${DB.inventory.length} items`;
}

function si_updateInfo() {
  const name=document.getElementById('si-item')?.value;
  const item=findInventoryItem(name);
  const box=document.getElementById('si-current-info');
  if(item&&box) { box.style.display='block'; box.innerHTML=`<strong>${esc(item.name.split(':').pop())}</strong> · On hand: <strong>${item.qty} ${item.unit}</strong> · Reserved: ${getReservedQty(item)} · Available: <strong>${getAvailableQty(item)}</strong> · Min: ${item.min||5}`; }
  else if(box) box.style.display='none';
}
function so_updateInfo() {
  const name=document.getElementById('so-item')?.value;
  const item=findInventoryItem(name);
  const box=document.getElementById('so-current-info');
  if(item&&box) { const av=getAvailableQty(item); box.style.display='block'; box.innerHTML=`<strong>${esc(item.name.split(':').pop())}</strong> · Available: <strong style="color:${av>0?'var(--gn)':'var(--rd)'};">${av} ${item.unit}</strong> (${getReservedQty(item)} reserved)`; }
  else if(box) box.style.display='none';
}

function doStockIn() {
  const name=(document.getElementById('si-item')?.value||'').trim();
  const qty=parseInt(document.getElementById('si-qty')?.value)||0;
  const supplier=(document.getElementById('si-supplier')?.value||'').trim();
  const date=document.getElementById('si-date')?.value||today();
  const remarks=document.getElementById('si-remarks')?.value||'';
  if(!name||qty<=0) { toast('Error: Item and quantity are required.'); return; }
  const item=findInventoryItem(name);
  if(!item) { toast('Error: Item not found in inventory.'); return; }
  item.qty=(item.qty||0)+qty;
  if(supplier) { item.lastSupplier=supplier; item.lastBoughtAt=date; }
  DB.inventory_log.unshift({id:uid(),dt:new Date(date+'T'+new Date().toTimeString().slice(0,8)).toISOString(),type:'in',itemName:item.name,qtyChange:qty,balanceAfter:item.qty,remarks:remarks||(supplier?`From: ${supplier}`:undefined)||''});
  saveDB(); updateInvPill(); si_updateInfo();
  toast(`Stocked in ${qty} ${item.unit} of ${item.name.split(':').pop()}.`,'ok');
  clearStockIn();
}

function clearStockIn() {
  ['si-item','si-supplier','si-remarks'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('si-qty').value='';
  document.getElementById('si-date').value=today();
  document.getElementById('si-current-info').style.display='none';
}

function doStockOut() {
  const name=(document.getElementById('so-item')?.value||'').trim();
  const qty=parseInt(document.getElementById('so-qty')?.value)||0;
  const reason=document.getElementById('so-reason')?.value||'';
  const date=document.getElementById('so-date')?.value||today();
  const project=document.getElementById('so-project-info')?.value||'';
  const remarks=document.getElementById('so-remarks')?.value||'';
  if(!name||qty<=0) { toast('Error: Item and quantity are required.'); return; }
  if(!reason) { toast('Error: Please select a reason.'); return; }
  const item=findInventoryItem(name);
  if(!item) { toast('Error: Item not found.'); return; }
  const avail=getAvailableQty(item);
  if(avail<qty) { toast(`Error: Insufficient available stock. Available: ${avail} ${item.unit} (${getReservedQty(item)} reserved).`); return; }
  item.qty-=qty;
  DB.inventory_log.unshift({id:uid(),dt:new Date(date+'T'+new Date().toTimeString().slice(0,8)).toISOString(),type:'out',itemName:item.name,project,qtyChange:-qty,balanceAfter:item.qty,remarks:`${reason}${project?'. Project: '+project:''}${remarks?'. '+remarks:''}`});
  saveDB(); updateInvPill(); renderDashboard(); so_updateInfo();
  toast(`Deducted ${qty} ${item.unit} of ${item.name.split(':').pop()}.`,'ok');
}

function renderLog() {
  const q=(document.getElementById('log-search')?.value||'').toLowerCase();
  const f=document.getElementById('log-filter')?.value||'all';
  const project=document.getElementById('log-project-filter')?.value||'';
  const filtered=DB.inventory_log.filter(l=>{
    const mq=!q||(l.itemName||'').toLowerCase().includes(q)||(l.remarks||'').toLowerCase().includes(q);
    const mf=f==='all'||l.type===f;
    const mp=!project||(l.project||'')===project||(l.remarks||'').toLowerCase().includes(project.toLowerCase());
    return mq&&mf&&mp;
  });
  const typeLabels={in:'Stock In',out:'Stock Out',ticket:'Ticket',reserve:'Reservation',release:'Site Release',adjust:'Adjustment',po:'PO Created',approve:'PO Approved',receive:'Received',action:'Action'};
  const typeColors={in:'var(--gn)',out:'var(--rd)',ticket:'var(--bl)',reserve:'var(--or)',release:'var(--mg)',adjust:'var(--or)',po:'var(--soft)',approve:'var(--mg)',receive:'var(--gn)',action:'var(--faint)'};
  const tbody=document.getElementById('log-tbody'); if(!tbody) return;
  tbody.innerHTML=!filtered.length?'<tr><td colspan="7" class="empty-state">No log entries found.</td></tr>':
    filtered.map(l=>{const qc=l.qtyChange||0;return `<tr>
      <td style="font-size:11.5px;color:var(--faint);white-space:nowrap;">${fmtDT(l.dt)}</td>
      <td><span style="font-size:10.5px;font-weight:700;color:${typeColors[l.type]||'var(--soft)'};">${typeLabels[l.type]||l.type}</span></td>
      <td style="font-weight:500;font-size:12px;">${esc((l.itemName||'').split(':').pop())}</td>
      <td style="font-size:11.5px;color:var(--soft);">${esc(l.project||'–')}</td>
      <td style="text-align:right;font-weight:700;color:${qc>=0?'var(--gn)':'var(--rd)'};">${qc>=0?'+':''}${qc}</td>
      <td style="text-align:right;">${l.balanceAfter??'–'}</td>
      <td style="font-size:11.5px;color:var(--faint);">${esc(l.remarks||'–')}</td>
    </tr>`}).join('');
  const cnt=document.getElementById('log-count'); if(cnt) cnt.textContent=`${filtered.length} entries`;
}

function exportLogToExcel() {
  const rows=[['Date/Time','Type','Item Description','Project','Qty Change','Balance After','Remarks']];
  DB.inventory_log.forEach(l=>rows.push([fmtDT(l.dt),l.type,l.itemName||'',l.project||'',l.qtyChange||0,l.balanceAfter||'',l.remarks||'']));
  const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='RSCI_Log_'+today()+'.csv'; a.click();
  toast('Log exported.','ok');
}

function clearLog() {
  if(!confirm('Clear ALL movement log entries?')) return;
  DB.inventory_log=[]; saveDB(); renderLog(); toast('Log cleared.','ok');
}

// ── RELEASE MONITORING ────────────────────────────────────────
let _relDetailId=null, _relAddItemRows=[];

function monitorStatusLabel(st) {
  return {ongoing:'Ongoing',partial:'Partial Release',completed:'Released All'}[st]||st;
}

function renderReleaseMonitor() {
  const q=(document.getElementById('rel-search')?.value||'').toLowerCase();
  const f=document.getElementById('rel-filter')?.value||'all';
  const list=document.getElementById('rel-monitor-list');
  if(!list) return;
  const monitors=(DB.release_monitors||[]).filter(m=>{
    const mq=!q||(m.projectName||'').toLowerCase().includes(q)||(m.orderRef||'').toLowerCase().includes(q)||(m.pm||'').toLowerCase().includes(q);
    const mf=f==='all'||m.status===f;
    return mq&&mf;
  });
  list.innerHTML=!monitors.length?'<div class="empty-state">No projects being monitored.</div>':`
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="background:#fafafa;border-bottom:2px solid var(--bd);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--faint);padding:10px 14px;">Project</th>
        <th style="background:#fafafa;border-bottom:2px solid var(--bd);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--faint);padding:10px 14px;">Order Ref</th>
        <th style="background:#fafafa;border-bottom:2px solid var(--bd);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--faint);padding:10px 14px;">PM</th>
        <th style="background:#fafafa;border-bottom:2px solid var(--bd);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--faint);padding:10px 14px;text-align:center;">Items</th>
        <th style="background:#fafafa;border-bottom:2px solid var(--bd);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--faint);padding:10px 14px;">Status</th>
      </tr></thead>
      <tbody>${monitors.map(m=>{
        const items=getReleaseItemsForMonitor(m.id);
        return `<tr class="rel-row" onclick="showReleaseDetail('${m.id}')">
          <td style="padding:12px 14px;font-weight:600;">${esc(m.projectName)}</td>
          <td style="padding:12px 14px;font-size:12px;color:var(--soft);">${esc(m.orderRef||'–')}</td>
          <td style="padding:12px 14px;font-size:12px;">${esc(m.pm||'–')}</td>
          <td style="padding:12px 14px;text-align:center;">${items.length}</td>
          <td style="padding:12px 14px;"><span class="badge badge-${m.status}">${monitorStatusLabel(m.status)}</span></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  if(_relDetailId) showReleaseDetail(_relDetailId);
}

function showReleaseDetail(monitorId) {
  _relDetailId=monitorId;
  const m=DB.release_monitors?.find(x=>x.id===monitorId);
  const el=document.getElementById('rel-monitor-detail');
  if(!m||!el) return;
  el.style.display='block';
  const items=getReleaseItemsForMonitor(monitorId);
  el.innerHTML=`<div style="padding:18px 20px;background:var(--paper);">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap;">
      <div style="font-family:'Syne',sans-serif;font-size:16px;font-weight:800;color:var(--mg);">${esc(m.projectName)}</div>
      <span class="badge badge-${m.status}">${monitorStatusLabel(m.status)}</span>
      <button class="btn btn-ol btn-sm" style="margin-left:auto;" onclick="event.stopPropagation();_relDetailId=null;document.getElementById('rel-monitor-detail').style.display='none';">Close</button>
    </div>
    <div style="font-size:12px;color:var(--soft);margin-bottom:14px;line-height:1.6;">
      ${m.orderRef?`Order: <strong>${esc(m.orderRef)}</strong> · `:''}PM: ${esc(m.pm||'–')} · Site: ${esc(m.siteLocation||'–')}
      ${m.remarks?`<br>${esc(m.remarks)}`:''}
    </div>
    <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:var(--r);overflow:hidden;">
      <thead><tr>
        <th style="background:#fafafa;border-bottom:2px solid var(--bd);font-size:10px;font-weight:700;text-transform:uppercase;padding:10px 14px;">Item</th>
        <th style="background:#fafafa;border-bottom:2px solid var(--bd);font-size:10px;font-weight:700;text-transform:uppercase;padding:10px 14px;text-align:center;">Reserved</th>
        <th style="background:#fafafa;border-bottom:2px solid var(--bd);font-size:10px;font-weight:700;text-transform:uppercase;padding:10px 14px;text-align:center;">Released</th>
        <th style="background:#fafafa;border-bottom:2px solid var(--bd);font-size:10px;font-weight:700;text-transform:uppercase;padding:10px 14px;">Status</th>
        <th style="background:#fafafa;border-bottom:2px solid var(--bd);padding:10px 14px;"></th>
      </tr></thead>
      <tbody>${items.map(i=>`<tr>
        <td style="padding:10px 14px;font-weight:600;font-size:12.5px;">${esc(i.itemName.split(':').pop())}</td>
        <td style="padding:10px 14px;text-align:center;">${i.reservedQty} ${esc(i.unit)}</td>
        <td style="padding:10px 14px;text-align:center;font-weight:700;color:var(--gn);">${i.releasedQty||0}</td>
        <td style="padding:10px 14px;">
          <select class="fc" style="padding:6px 8px;font-size:12px;min-width:140px;" onchange="updateReleaseItemStatus('${i.id}',this.value)">
            <option value="Reserved" ${i.status==='Reserved'?'selected':''}>Reserved</option>
            <option value="Partially Released" ${i.status==='Partially Released'?'selected':''}>Partially Released</option>
            <option value="Released All" ${i.status==='Released All'?'selected':''}>Released All</option>
          </select>
        </td>
        <td style="padding:10px 14px;"><button class="btn btn-ol btn-sm" onclick="event.stopPropagation();removeReleaseItem('${i.id}')">Remove</button></td>
      </tr>`).join('')}</tbody>
    </table>
    <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-ol btn-sm" onclick="relAddItemToMonitor('${m.id}')">+ Add Item</button>
      ${m.status==='completed'?`<button class="btn btn-gn btn-sm" onclick="finalizeMonitorRelease('${m.id}')">✓ Finalize to Movement Log</button>`:''}
    </div>
  </div>`;
}

function updateReleaseItemStatus(itemId, newStatus) {
  const item=DB.release_items?.find(i=>i.id===itemId);
  if(!item) return;
  const prevReleased=item.releasedQty||0;
  if(newStatus==='Reserved') item.releasedQty=0;
  else if(newStatus==='Released All') item.releasedQty=item.reservedQty||0;
  else if(newStatus==='Partially Released'&&prevReleased<=0) item.releasedQty=Math.max(1,Math.floor((item.reservedQty||0)/2));
  item.status=newStatus;
  const mon=DB.release_monitors?.find(m=>m.id===item.monitorId);
  if(mon) mon.status=computeMonitorStatus(mon.id);
  saveDB(); renderReleaseMonitor();
  toast('Item status updated.','ok');
}

function removeReleaseItem(itemId) {
  const item=DB.release_items?.find(i=>i.id===itemId);
  if(!item||!confirm('Remove this item? Unreleased quantity returns to available stock.')) return;
  const mon=DB.release_monitors?.find(m=>m.id===item.monitorId);
  restoreReleaseItemReservation(item,mon?.projectName||'');
  DB.release_items=DB.release_items.filter(i=>i.id!==itemId);
  if(mon) mon.status=computeMonitorStatus(mon.id);
  saveDB(); updateInvPill(); renderReleaseMonitor(); renderInventoryTable();
  toast('Item removed — stock restored.','ok');
}

function finalizeMonitorRelease(monitorId) {
  const m=DB.release_monitors?.find(x=>x.id===monitorId);
  if(!m) return;
  getReleaseItemsForMonitor(monitorId).forEach(i=>{
    if(i.releasedQty>0) {
      DB.inventory_log.unshift({id:uid(),dt:nowISO(),type:'release',itemName:i.itemName,project:m.projectName,qtyChange:-(i.releasedQty||0),balanceAfter:findInventoryItem(i.itemName)?.qty??0,remarks:`${m.orderRef||m.projectName} finalized · ${i.releasedQty} ${i.unit} released to site`});
    }
  });
  saveDB(); renderLog(); toast('Release transaction saved to Movement Log.','ok');
}

let _relAddToMonitorId=null;
function relAddItemToMonitor(monitorId) {
  _relAddToMonitorId=monitorId;
  openAddReleaseMonitor(true);
  const sel=document.getElementById('rel-add-project');
  const m=DB.release_monitors?.find(x=>x.id===monitorId);
  if(sel&&m) sel.value=m.projectId;
  relAddProjectChanged();
  ['rel-add-pm','rel-add-site','rel-add-order','rel-add-remarks'].forEach((id,idx)=>{
    const el=document.getElementById(id);
    if(!el||!m) return;
    if(id==='rel-add-pm') el.value=m.pm||'';
    if(id==='rel-add-site') el.value=m.siteLocation||'';
    if(id==='rel-add-order') el.value=m.orderRef||'';
    if(id==='rel-add-remarks') el.value=m.remarks||'';
  });
}

function openAddReleaseMonitor(keepMonitorId) {
  if(!keepMonitorId) _relAddToMonitorId=null;
  _relAddItemRows=[];
  const sel=document.getElementById('rel-add-project');
  if(sel) sel.innerHTML=DB.projects.filter(p=>p.status==='Active').map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
  relAddProjectChanged();
  document.getElementById('rel-add-items').innerHTML='';
  relAddItemRow();
  openMo('mo-add-release');
}

function relAddProjectChanged() {
  const pid=document.getElementById('rel-add-project')?.value;
  const p=DB.projects.find(x=>x.id===pid);
  const pm=document.getElementById('rel-add-pm');
  if(pm&&p&&!pm.value) pm.placeholder=p.client||'';
}

function relAddItemRow() {
  const id=uid(); _relAddItemRows.push(id);
  const wrap=document.getElementById('rel-add-items');
  const div=document.createElement('div');
  div.className='mat-row'; div.id='rel-item-'+id;
  div.innerHTML=`
    <datalist id="reldl-${id}">${DB.inventory.map(i=>`<option value="${esc(i.name)}">`).join('')}</datalist>
    <div style="flex:3;min-width:160px;"><div class="form-lbl">Item</div><input class="fc" list="reldl-${id}" id="reln-${id}" placeholder="Search inventory…"></div>
    <div style="flex:1;min-width:70px;"><div class="form-lbl">Qty</div><input class="fc" id="relq-${id}" type="number" min="1" placeholder="0"></div>
    <div style="flex:1;min-width:60px;"><div class="form-lbl">Unit</div><input class="fc" id="relu-${id}" placeholder="PCS"></div>
    <div style="padding-bottom:14px;"><button class="btn btn-ol btn-sm" onclick="document.getElementById('rel-item-${id}')?.remove();_relAddItemRows=_relAddItemRows.filter(x=>x!=='${id}')">✕</button></div>`;
  wrap.appendChild(div);
}

function saveReleaseMonitor() {
  const projectId=document.getElementById('rel-add-project')?.value;
  const pm=document.getElementById('rel-add-pm')?.value.trim();
  const site=document.getElementById('rel-add-site')?.value.trim();
  const orderRef=document.getElementById('rel-add-order')?.value.trim();
  const remarks=document.getElementById('rel-add-remarks')?.value.trim();
  const proj=DB.projects.find(p=>p.id===projectId);
  if(!proj) { toast('Error: Select a project.'); return; }
  let mon=_relAddToMonitorId?DB.release_monitors?.find(m=>m.id===_relAddToMonitorId):null;
  if(!mon) {
    mon={id:uid(),projectId,projectName:proj.name,ticketId:null,orderRef:orderRef||null,pm,siteLocation:site,remarks,status:'ongoing',createdAt:nowISO(),createdBy:_currentUser?.name||'Inventory'};
    DB.release_monitors.unshift(mon);
  }
  let added=0;
  for(const id of _relAddItemRows) {
    const name=document.getElementById('reln-'+id)?.value.trim();
    const qty=parseInt(document.getElementById('relq-'+id)?.value)||0;
    let unit=document.getElementById('relu-'+id)?.value.trim();
    if(!name||qty<=0) continue;
    const inv=findInventoryItem(name);
    if(!inv) { toast(`Error: ${name} not in inventory.`); return; }
    if(!unit) unit=inv.unit;
    const avail=getAvailableQty(inv);
    const reserveQty=Math.min(qty,avail);
    if(reserveQty<=0) { toast(`Error: No available stock for ${name.split(':').pop()}.`); continue; }
    inv.reserved=(inv.reserved||0)+reserveQty;
    DB.inventory_log.unshift({id:uid(),dt:nowISO(),type:'reserve',itemName:inv.name,project:proj.name,qtyChange:-reserveQty,balanceAfter:getAvailableQty(inv),remarks:`Manual reserve · ${proj.name} (${reserveQty} ${unit})`});
    DB.release_items.push({id:uid(),monitorId:mon.id,ticketId:null,itemName:inv.name,inventoryId:inv.id,reservedQty:reserveQty,releasedQty:0,unit,status:'Reserved',createdAt:nowISO()});
    added++;
  }
  if(!added&&!_relAddToMonitorId) { toast('Error: Add at least one item with available stock.'); return; }
  mon.status=computeMonitorStatus(mon.id);
  _relAddToMonitorId=null;
  saveDB(); updateInvPill(); closeMo('mo-add-release'); renderReleaseMonitor();
  toast(added?`Project saved — ${added} item(s) reserved.`:'Project updated.','ok');
}

// ── PULL-OUT MONITORING ───────────────────────────────────────
function getReleasedItemsForPullout() {
  return (DB.release_items||[]).filter(i=>(i.releasedQty||0)>0);
}

function renderPulloutMonitor() {
  const q=(document.getElementById('pull-search')?.value||'').toLowerCase();
  const f=document.getElementById('pull-filter')?.value||'all';
  const records=(DB.pullout_records||[]).filter(r=>{
    const mq=!q||(r.itemName||'').toLowerCase().includes(q)||(r.projectName||'').toLowerCase().includes(q)||(r.pulledBy||'').toLowerCase().includes(q);
    const mf=f==='all'||(f==='out'&&!r.returned)||(f==='returned'&&r.returned);
    return mq&&mf;
  });
  const tbody=document.getElementById('pullout-tbody');
  if(!tbody) return;
  tbody.innerHTML=!records.length?'<tr><td colspan="7" class="empty-state">No pull-out records.</td></tr>':
    records.map(r=>`<tr>
      <td style="font-size:11.5px;color:var(--faint);white-space:nowrap;">${fmtDate(r.pulloutDate?.split('T')[0])}</td>
      <td style="font-weight:500;font-size:12px;">${esc(r.projectName)}</td>
      <td style="font-size:12px;">${esc((r.itemName||'').split(':').pop())}</td>
      <td style="text-align:right;font-weight:700;">${r.qty}</td>
      <td style="font-size:12px;">${esc(r.pulledBy)}</td>
      <td><span class="badge badge-${r.returned?'completed':'urgent'}">${r.returned?'Returned':'Unreturned'}</span></td>
      <td>${!r.returned?`<button class="btn btn-gn btn-sm" onclick="markPulloutReturned('${r.id}')">Mark Returned</button>`:`<span style="font-size:11px;color:var(--faint);">${fmtDate(r.returnDate?.split('T')[0])}</span>`}</td>
    </tr>`).join('');
  const cnt=document.getElementById('pullout-count');
  const unreturned=records.filter(r=>!r.returned).length;
  if(cnt) cnt.textContent=`${records.length} record(s) · ${unreturned} still out`;
}

function openPulloutModal() {
  const sel=document.getElementById('pull-ref-item');
  const released=getReleasedItemsForPullout();
  if(sel) sel.innerHTML=released.length?released.map(i=>{
    const mon=DB.release_monitors?.find(m=>m.id===i.monitorId);
    const pulled=(DB.pullout_records||[]).filter(p=>p.releaseItemId===i.id&&!p.returned).reduce((s,p)=>s+(p.qty||0),0);
    const avail=(i.releasedQty||0)-pulled;
    if(avail<=0) return '';
    return `<option value="${i.id}">${esc((i.itemName||'').split(':').pop())} · ${mon?.projectName||'–'} · ${avail} avail</option>`;
  }).join(''):'<option value="">No released items available</option>';
  document.getElementById('pull-date').value=today();
  document.getElementById('pull-by').value=_currentUser?.name||'';
  document.getElementById('pull-qty').value='1';
  document.getElementById('pull-remarks').value='';
  openMo('mo-pullout');
}

function savePullout() {
  const itemId=document.getElementById('pull-ref-item')?.value;
  const qty=parseInt(document.getElementById('pull-qty')?.value)||0;
  const date=document.getElementById('pull-date')?.value||today();
  const pulledBy=document.getElementById('pull-by')?.value.trim();
  const remarks=document.getElementById('pull-remarks')?.value.trim();
  const ri=DB.release_items?.find(i=>i.id===itemId);
  if(!ri||qty<=0||!pulledBy) { toast('Error: Select item, quantity, and person.'); return; }
  const mon=DB.release_monitors?.find(m=>m.id===ri.monitorId);
  const pulled=(DB.pullout_records||[]).filter(p=>p.releaseItemId===ri.id&&!p.returned).reduce((s,p)=>s+(p.qty||0),0);
  const avail=(ri.releasedQty||0)-pulled;
  if(qty>avail) { toast(`Error: Only ${avail} available for pull-out.`); return; }
  DB.pullout_records=DB.pullout_records||[];
  DB.pullout_records.unshift({id:uid(),releaseItemId:ri.id,monitorId:ri.monitorId,itemName:ri.itemName,projectName:mon?.projectName||'',qty,pulloutDate:date+'T12:00:00',pulledBy,returned:false,returnDate:null,remarks});
  DB.inventory_log.unshift({id:uid(),dt:nowISO(),type:'out',itemName:ri.itemName,project:mon?.projectName||'',qtyChange:-qty,balanceAfter:findInventoryItem(ri.itemName)?.qty??0,remarks:`Pull-out · ${pulledBy}${remarks?'. '+remarks:''}`});
  saveDB(); closeMo('mo-pullout'); renderPulloutMonitor(); renderLog();
  toast('Pull-out recorded.','ok');
}

function markPulloutReturned(recordId) {
  const r=DB.pullout_records?.find(x=>x.id===recordId);
  if(!r) return;
  r.returned=true;
  r.returnDate=today()+'T12:00:00';
  DB.inventory_log.unshift({id:uid(),dt:nowISO(),type:'in',itemName:r.itemName,project:r.projectName,qtyChange:r.qty,balanceAfter:findInventoryItem(r.itemName)?.qty??0,remarks:`Returned · ${r.pulledBy}${r.remarks?'. '+r.remarks:''}`});
  saveDB(); renderPulloutMonitor(); renderLog();
  toast('Marked as returned.','ok');
}

function exportCSV() {
  let csv='Item,Category,Unit,Unit Price,Qty,Min Stock,Status,Brand\n';
  DB.inventory.forEach(i=>{ const s=stockStatus(i); csv+=`"${i.name}","${categoryOf(i.name)}","${i.unit}",${i.price||0},${i.qty||0},${i.min||5},"${s.label}","${i.brand||''}"\n`; });
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='RSCI_Inventory_'+today()+'.csv'; a.click();
  toast('CSV exported.','ok');
}

let editItemId=null;
function openEditItem(id) {
  const item=DB.inventory.find(i=>i.id===id); if(!item) return;
  editItemId=id;
  document.getElementById('edit-name').value=item.name;
  document.getElementById('edit-price').value=item.price||0;
  document.getElementById('edit-unit').value=item.unit;
  document.getElementById('edit-min').value=item.min||5;
  document.getElementById('edit-brand').value=item.brand||'';
  openMo('mo-edit-item');
}

function saveEdit() {
  const item=DB.inventory.find(i=>i.id===editItemId); if(!item) return;
  item.price=parseFloat(document.getElementById('edit-price').value)||0;
  item.unit=document.getElementById('edit-unit').value.trim()||item.unit;
  item.min=parseInt(document.getElementById('edit-min').value)||5;
  item.brand=document.getElementById('edit-brand').value.trim();
  saveDB(); buildDatalist(); renderInventoryTable(); updateInvPill(); renderDashboard();
  closeMo('mo-edit-item'); toast('Item updated.','ok');
}

function deleteItem() {
  if(!confirm('Delete this item?')) return;
  DB.inventory=DB.inventory.filter(i=>i.id!==editItemId);
  saveDB(); buildDatalist(); renderInventoryTable(); renderDashboard();
  closeMo('mo-edit-item'); toast('Item deleted.','ok');
}

function openAddItem() {
  ['add-name','add-unit','add-brand'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('add-price').value='0';
  document.getElementById('add-qty').value='0';
  document.getElementById('add-min').value='5';
  openMo('mo-add-item');
}

function saveNewItem() {
  const name=document.getElementById('add-name').value.trim();
  const price=parseFloat(document.getElementById('add-price').value)||0;
  const unit=document.getElementById('add-unit').value.trim();
  const qty=parseInt(document.getElementById('add-qty').value)||0;
  const min=parseInt(document.getElementById('add-min').value)||5;
  const brand=document.getElementById('add-brand').value.trim();
  if(!name||!unit) { toast('Error: Item name and unit are required.'); return; }
  const item={id:uid(),name,price,qty,reserved:0,unit,min,brand,expected:0};
  DB.inventory.push(item); saveDB(); buildDatalist(); renderInventoryTable(); renderDashboard(); updateInvPill();
  closeMo('mo-add-item'); toast('Item added.','ok');
}

// ── BILLING ───────────────────────────────────────────────────
let activeBillingId=null, editingInvoiceId=null;

function buildBillingGateDashboardHTML() {
  const blocked=DB.tickets.filter(t=>{
    if(!['Pending Inventory','At PO','Pending Override','Partial'].includes(t.status)) return false;
    return !ticketHasPaidBilling(t.projectId)&&!(t.bossApproved&&t.financeApproved);
  }).slice(0,8);
  if(!blocked.length) {
    return `<div class="dash-widget" style="margin-bottom:18px;">
      <div class="dash-widget-head"><div class="dash-widget-title" style="color:var(--gn);">💰 Billing / PO Gate</div><span class="badge badge-ok">Clear</span></div>
      <div class="dash-widget-body"><div class="empty-state" style="padding:20px;"><div class="empty-icon">✓</div>All active tickets have payment or override in place.</div></div>
    </div>`;
  }
  return `<div class="dash-widget" style="margin-bottom:18px;">
    <div class="dash-widget-head"><div class="dash-widget-title" style="color:var(--or);">💰 Billing Gate — Blocked Tickets</div><span class="badge badge-pending-override">${blocked.length}</span></div>
    <div class="dash-widget-body no-pad">
      ${blocked.map(t=>{
        const gate=getBillingGateStatus(t.projectId);
        return `<div class="alert-row" style="flex-wrap:wrap;gap:8px;">
          <div style="flex:1;min-width:160px;">
            <div style="font-weight:700;font-size:12px;">${esc(t.no)} · ${esc(t.project)}</div>
            <div style="font-size:11px;color:var(--faint);">${gate.reason==='no_record'?'No billing record':gate.reason==='no_paid_invoice'?'No paid invoice':'Awaiting override'}</div>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            ${gate.record?`<button type="button" class="btn btn-gn btn-sm" onclick="blOpenDetail('${gate.record.id}')">Billing</button>`:`<button type="button" class="btn btn-ol btn-sm" onclick="blOpenAddRecordModal('${t.projectId||''}')">+ Billing</button>`}
            <button type="button" class="btn btn-ol btn-sm" onclick="viewTicketDetail('${t.id}')">Ticket</button>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function blOpenAddRecordModal(prefillProjectId) {
  ['bl-add-company','bl-add-project','bl-add-contract','bl-add-tin'].forEach(id=>{
    const el=document.getElementById(id); if(el) el.value='';
  });
  const tax=document.getElementById('bl-add-tax'); if(tax) tax.value='VAT';
  const ewt=document.getElementById('bl-add-ewt'); if(ewt) ewt.value='2';
  const sel=document.getElementById('bl-add-project-id');
  if(sel) {
    const linkProjects=DB.projects.filter(p=>p.status==='Active');
    if(prefillProjectId&&!linkProjects.some(p=>p.id===prefillProjectId)) {
      const extra=DB.projects.find(p=>p.id===prefillProjectId);
      if(extra) linkProjects.unshift(extra);
    }
    sel.innerHTML='<option value="">None — billing only (manual entry)</option>'+
      linkProjects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    sel.value=prefillProjectId||'';
    if(prefillProjectId) blOnBillingProjectPick();
    else {
      const projEl=document.getElementById('bl-add-project');
      if(projEl) projEl.focus();
    }
  }
  openMo('mo-add-billing');
}

function blOnBillingProjectNameInput() {
  const name=(document.getElementById('bl-add-project')?.value||'').trim();
  const sel=document.getElementById('bl-add-project-id');
  if(!sel||!name) return;
  const match=DB.projects.find(p=>p.name.toLowerCase()===name.toLowerCase());
  if(match) sel.value=match.id;
  else if(sel.value) {
    const linked=DB.projects.find(p=>p.id===sel.value);
    if(linked&&linked.name.toLowerCase()!==name.toLowerCase()) sel.value='';
  }
}

function blOnBillingProjectPick() {
  const id=document.getElementById('bl-add-project-id')?.value||'';
  const p=DB.projects.find(x=>x.id===id);
  const companyEl=document.getElementById('bl-add-company');
  const projectEl=document.getElementById('bl-add-project');
  const contractEl=document.getElementById('bl-add-contract');
  if(!p) return;
  if(companyEl) companyEl.value=p.client||'';
  if(projectEl) projectEl.value=p.name;
  if(contractEl) contractEl.value=p.contractAmount||'';
}

function blExportExcel() {
  const rows=[['Company','Project','Project ID','Contract','Collected Net','Outstanding','PO Gate','TIN','Tax','Status']];
  DB.billing_records.forEach(r=>{
    const gate=r.projectId?getBillingGateStatus(r.projectId):{passed:false};
    rows.push([
      r.company,r.project,r.projectId||'',r.contractAmount,getBillingCollectedNet(r.id),getBillingOutstanding(r.id),
      gate.passed?'Open':'Blocked',r.tin||'',r.taxType||'',r.status||'',
    ]);
  });
  rows.push([]);
  rows.push(['Invoice #','Company','Project','Invoice Date','Description','Amount','Status','Paid Date']);
  DB.billing_invoices.forEach(inv=>{
    const rec=DB.billing_records.find(x=>x.id===inv.recordId);
    rows.push([inv.invoiceNo,rec?.company||'',rec?.project||'',inv.invoiceDate,inv.desc,inv.baseAmount,inv.status,inv.paidDate||'']);
  });
  const csv=rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='rsci-billing-'+today()+'.csv';
  a.click();
  toast('Billing export downloaded.','ok');
}

function calcInvoiceAmounts(baseAmount,ewtRate,dedAmt,taxType) {
  const gross=parseFloat(baseAmount)||0;
  const netVat=taxType==='VAT'?+(gross/1.12).toFixed(2):gross;
  const ewt=+(netVat*((ewtRate||0)/100)).toFixed(2);
  const ded=parseFloat(dedAmt)||0;
  const net=+(gross-ewt-ded).toFixed(2);
  return {gross,netVat,ewt,ded,net};
}

function getBillingCollectedNet(recordId) {
  const record=DB.billing_records.find(r=>r.id===recordId);
  if(!record) return 0;
  return DB.billing_invoices.filter(i=>i.recordId===recordId&&i.status==='Paid').reduce((sum,i)=>sum+calcInvoiceAmounts(i.baseAmount,i.ewtRate,i.dedAmt,record.taxType).net,0);
}

function getBillingOutstanding(recordId) {
  const record=DB.billing_records.find(r=>r.id===recordId);
  if(!record) return 0;
  return +(parseFloat(record.contractAmount)||0) - getBillingCollectedNet(recordId);
}

function blRenderList() {
  const q=(document.getElementById('bl-search')?.value||'').toLowerCase();
  const f=document.getElementById('bl-filter')?.value||'all';
  const filtered=DB.billing_records.filter(r=>{
    const mq=!q||r.company.toLowerCase().includes(q)||(r.project||'').toLowerCase().includes(q);
    const invs=DB.billing_invoices.filter(i=>i.recordId===r.id);
    const totalPaid=getBillingCollectedNet(r.id);
    const settled=totalPaid>=(parseFloat(r.contractAmount)||0)*0.95;
    const mf=f==='all'||(f==='active'&&!settled)||(f==='settled'&&settled);
    return mq&&mf;
  });
  const allInvs=DB.billing_invoices;
  const totalContract=DB.billing_records.reduce((s,r)=>s+(parseFloat(r.contractAmount)||0),0);
  const totalCollected=DB.billing_records.reduce((s,r)=>s+getBillingCollectedNet(r.id),0);
  const totalUnpaid=totalContract-totalCollected;
  const pct=totalContract>0?Math.round(totalCollected/totalContract*100):0;
  document.getElementById('bl-summary-cards').innerHTML=`<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">
    <div class="bl-card"><div class="stat-lbl">Total Contract Value</div><div class="stat-val" style="font-size:20px;">${peso(totalContract)}</div></div>
    <div class="bl-card gn"><div class="stat-lbl">Total Collected</div><div class="stat-val" style="font-size:20px;color:var(--gn);">${peso(totalCollected)}</div><div class="bl-prog-bar"><div class="bl-prog-fill gn" style="width:${pct}%;"></div></div><div style="font-size:10.5px;color:var(--faint);margin-top:4px;">${pct}% of contracts</div></div>
    <div class="bl-card or"><div class="stat-lbl">Outstanding Balance</div><div class="stat-val" style="font-size:20px;color:var(--or);">${peso(totalUnpaid)}</div></div>
  </div>`;
  const el=document.getElementById('bl-list-body'); if(!el) return;
  el.innerHTML=!filtered.length?'<div class="empty-state"><div class="empty-icon">📑</div>No records found.</div>':
    filtered.map(r=>{
      const invs=DB.billing_invoices.filter(i=>i.recordId===r.id);
      const totalPaid=invs.filter(i=>i.status==='Paid').reduce((s,i)=>s+(parseFloat(i.baseAmount)||0),0);
      const outstanding=(parseFloat(r.contractAmount)||0)-totalPaid;
      const pct2=parseFloat(r.contractAmount)>0?Math.round(totalPaid/parseFloat(r.contractAmount)*100):0;
      const overdue=invs.find(i=>i.status!=='Paid'&&i.dueDate&&new Date(i.dueDate+'T00:00:00')<new Date());
      const gate=r.projectId?getBillingGateStatus(r.projectId):{passed:false};
      const gateBadge=gate.passed
        ?'<span class="badge badge-ok" style="font-size:9px;">PO gate open</span>'
        :'<span class="badge badge-unpaid" style="font-size:9px;">PO gate blocked</span>';
      const projCode=r.projectId?`<span style="font-size:10px;color:var(--faint);">${esc(r.projectId)}</span>`:'';
      return `<div style="display:flex;align-items:center;gap:14px;padding:14px 18px;border-bottom:1px solid var(--bd);cursor:pointer;flex-wrap:wrap;" onmouseover="this.style.background='#fdf5fa'" onmouseout="this.style.background=''" onclick="blOpenDetail('${r.id}')">
        <div style="flex:2;min-width:180px;"><div style="font-family:'Syne',sans-serif;font-size:13px;font-weight:800;">${esc(r.company)}</div><div style="font-size:11.5px;color:var(--faint);">${esc(r.project||'–')} ${projCode}</div></div>
        <div style="flex:1;min-width:120px;"><div style="font-size:10.5px;color:var(--faint);">Contract</div><div style="font-weight:700;">${peso(r.contractAmount)}</div></div>
        <div style="flex:1;min-width:120px;"><div style="font-size:10.5px;color:var(--faint);">Collected (net)</div><div style="font-weight:700;color:var(--gn);">${peso(getBillingCollectedNet(r.id))}</div><div style="height:4px;background:var(--paper);border-radius:2px;margin-top:4px;"><div style="height:4px;background:var(--gn);border-radius:2px;width:${pct2}%;"></div></div></div>
        <div style="flex:1;min-width:120px;"><div style="font-size:10.5px;color:var(--faint);">Outstanding</div><div style="font-weight:700;color:${outstanding>0?'var(--or)':'var(--gn)'};">${peso(outstanding)}</div></div>
        <div style="min-width:100px;">${gateBadge} ${overdue?'<span class="bl-inv-overdue">Overdue</span>':''}<br><span style="font-size:10.5px;color:var(--soft);">${invs.length} invoice(s)</span></div>
        <div style="color:var(--mg);">→</div>
      </div>`;
    }).join('');
}

function blOpenDetail(id) {
  activeBillingId=id;
  const r=DB.billing_records.find(x=>x.id===id); if(!r) return;
  const invs=DB.billing_invoices.filter(i=>i.recordId===id);
  const totalPaid=getBillingCollectedNet(id);
  const outstanding=getBillingOutstanding(id);
  const gate=r.projectId?getBillingGateStatus(r.projectId):{passed:false};
  const linkedTkts=DB.tickets.filter(t=>t.projectId===r.projectId&&t.status!=='Completed').slice(0,5);
  const canEditBilling=['admin','accountant'].includes(_currentUser?.role||'');
  document.getElementById('bl-side-info').innerHTML=`
    <div class="si-row"><div class="si-label">Company</div><div class="si-val" style="font-weight:700;">${esc(r.company)}</div></div>
    <div class="si-row"><div class="si-label">Project</div><div class="si-val">${esc(r.project||'–')}</div></div>
    <div class="si-row"><div class="si-label">Project ID</div><div class="si-val">${esc(r.projectId||'–')}</div></div>
    <div class="si-row"><div class="si-label">PO Gate</div><div class="si-val">${gate.passed?'<span style="color:#7aff7a;font-weight:700;">Open</span>':'<span style="color:#ffbb88;font-weight:700;">Blocked</span>'}</div></div>
    <div class="si-row"><div class="si-label">Contract Amount</div><div class="si-val" style="font-weight:700;">${peso(r.contractAmount)}</div></div>
    <div class="si-row"><div class="si-label">Total Collected</div><div class="si-val" style="color:#7aff7a;font-weight:700;">${peso(totalPaid)}</div></div>
    <div class="si-row"><div class="si-label">Outstanding</div><div class="si-val" style="color:${outstanding>0?'#ffbb88':'#7aff7a'};font-weight:700;">${peso(outstanding)}</div></div>
    <div class="si-row"><div class="si-label">TIN</div><div class="si-val">${esc(r.tin||'–')}</div></div>
    ${linkedTkts.length?`<div style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,.15);">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:rgba(255,255,255,.45);margin-bottom:8px;">Linked material tickets</div>
      ${linkedTkts.map(t=>`<div style="font-size:11px;margin-bottom:6px;cursor:pointer;text-decoration:underline;" onclick="viewTicketDetail('${t.id}')">${esc(t.no)} · ${esc(t.status)}</div>`).join('')}
    </div>`:''}
    ${canEditBilling?`<button class="btn btn-mg btn-sm" onclick="blOpenAddInvoiceModal()" style="width:100%;justify-content:center;margin-top:10px;">+ Add Invoice</button>`:''}
    <button class="btn btn-ol btn-sm" onclick="blPrintStatement('${id}')" style="width:100%;justify-content:center;margin-top:6px;">Print Statement</button>
    <button class="btn btn-ol btn-sm" onclick="navigate('billing-list',document.querySelector('[data-page=billing-list]'))" style="width:100%;justify-content:center;margin-top:6px;background:rgba(255,255,255,.1);color:rgba(255,255,255,.7);border-color:rgba(255,255,255,.2);">← Back</button>`;
  document.getElementById('bl-detail-content').innerHTML=`<div style="padding:22px 28px;" data-billing-readonly="${canEditBilling?'0':'1'}">
    <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:800;color:var(--mg);margin-bottom:12px;">${esc(r.company)}</div>
    ${r.projectId?`<div style="margin-bottom:16px;">${renderBillingGatePanel({projectId:r.projectId,project:r.project,id:'billing-view'}, {compact:true})}</div>`:''}
    ${!gate.passed?`<div style="font-size:12px;color:var(--soft);margin:-8px 0 14px;padding:10px 12px;background:var(--paper);border-radius:var(--r);">Mark an invoice as <strong>Paid</strong> to unlock PO creation for engineers on this project (unless Boss &amp; Finance approve an override).</div>`:''}
    ${!invs.length?'<div class="empty-state"><div class="empty-icon">📄</div>No invoices yet. Add a mobilization or downpayment invoice and mark it Paid.</div>':
    `<div class="tbl-wrap" style="box-shadow:none;border:none;border-radius:0;"><table>
      <thead><tr><th>Invoice #</th><th>Date</th><th>Description</th><th style="text-align:right;">Amount</th><th style="text-align:right;">Net Due</th><th>Status</th><th>Due Date</th><th></th></tr></thead>
      <tbody>${invs.map(inv=>{
        const a=calcInvoiceAmounts(inv.baseAmount,inv.ewtRate,inv.dedAmt,r.taxType);
        const isOverdue=inv.status!=='Paid'&&inv.dueDate&&new Date(inv.dueDate+'T00:00:00')<new Date();
        return `<tr>
          <td style="font-family:'Syne',sans-serif;font-weight:700;font-size:12px;color:var(--mg);">${esc(inv.invoiceNo||'–')}</td>
          <td>${fmtDate(inv.invoiceDate)}</td>
          <td style="font-size:12px;">${esc(inv.desc||'')}</td>
          <td style="text-align:right;font-weight:700;">${peso(a.gross)}</td>
          <td style="text-align:right;font-weight:700;color:var(--mg);">${peso(a.net)}</td>
          <td><span class="${inv.status==='Paid'?'bl-inv-paid':isOverdue?'bl-inv-overdue':'bl-inv-unpaid'}">${isOverdue?'Overdue':inv.status}</span></td>
          <td>${fmtDate(inv.dueDate)}</td>
          <td style="white-space:nowrap;">
            ${canEditBilling&&inv.status!=='Paid'?`<button class="btn btn-gn btn-sm" onclick="blMarkPaid('${inv.id}')">Mark Paid</button>`:''}
            ${canEditBilling?`<button class="btn btn-ol btn-sm" onclick="blOpenAddInvoiceModal('${inv.id}')">Edit</button>`:''}
          </td>
        </tr>`;
      }).join('')}</tbody></table></div>`}
  </div>`;
  navigate('billing-detail', null);
}

function blPrintStatement(recordId) {
  const r=DB.billing_records.find(x=>x.id===recordId); if(!r) return;
  const invs=DB.billing_invoices.filter(i=>i.recordId===recordId).slice().sort((a,b)=>(a.invoiceDate||'').localeCompare(b.invoiceDate||''));
  let running=parseFloat(r.contractAmount)||0;
  const rows=invs.map(inv=>{
    const a=calcInvoiceAmounts(inv.baseAmount,inv.ewtRate,inv.dedAmt,r.taxType);
    if(inv.status==='Paid') running-=a.net;
    return `<tr>
      <td>${esc(inv.invoiceNo||'–')}</td>
      <td>${fmtDate(inv.invoiceDate)}</td>
      <td>${esc(inv.desc||'')}</td>
      <td style="text-align:right;">${peso(a.gross)}</td>
      <td style="text-align:right;">−${peso(a.ewt)}</td>
      <td style="text-align:right;">−${peso(a.ded)}</td>
      <td style="text-align:right;font-weight:700;">${peso(a.net)}</td>
      <td style="text-align:right;font-weight:700;">${peso(running)}</td>
      <td>${esc(inv.status||'')}</td>
    </tr>`;
  }).join('');
  const win=window.open('','_blank','width=1100,height=780');
  if(!win) return;
  win.document.write(`
    <html><head><title>Billing Statement - ${esc(r.company)}</title>
    <style>
      body{font-family:Arial,sans-serif;padding:24px;color:#222;font-size:13px;}
      .head{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px;}
      .title{font-size:22px;font-weight:800;margin:0 0 4px;}
      .sub{color:#666;font-size:12px;}
      .meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:16px 0 18px;}
      .meta div{border:1px solid #ddd;border-radius:8px;padding:10px 12px;background:#fafafa;}
      .meta span{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#777;font-weight:700;}
      .meta strong{display:block;margin-top:4px;font-size:14px;}
      table{width:100%;border-collapse:collapse;}
      th,td{border:1px solid #ddd;padding:8px 10px;font-size:12px;vertical-align:top;}
      th{background:#f5f5f5;text-transform:uppercase;letter-spacing:.5px;font-size:10px;}
      @media print{button{display:none;}}
    </style></head><body>
      <div class="head">
        <div>
          <div class="title">Billing Statement</div>
          <div class="sub">${esc(r.company)}</div>
          <div class="sub">${esc(r.project||'–')}</div>
        </div>
        <div style="text-align:right;">
          <div class="sub">Printed ${new Date().toLocaleDateString('en-PH')}</div>
          <div class="sub">TIN ${esc(r.tin||'–')}</div>
        </div>
      </div>
      <div class="meta">
        <div><span>Contract Amount</span><strong>${peso(r.contractAmount)}</strong></div>
        <div><span>Collected Net</span><strong>${peso(getBillingCollectedNet(recordId))}</strong></div>
        <div><span>Outstanding</span><strong>${peso(getBillingOutstanding(recordId))}</strong></div>
        <div><span>Tax Type</span><strong>${esc(r.taxType||'–')}</strong></div>
      </div>
      <table>
        <thead><tr><th>Invoice #</th><th>Date</th><th>Description</th><th style="text-align:right;">Gross</th><th style="text-align:right;">EWT</th><th style="text-align:right;">Deductions</th><th style="text-align:right;">Net</th><th style="text-align:right;">Running Balance</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div style="margin-top:18px;display:flex;gap:8px;justify-content:flex-end;">
        <button onclick="window.print()" style="padding:8px 14px;border:none;background:#8a0052;color:#fff;border-radius:6px;cursor:pointer;">Print</button>
        <button onclick="window.close()" style="padding:8px 14px;border:none;background:#eee;color:#222;border-radius:6px;cursor:pointer;">Close</button>
      </div>
    </body></html>
  `);
  win.document.close();
}

function blMarkPaid(invId) {
  const inv=DB.billing_invoices.find(i=>i.id===invId);
  if(!inv||inv.status==='Paid') return;
  const record=DB.billing_records.find(r=>r.id===inv.recordId);
  inv.status='Paid';
  inv.paidDate=today();
  logSystemActivity('Invoice marked paid',record?.project||inv.invoiceNo,`${inv.invoiceNo||''} — ${inv.desc||''}`);
  if(record?.projectId) onBillingPaymentRecorded(record.projectId, inv.desc||inv.invoiceNo);
  saveDB();
  blOpenDetail(activeBillingId);
  toast('Invoice marked paid. PO gate updated for this project.','ok');
}

function blOpenAddInvoiceModal(invId) {
  editingInvoiceId=invId||null;
  const r=DB.billing_records.find(x=>x.id===activeBillingId);
  document.getElementById('inv-mo-title').textContent=invId?'Edit Invoice':'Add Invoice';
  if(invId) {
    const inv=DB.billing_invoices.find(i=>i.id===invId);
    if(inv) {
      document.getElementById('blinv-no').value=inv.invoiceNo||'';
      document.getElementById('blinv-date').value=inv.invoiceDate||today();
      document.getElementById('blinv-desc').value=inv.desc||'';
      document.getElementById('blinv-amount').value=inv.baseAmount||'';
      document.getElementById('blinv-due').value=inv.dueDate||'';
      document.getElementById('blinv-ewt-rate').value=inv.ewtRate||r?.ewtRate||2;
      document.getElementById('blinv-ded-amt').value=inv.dedAmt||0;
      const st=document.getElementById('blinv-status'); if(st) st.value=inv.status||'Unpaid';
      const pd=document.getElementById('blinv-paid-date'); if(pd) pd.value=inv.paidDate||today();
      blToggleInvoicePaidFields();
    }
  } else {
    ['blinv-no','blinv-desc'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    document.getElementById('blinv-date').value=today();
    document.getElementById('blinv-amount').value='';
    document.getElementById('blinv-due').value='';
    document.getElementById('blinv-ewt-rate').value=r?.ewtRate||2;
    document.getElementById('blinv-ded-amt').value=0;
    const st=document.getElementById('blinv-status'); if(st) st.value='Unpaid';
    const pd=document.getElementById('blinv-paid-date'); if(pd) pd.value=today();
    blToggleInvoicePaidFields();
  }
  blUpdateInvoicePreview();
  openMo('mo-add-invoice');
}

function blUpdateInvoicePreview() {
  const r=DB.billing_records.find(x=>x.id===activeBillingId);
  const gross=parseFloat(document.getElementById('blinv-amount')?.value)||0;
  const ewtRate=parseFloat(document.getElementById('blinv-ewt-rate')?.value)||0;
  const ded=parseFloat(document.getElementById('blinv-ded-amt')?.value)||0;
  const a=calcInvoiceAmounts(gross,ewtRate,ded,r?.taxType||'VAT');
  const set=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
  set('blinv-gross-preview',peso(a.gross)); set('blinv-ewt-amount-preview',`−${peso(a.ewt)}`);
  set('blinv-ded-preview',`−${peso(a.ded)}`); set('blinv-amount-due-preview',peso(a.net));
}

function blToggleInvoicePaidFields() {
  const st=document.getElementById('blinv-status')?.value;
  const row=document.getElementById('blinv-paid-date-row');
  if(row) row.style.display=st==='Paid'?'block':'none';
}

function blSaveRecord() {
  const company=document.getElementById('bl-add-company')?.value.trim();
  const project=document.getElementById('bl-add-project')?.value.trim();
  let projectId=document.getElementById('bl-add-project-id')?.value||'';
  if(!company) { toast('Error: Company name is required.'); return; }
  if(!project) { toast('Error: Awarded project name is required.'); return; }
  const rec={
    id:uid(),company,project,
    projectId:projectId||null,
    contractAmount:parseFloat(document.getElementById('bl-add-contract')?.value)||0,
    taxType:document.getElementById('bl-add-tax')?.value||'VAT',
    ewtRate:parseFloat(document.getElementById('bl-add-ewt')?.value)||2,
    tin:document.getElementById('bl-add-tin')?.value.trim()||'',
    status:'active',createdAt:today(),
  };
  reconcileBillingRecordProject(rec);
  ensureProjectForBillingRecord(rec);
  DB.billing_records.unshift(rec);
  logSystemActivity('Billing record created',rec.project,`Synced to project ${rec.projectId||'—'} — visible on engineer tickets`);
  saveDB();
  buildDatalist();
  blRenderList();
  closeMo('mo-add-billing');
  toast('Billing record added. Engineers can select this project on material tickets.','ok');
}

function blSaveInvoice() {
  const invoiceNo=document.getElementById('blinv-no')?.value.trim();
  const invoiceDate=document.getElementById('blinv-date')?.value||today();
  const desc=document.getElementById('blinv-desc')?.value.trim();
  const baseAmount=parseFloat(document.getElementById('blinv-amount')?.value)||0;
  const dueDate=document.getElementById('blinv-due')?.value||'';
  const ewtRate=parseFloat(document.getElementById('blinv-ewt-rate')?.value)||0;
  const dedAmt=parseFloat(document.getElementById('blinv-ded-amt')?.value)||0;
  if(!desc||!baseAmount) { toast('Error: Description and amount are required.'); return; }
  const status=document.getElementById('blinv-status')?.value||'Unpaid';
  const paidDate=status==='Paid'?(document.getElementById('blinv-paid-date')?.value||today()):'';
  const inv={id:editingInvoiceId||uid(),recordId:activeBillingId,invoiceNo,invoiceDate,dueDate,desc,baseAmount,ewtRate,dedAmt,status,paidDate};
  const wasUnpaid=editingInvoiceId?DB.billing_invoices.find(i=>i.id===editingInvoiceId)?.status!=='Paid':true;
  if(editingInvoiceId) { const idx=DB.billing_invoices.findIndex(i=>i.id===editingInvoiceId); if(idx>=0) DB.billing_invoices[idx]=inv; }
  else DB.billing_invoices.unshift(inv);
  const record=DB.billing_records.find(r=>r.id===activeBillingId);
  if(status==='Paid'&&wasUnpaid&&record?.projectId) {
    logSystemActivity('Invoice saved as paid',record.project,inv.desc||'');
    onBillingPaymentRecorded(record.projectId, inv.desc||inv.invoiceNo);
  }
  saveDB();
  blOpenDetail(activeBillingId);
  closeMo('mo-add-invoice');
  toast(status==='Paid'?'Invoice saved and marked Paid — PO gate updated.':'Invoice saved.','ok');
}

// ── SUBCONTRACTORS ────────────────────────────────────────────
let activeScId=null;
function renderSubcon() {
  const el=document.getElementById('subcon-list'); if(!el) return;
  el.innerHTML=DB.subcontractors.map(sc=>{
    const totalBilled=sc.billings.reduce((s,b)=>s+(parseFloat(b.amount)||0),0);
    const totalPaid=sc.billings.filter(b=>b.status==='Paid').reduce((s,b)=>s+(parseFloat(b.amount)||0),0);
    const totalDed=sc.deductions.reduce((s,d)=>s+(parseFloat(d.amount)||0),0);
    const balance=(parseFloat(sc.contractAmount)||0)-totalPaid-totalDed;
    return `<div class="sc-row" onclick="openScDetail('${sc.id}')">
      <div style="flex:1;"><div class="sc-name">${esc(sc.name)}</div><div class="sc-trade">${esc(sc.trade)}</div></div>
      <div style="flex:1;min-width:120px;"><div style="font-size:10px;color:var(--faint);">Contract</div><div class="sc-num-val">${peso(sc.contractAmount)}</div></div>
      <div style="flex:1;min-width:100px;"><div style="font-size:10px;color:var(--faint);">Billed</div><div class="sc-num-val">${peso(totalBilled)}</div></div>
      <div style="flex:1;min-width:100px;"><div style="font-size:10px;color:var(--faint);">Balance</div><div class="sc-num-val ${balance>0?'sc-balance-pos':'sc-balance-neg'}">${peso(balance)}</div></div>
      <div style="color:var(--mg);">→</div>
    </div>`;
  }).join('');
}

function openScDetail(id) {
  activeScId=id;
  const sc=DB.subcontractors.find(x=>x.id===id); if(!sc) return;
  const totalBilled=sc.billings.reduce((s,b)=>s+(parseFloat(b.amount)||0),0);
  const totalPaid=sc.billings.filter(b=>b.status==='Paid').reduce((s,b)=>s+(parseFloat(b.amount)||0),0);
  const totalDed=sc.deductions.reduce((s,d)=>s+(parseFloat(d.amount)||0),0);
  const balance=(parseFloat(sc.contractAmount)||0)-totalPaid-totalDed;
  document.getElementById('sc-detail-body').innerHTML=`
    <div class="sc-contract-banner">
      <div><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--mg);margin-bottom:4px;">Contract</div><div class="sc-banner-val">${peso(sc.contractAmount)}</div></div>
      <div><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--faint);margin-bottom:4px;">Project</div><div style="font-size:12px;">${esc(sc.project||'–')}</div></div>
      <div><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--faint);margin-bottom:4px;">Contact</div><div style="font-size:12px;">${esc(sc.contact||'–')}</div></div>
    </div>
    <div style="font-family:'Syne',sans-serif;font-size:11px;font-weight:700;color:var(--soft);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Billings</div>
    <div class="tbl-wrap" style="margin-bottom:14px;">
      <table><thead><tr><th>Date</th><th>Description</th><th style="text-align:right;">Amount</th><th>Status</th><th></th></tr></thead>
      <tbody>${sc.billings.map(b=>`<tr>
        <td>${fmtDate(b.date)}</td><td>${esc(b.desc)}</td>
        <td style="text-align:right;font-weight:700;">${peso(b.amount)}</td>
        <td><span class="${b.status==='Paid'?'badge-paid':'badge-unpaid'}" style="padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700;">${b.status}</span></td>
        <td>${b.status!=='Paid'?`<button class="btn btn-gn btn-sm" onclick="scMarkPaid('${sc.id}','${b.id}')">Paid</button>`:''}</td>
      </tr>`).join('')}</tbody></table>
    </div>
    ${sc.deductions.length?`<div style="font-family:'Syne',sans-serif;font-size:11px;font-weight:700;color:var(--soft);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Deductions</div>
    <div class="tbl-wrap" style="margin-bottom:14px;"><table><thead><tr><th>Date</th><th>Description</th><th style="text-align:right;">Amount</th></tr></thead>
    <tbody>${sc.deductions.map(d=>`<tr><td>${fmtDate(d.date)}</td><td>${esc(d.desc)}</td><td style="text-align:right;color:var(--rd);font-weight:700;">−${peso(d.amount)}</td></tr>`).join('')}</tbody></table></div>`:''}
    <div class="sc-ledger">
      <div class="sc-ledger-row"><span>Total Contract</span><span>${peso(sc.contractAmount)}</span></div>
      <div class="sc-ledger-row"><span>Total Billed</span><span>${peso(totalBilled)}</span></div>
      <div class="sc-ledger-row"><span>Total Paid</span><span style="color:var(--gn);">${peso(totalPaid)}</span></div>
      <div class="sc-ledger-row"><span>Total Deductions</span><span style="color:var(--rd);">−${peso(totalDed)}</span></div>
      <div class="sc-ledger-row total"><span>Balance to Pay</span><span>${peso(balance)}</span></div>
    </div>`;
  navigate('acc-subcon-detail', null);
}

function scMarkPaid(scId, billId) {
  const sc=DB.subcontractors.find(x=>x.id===scId); if(!sc) return;
  const b=sc.billings.find(x=>x.id===billId); if(!b) return;
  b.status='Paid'; saveDB(); openScDetail(scId); toast('Billing marked as paid.','ok');
}

function saveSubcon() {
  const name=document.getElementById('sc-add-name')?.value.trim();
  const contract=parseFloat(document.getElementById('sc-add-contract')?.value)||0;
  if(!name||!contract) { toast('Error: Name and contract amount are required.'); return; }
  const sc={id:uid(),name,trade:document.getElementById('sc-add-trade')?.value.trim()||'',contractAmount:contract,project:document.getElementById('sc-add-project')?.value.trim()||'',contact:document.getElementById('sc-add-contact')?.value.trim()||'',billings:[],deductions:[]};
  DB.subcontractors.unshift(sc); saveDB(); renderSubcon();
  closeMo('mo-add-subcon'); toast('Subcontractor added.','ok');
}

// ── EXPENSES ──────────────────────────────────────────────────
let expEditId=null, expSubView='list';

function expRenderList() {
  const q=(document.getElementById('exp-search')?.value||'').toLowerCase();
  const f=document.getElementById('exp-filter')?.value||'all';
  const from=document.getElementById('exp-from')?.value||'';
  const to=document.getElementById('exp-to')?.value||'';
  const filtered=DB.expenses.filter(e=>{
    const mq=!q||(e.payee||'').toLowerCase().includes(q)||(e.project||'').toLowerCase().includes(q)||(e.particulars||'').toLowerCase().includes(q);
    const mf=f==='all'||e.category===f;
    const md=(!from||e.date>=from)&&(!to||e.date<=to);
    return mq&&mf&&md;
  });

  const total=filtered.reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
  const statEl=document.getElementById('exp-summary');
  if(statEl) statEl.innerHTML=`<div class="stat-card" style="display:inline-block;min-width:200px;margin-bottom:16px;"><div class="stat-lbl">Total Filtered</div><div class="stat-val" style="font-size:22px;">${peso(total)}</div><div class="stat-sub">${filtered.length} transaction(s)</div></div>`;

  const el=document.getElementById('exp-list'); if(!el) return;
  el.innerHTML=!filtered.length?'<div class="empty-state"><div class="empty-icon">💰</div>No expenses found.</div>':
    `<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Category</th><th>Payee</th><th>SI/OR #</th><th>Project</th><th>Particulars</th><th style="text-align:right;">Amount</th><th>Payment</th><th></th></tr></thead>
    <tbody>${filtered.map(e=>`<tr>
      <td style="font-size:11.5px;color:var(--faint);">${fmtDate(e.date)}</td>
      <td><span class="item-cat-badge">${esc(e.category)}</span></td>
      <td style="font-weight:500;">${esc(e.payee)}</td>
      <td style="font-size:11.5px;color:var(--soft);">${esc(e.sino||'–')}</td>
      <td style="font-size:11.5px;"><span class="po-item-project-tag">${esc(e.project||'–')}</span></td>
      <td style="font-size:12px;">${esc(e.particulars||'')}</td>
      <td style="text-align:right;font-weight:700;">${peso(e.amount)}</td>
      <td style="font-size:11.5px;color:var(--soft);">${esc(e.paymentType)}</td>
      <td><button class="btn btn-ol btn-sm" onclick="openExpEdit('${e.id}')">Edit</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}

function openExpAddModal() {
  expEditId=null;
  document.getElementById('exp-mo-title').textContent='Add Expense';
  document.getElementById('exp-delete-btn').style.display='none';
  ['exp-f-payee','exp-f-sino','exp-f-project','exp-f-particulars','exp-f-remarks'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('exp-f-amount').value='';
  document.getElementById('exp-f-date').value=today();
  openMo('mo-add-expense');
}

function openExpEdit(id) {
  const e=DB.expenses.find(x=>x.id===id); if(!e) return;
  expEditId=id;
  document.getElementById('exp-mo-title').textContent='Edit Expense';
  document.getElementById('exp-delete-btn').style.display='';
  const set=(k,v)=>{const el=document.getElementById(k);if(el)el.value=v||'';};
  set('exp-f-date',e.date); set('exp-f-payee',e.payee); set('exp-f-sino',e.sino);
  set('exp-f-project',e.project); set('exp-f-particulars',e.particulars);
  set('exp-f-amount',e.amount); set('exp-f-remarks',e.remarks);
  document.getElementById('exp-f-cat').value=e.category||'Others';
  document.getElementById('exp-f-payment').value=e.paymentType||'Cash';
  openMo('mo-add-expense');
}

function saveExpense() {
  const date=document.getElementById('exp-f-date').value;
  const cat=document.getElementById('exp-f-cat').value;
  const payee=document.getElementById('exp-f-payee').value.trim();
  const sino=document.getElementById('exp-f-sino').value.trim();
  const project=document.getElementById('exp-f-project').value.trim();
  const particulars=document.getElementById('exp-f-particulars').value.trim();
  const amount=parseFloat(document.getElementById('exp-f-amount').value)||0;
  const payment=document.getElementById('exp-f-payment').value;
  const remarks=document.getElementById('exp-f-remarks').value.trim();
  if(!payee||!amount) { toast('Error: Payee and amount are required.'); return; }
  const exp={id:expEditId||uid(),date,category:cat,payee,sino,project,particulars,amount,paymentType:payment,remarks,status:'Released'};
  if(expEditId) { const idx=DB.expenses.findIndex(x=>x.id===expEditId); if(idx>=0) DB.expenses[idx]=exp; }
  else DB.expenses.unshift(exp);
  saveDB(); expRenderList(); closeMo('mo-add-expense'); toast('Expense saved.','ok');
}

function deleteExpense() {
  if(!confirm('Delete this expense?')) return;
  DB.expenses=DB.expenses.filter(x=>x.id!==expEditId);
  saveDB(); expRenderList(); closeMo('mo-add-expense'); toast('Expense deleted.','ok');
}

function expGoPage(tab, btn) {
  document.querySelectorAll('#page-acc-expenses .exp-sub-btn').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  const list = document.getElementById('exp-page-list');
  const report = document.getElementById('exp-page-report');
  if(tab === 'report') {
    if(list) list.style.display='none';
    if(report) { report.style.display='block'; renderExpSummaryReport(); }
  } else {
    if(list) list.style.display='block';
    if(report) report.style.display='none';
    expRenderList();
  }
}

function renderExpSummaryReport() {
  const el = document.getElementById('exp-page-report');
  if(!el) return;
  const total = DB.expenses.reduce((s,e)=>s+(parseFloat(e.amount)||0),0);
  el.innerHTML = `
    <div class="card" style="padding:24px;">
      <div class="stat-lbl">Grand Total (General Expenses)</div>
      <div class="stat-val" style="color:var(--mg);">${peso(total)}</div>
      <div style="margin-top:14px;font-size:12px;color:var(--soft);">This summary includes all logged general expenses. For project-specific material costs, visit the <strong>Expenses per Project</strong> report.</div>
    </div>`;
}

// ── OVERRIDE QUEUE (Boss / Finance) ───────────────────────────
let _overrideRejectRole = 'boss';

function updateOverrideNavBadge() {
  const nb=document.getElementById('nb-override-pend');
  const cnt=getPendingOverrideTickets().length;
  if(nb) nb.textContent=cnt||'';
  const oq=document.getElementById('boss-oq-cnt');
  if(oq) oq.textContent=cnt;
}

function approvalBadgeHtml(approved, label) {
  return `<span class="approval-pill ${approved?'yes':'no'}">${label}: ${approved?'✓ Approved':'Pending'}</span>`;
}

function buildOverrideQueueHTML(approverRole, opts={}) {
  const {compact=false, showViewAll=false} = opts;
  const tickets=getPendingOverrideTickets();
  if(!tickets.length) {
    return `<div class="dash-widget" style="margin-top:${compact?0:18}px;">
      <div class="dash-widget-head"><div class="dash-widget-title">🛡 Pending Override Requests</div><span class="badge badge-completed">0</span></div>
      <div class="dash-widget-body"><div class="empty-state"><div class="empty-icon">✓</div>No override requests pending</div></div>
    </div>`;
  }
  const roleLabel=approverRole==='boss'?'Boss':'Finance';
  const rows=tickets.map(t=>{
    const proj=DB.projects.find(p=>p.id===t.projectId);
    const client=proj?.client||'–';
    const engineer=t.engineerName||t.submittedBy||'–';
    const canAct=approverRole==='boss' ? !t.bossApproved : !t.financeApproved;
    const gate=t.projectId?getBillingGateStatus(t.projectId):{passed:false};
    const billHint=gate.passed?'Paid inv.':'No paid inv.';
    return `<tr>
      <td style="font-family:'Syne',sans-serif;font-weight:800;color:var(--mg);">${esc(t.no)}</td>
      <td>${esc(t.project)}<br><span style="font-size:10px;color:var(--faint);">${esc(billHint)}</span></td>
      <td style="font-size:12px;color:var(--soft);">${esc(client)}</td>
      <td>${esc(engineer)}</td>
      <td style="font-size:11.5px;color:var(--faint);">${fmtDate((t.submittedAt||'').split('T')[0])}</td>
      <td><div style="display:flex;flex-direction:column;gap:4px;">${approvalBadgeHtml(!!t.bossApproved,'Boss')}${approvalBadgeHtml(!!t.financeApproved,'Finance')}</div></td>
      <td style="white-space:nowrap;">
        ${canAct?`<button class="btn btn-gn btn-sm" onclick="approveOverride('${t.id}','${approverRole}')">Approve Override</button>`:''}
        <button class="btn btn-rd btn-sm" style="margin-left:4px;" onclick="openOverrideReject('${t.id}','${approverRole}')">Reject</button>
      </td>
    </tr>`;
  }).join('');
  return `<div class="dash-widget" style="margin-top:${compact?0:18}px;">
    <div class="dash-widget-head">
      <div class="dash-widget-title" style="color:var(--or);">🛡 Pending Override Requests</div>
      <span class="badge badge-pending-override">${tickets.length}</span>
      ${showViewAll&&_currentUser?.role==='boss'?`<button class="btn btn-ol btn-sm" style="margin-left:auto;" onclick="navigate('boss-override-queue',document.querySelector('[data-page=boss-override-queue]'))">View All</button>`:''}
    </div>
    <div class="dash-widget-body ${compact?'no-pad':''}">
      <div class="tbl-wrap" style="border:none;box-shadow:none;">
        <table><thead><tr>
          <th>Ticket #</th><th>Project / Billing</th><th>Client</th><th>Engineer</th><th>Submitted</th><th>Approvals</th><th>${roleLabel} Action</th>
        </tr></thead><tbody>${rows}</tbody></table>
      </div>
    </div>
  </div>`;
}

function approveOverride(ticketId, approverRole) {
  const t=DB.tickets.find(x=>x.id===ticketId);
  if(!t) return;
  const name=_currentUser?.name||'–';
  if(approverRole==='boss') {
    t.bossApproved=true;
    appendTicketAudit(t,'Boss approved',`Override approved by ${name}`);
  } else {
    t.financeApproved=true;
    appendTicketAudit(t,'Finance approved',`Override approved by ${name}`);
  }
  saveDB();
  toast('Override approved.','ok');
  refreshOverrideViews();
}

function openOverrideReject(ticketId, approverRole) {
  _overrideRejectRole=approverRole;
  const hid=document.getElementById('override-reject-ticket-id');
  const reason=document.getElementById('override-reject-reason');
  if(hid) hid.value=ticketId;
  if(reason) reason.value='';
  openMo('mo-override-reject');
}

function confirmOverrideReject() {
  const ticketId=document.getElementById('override-reject-ticket-id')?.value;
  const reason=(document.getElementById('override-reject-reason')?.value||'').trim();
  if(!reason) { toast('Error: Rejection reason is required.'); return; }
  const t=DB.tickets.find(x=>x.id===ticketId);
  if(!t) return;
  const name=_currentUser?.name||'–';
  t.bossApproved=false;
  t.financeApproved=false;
  t.status='Pending';
  t.rejectionReason=reason;
  if(_overrideRejectRole==='boss') {
    appendTicketAudit(t,'Boss rejected',`Override rejected by ${name} — ${reason}`);
  } else {
    appendTicketAudit(t,'Finance rejected',`Override rejected by ${name} — ${reason}`);
  }
  saveDB();
  closeMo('mo-override-reject');
  toast('Override rejected. Ticket returned to Pending.','ok');
  refreshOverrideViews();
}

function refreshOverrideViews() {
  updateOverrideNavBadge();
  if(currentPage==='boss-dashboard') renderBossDashboard();
  if(currentPage==='boss-override-queue') renderBossOverrideQueue();
  if(currentPage==='acc-dashboard') renderAccDashboard();
}

// ── BOSS DASHBOARD & READ-ONLY VIEWS ──────────────────────────
function renderBossDashboard() {
  const elDt=document.getElementById('boss-datetime');
  if(elDt) elDt.textContent=new Date().toLocaleDateString('en-PH',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  const activeProj=DB.projects.filter(p=>p.status==='Active').length;
  const pendOv=getPendingOverrideTickets().length;
  const billed=DB.billing_invoices.reduce((s,i)=>s+(parseFloat(i.baseAmount)||0),0);
  const activePOs=DB.purchase_orders.filter(p=>p.status==='Pending'||p.status==='Approved').length;
  const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
  set('boss-proj-cnt',activeProj);
  set('boss-override-cnt',pendOv);
  set('boss-billed-val',billed>=1000000?`₱${(billed/1000000).toFixed(1)}M`:`₱${(billed/1000).toFixed(0)}K`);
  set('boss-po-cnt',activePOs);
  const sec=document.getElementById('boss-dash-override-section');
  if(sec) sec.innerHTML=buildOverrideQueueHTML('boss',{compact:false, showViewAll:true});
  updateOverrideNavBadge();
}

function renderBossOverrideQueue() {
  const el=document.getElementById('boss-override-list');
  if(el) el.innerHTML=buildOverrideQueueHTML('boss',{compact:true});
  updateOverrideNavBadge();
}

function renderBossProjectsList() {
  const el=document.getElementById('boss-projects-list-wrap');
  if(!el) return;
  el.innerHTML=`<div class="tbl-wrap"><table>
    <thead><tr><th>Project Name</th><th>Client</th><th>Code</th><th style="text-align:right;">Contract</th><th>Status</th><th>Location</th></tr></thead>
    <tbody>${DB.projects.map(p=>`<tr>
      <td style="font-family:'Syne',sans-serif;font-weight:700;color:var(--mg);">${esc(p.name)}</td>
      <td style="font-size:12px;color:var(--soft);">${esc(p.client||'–')}</td>
      <td><span class="project-code">${esc(p.code||'–')}</span></td>
      <td style="text-align:right;font-weight:700;">${p.contractAmount>0?peso(p.contractAmount):'–'}</td>
      <td><span class="${p.status==='Active'?'badge-active':p.status==='Completed'?'badge-completed-proj':'badge-on-hold'}" style="padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700;">${esc(p.status)}</span></td>
      <td style="font-size:12px;color:var(--faint);">${esc(p.location||'–')}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function renderBossPOList() {
  const q=(document.getElementById('boss-po-search')?.value||'').toLowerCase();
  const f=document.getElementById('boss-po-filter')?.value||'all';
  const filtered=DB.purchase_orders.filter(p=>{
    const mq=!q||p.no.toLowerCase().includes(q)||(p.vendor||'').toLowerCase().includes(q);
    return mq&&(f==='all'||p.status===f);
  });
  const el=document.getElementById('boss-po-list-body');
  if(!el) return;
  const badgeMap={'Pending':'pending','Approved':'ok','Received':'completed','Cancelled':'overdue'};
  el.innerHTML=!filtered.length?'<div class="empty-state">No POs found.</div>':
    `<table><thead><tr><th>PO #</th><th>Vendor</th><th>Project</th><th>Date</th><th style="text-align:right;">Total</th><th>Status</th></tr></thead>
    <tbody>${filtered.map(p=>{
      const total=p.items.reduce((s,i)=>s+(i.qty||0)*(i.unitPrice||0),0);
      return `<tr>
        <td style="font-family:'Syne',sans-serif;font-weight:800;color:var(--mg);">${esc(p.no)}</td>
        <td>${esc(p.vendor)}</td>
        <td>${esc(p.project||'–')}</td>
        <td style="font-size:11.5px;color:var(--faint);">${fmtDate(p.date)}</td>
        <td style="text-align:right;font-weight:700;">${peso(total)}</td>
        <td><span class="badge badge-${badgeMap[p.status]||'pending'}">${p.status}</span></td>
      </tr>`;
    }).join('')}</tbody></table>`;
}

function renderBossBillingSummary() {
  const el=document.getElementById('boss-billing-summary');
  if(!el) return;
  const rows=DB.billing_records.map(r=>{
    const collected=getBillingCollectedNet(r.id);
    const outstanding=getBillingOutstanding(r.id);
    const gate=r.projectId?getBillingGateStatus(r.projectId):{passed:false};
    return `<tr style="cursor:pointer;" onclick="blOpenDetail('${r.id}')">
      <td style="font-weight:600;">${esc(r.company)}</td>
      <td>${esc(r.project)}<br><span style="font-size:10px;color:var(--faint);">${esc(r.projectId||'–')}</span></td>
      <td style="text-align:right;">${peso(r.contractAmount)}</td>
      <td style="text-align:right;color:var(--gn);font-weight:700;">${peso(collected)}</td>
      <td style="text-align:right;color:var(--or);font-weight:700;">${peso(outstanding)}</td>
      <td><span class="badge badge-${gate.passed?'ok':'unpaid'}">${gate.passed?'PO OK':'Blocked'}</span></td>
    </tr>`;
  }).join('');
  el.innerHTML=`<div class="tbl-wrap"><table>
    <thead><tr><th>Company</th><th>Project</th><th style="text-align:right;">Contract</th><th style="text-align:right;">Collected</th><th style="text-align:right;">Outstanding</th><th>PO Gate</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <p style="font-size:11.5px;color:var(--faint);padding:12px 16px;">Read-only view. Accountants manage invoices under Billing.</p>`;
}

// ── TICKET HISTORY ────────────────────────────────────────────
function initHistory() {
  document.getElementById('h-from').value='2025-01-01';
  document.getElementById('h-to').value=today();
  showHistList();
}

function showHistList() {
  const from=document.getElementById('h-from')?.value;
  const to=document.getElementById('h-to')?.value;
  const filtered=DB.tickets.filter(t=>{const d=t.submittedAt.split('T')[0];return (!from||d>=from)&&(!to||d<=to);});
  const el=document.getElementById('hv-list'); if(!el) return;
  el.innerHTML=!filtered.length?'<div class="empty-state">No tickets in this date range.</div>':
    `<div class="tbl-wrap"><table><thead><tr><th>Ticket #</th><th>PM</th><th>Project</th><th>Submitted</th><th>Status</th><th>Materials</th></tr></thead>
    <tbody>${filtered.map(t=>`<tr>
      <td style="font-family:'Syne',sans-serif;font-weight:800;color:var(--mg);">${t.no} ${t.urgent?'⚡':''}</td>
      <td>${esc(t.pm)}</td>
      <td style="font-weight:500;">${esc(t.project)}</td>
      <td style="font-size:11.5px;color:var(--faint);">${fmtDate(t.submittedAt.split('T')[0])}</td>
      <td><span class="badge badge-${statusBadgeClass(t.status)}">${t.status}</span></td>
      <td style="font-size:11.5px;color:var(--soft);">${t.materials.map(m=>m.name.split(':').pop()).join(', ')}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

// ── ACTIVITY LOG ──────────────────────────────────────────────
function initActivityLog() {
  document.getElementById('log-f-from').value='2025-01-01';
  document.getElementById('log-f-to').value=today();
  document.getElementById('log-f-search').value='';
  renderActivityLog();
}

function renderActivityLog() {
  const from=document.getElementById('log-f-from')?.value;
  const to=document.getElementById('log-f-to')?.value;
  const search=(document.getElementById('log-f-search')?.value||'').toLowerCase();
  const invLogs=(DB.inventory_log||[]).map(l=>{
    let user='System';
    const m=(l.remarks||'').match(/\(([^)]+)\)/); if(m) user=m[1];
    const actionMap={in:'Stock In',out:'Stock Out',ticket:'Ticket',reserve:'Reservation',release:'Site Release',adjust:'Adjustment',po:'PO Created',approve:'PO Approved',receive:'PO Received',action:'Action'};
    return {id:l.id||uid(),dt:l.dt||nowISO(),user,action:actionMap[l.type]||l.type,entity:l.itemName||'',details:l.remarks||'',status:'success'};
  });
  const combined=[...(DB.system_logs||[]),...invLogs].sort((a,b)=>new Date(b.dt)-new Date(a.dt));
  const filtered=combined.filter(log=>{
    const logDate=(log.dt||'').split('T')[0];
    return (!from||logDate>=from)&&(!to||logDate<=to)&&(!search||(log.user||'').toLowerCase().includes(search)||(log.action||'').toLowerCase().includes(search)||(log.entity||'').toLowerCase().includes(search)||(log.details||'').toLowerCase().includes(search));
  });
  const tbody=document.getElementById('log-activity-tbody'); if(!tbody) return;
  tbody.innerHTML=!filtered.length?'<tr><td colspan="6" class="empty-state">No activity logs found.</td></tr>':
    filtered.map(log=>`<tr>
      <td style="font-size:11.5px;color:var(--faint);">${fmtDT(log.dt)}</td>
      <td style="font-weight:600;">${esc(log.user)}</td>
      <td style="font-size:12px;">${esc(log.action)}</td>
      <td style="font-family:'Syne',sans-serif;font-size:11px;font-weight:700;color:var(--mg);">${esc(log.entity)}</td>
      <td style="font-size:11.5px;color:var(--soft);">${esc(log.details)}</td>
      <td><span style="background:${log.status==='success'?'#d4edda':'#f8d7da'};color:${log.status==='success'?'#155724':'#721c24'};padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700;">${log.status}</span></td>
    </tr>`).join('');
  const cnt=document.getElementById('log-activity-count');
  if(cnt) cnt.textContent=`Showing ${filtered.length} of ${combined.length} total activity logs`;
}

// ── BOOT ──────────────────────────────────────────────────────
if(document.readyState==='loading') { document.addEventListener('DOMContentLoaded',buildDatalist); }
else { buildDatalist(); }
