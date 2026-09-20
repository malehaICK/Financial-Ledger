const CATEGORIES = [
  ["Housing","Need"],["Utilities","Need"],["Groceries","Need"],["Transportation","Need"],
  ["Insurance","Need"],["Debt Payments","Need"],["Health & Medical","Need"],["Education","Need"],
  ["Childcare","Need"],["Subscriptions","Want"],["Entertainment","Want"],["Dining Out","Want"],
  ["Personal Care","Want"],["Shopping","Want"],["Other","Want"],["Savings & Investments","Savings"]
];
const CAT_TYPE = Object.fromEntries(CATEGORIES);


const SUPABASE_URL = 'https://eudodyfntnxzlnemtdxt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_KgCUIR8Qg2sMlnT8VDspoA_coGSOFXQ';

let dbClient = null;
let currentUser = null;
let state = { income: [], expenses: [], goals: [] };
let databaseMode = false;
let splitSchemaAvailable = false;
let goalsSchemaAvailable = false;
let fingerprintAvailable = true;

const cal = { mode: 'month', year: 0, month: 0, selected: null, dayOpen: false };

const fmt = n => (n<0?'-$':'$') + Math.abs(Number(n)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});


function getAuthRedirectUrl(){
  if(window.location.protocol === 'http:' || window.location.protocol === 'https:'){
    return window.location.origin + window.location.pathname;
  }
  return window.location.href.split('#')[0];
}

function isDatabaseConfigured(){
  return SUPABASE_URL.startsWith('https://') && !SUPABASE_URL.includes('YOUR_') &&
         SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.includes('YOUR_');
}

function setAppEnabled(enabled){
  document.querySelectorAll('section input, section select, section button').forEach(el=>{
    el.disabled = !enabled;
  });
}

function normalizeDbRows(rows){
  const income = [];
  const expenses = [];
  (rows || []).forEach(r=>{
    const amount = Number(r.amount);
    if(!r.id || !r.transaction_date || !Number.isFinite(amount) || amount < 0) return;
    if(r.transaction_type === 'income'){
      income.push({id:String(r.id), date:String(r.transaction_date), source:String(r.source || r.description || '(bank transaction)'), amount});
    }else if(r.transaction_type === 'expense'){
      // Shared expenses: amount is the user's own share; grossAmount is the full bill.
      expenses.push({id:String(r.id), date:String(r.transaction_date), category:String(r.category || 'Other'), amount, grossAmount:r.gross_amount==null?null:Number(r.gross_amount), userShare:r.user_share==null?amount:Number(r.user_share), reimbursementDue:r.reimbursement_due==null?0:Number(r.reimbursement_due), shared:!!r.shared_expense, description:String(r.description||'')});
    }
  });
  return {income, expenses};
}

async function loadState(){
  if(!databaseMode || !currentUser){
    state = {income:[], expenses:[], goals:[]};
    render();
    return;
  }
  try{
    
    const baseSelect='id,transaction_date,transaction_type,category,source,description,amount,created_at';
    let result=await dbClient.from('transactions').select(baseSelect+',gross_amount,user_share,reimbursement_due,shared_expense').eq('user_id',currentUser.id).order('transaction_date',{ascending:true}).order('created_at',{ascending:true});
    if(result.error){
      splitSchemaAvailable=false;
      result=await dbClient.from('transactions').select(baseSelect).eq('user_id',currentUser.id).order('transaction_date',{ascending:true}).order('created_at',{ascending:true});
    }else{ splitSchemaAvailable=true; }
    if(result.error) throw result.error;
    state = normalizeDbRows(result.data||[]);
    render();
    await loadGoals();
    if(!splitSchemaAvailable) updateStorageStatus('Shared-expense fields are not installed in the database');
  }catch(e){
    console.error('Ledger database load failed:', e);
    updateStorageStatus('Database error');
  }
}

async function insertTransaction(entry, kind, fingerprint=null){
  if(!databaseMode || !currentUser) throw new Error('Please sign in first.');
  const baseRow = {
    id: entry.id || crypto.randomUUID(), user_id: currentUser.id, transaction_date: entry.date,
    transaction_type: kind, category: kind === 'expense' ? entry.category : null,
    source: kind === 'income' ? entry.source : null, description: entry.description || null, amount: Math.abs(Number(entry.amount)), fingerprint: fingerprint || null
  };
  if(kind === 'expense' && entry.shared && !splitSchemaAvailable){
    throw new Error('Shared expenses need the database update. Regular expenses are still available.');
  }
  const row = splitSchemaAvailable ? {...baseRow, gross_amount: kind === 'expense' && entry.shared ? Math.abs(Number(entry.grossAmount)) : null, user_share: kind === 'expense' && entry.shared ? Math.abs(Number(entry.userShare)) : null, reimbursement_due: kind === 'expense' && entry.shared ? Math.max(0, Math.abs(Number(entry.grossAmount)) - Math.abs(Number(entry.userShare))) : 0, shared_expense: kind === 'expense' ? !!entry.shared : false} : baseRow;
  let result=await dbClient.from('transactions').insert(row).select().single();
  if(result.error && /fingerprint|column .* does not exist|schema cache/i.test(result.error.message||'')){
    fingerprintAvailable=false;
    const retryRow={...row}; delete retryRow.fingerprint;
    result=await dbClient.from('transactions').insert(retryRow).select().single();
  }
  if(result.error) throw result.error;
  return result.data;
}

async function deleteTransaction(id){
  if(!databaseMode || !currentUser) throw new Error('Please sign in first.');
  const {error} = await dbClient.from('transactions').delete().eq('id', id).eq('user_id', currentUser.id);
  if(error) throw error;
}


async function updateTransaction(id, kind, entry){
  if(!databaseMode || !currentUser) throw new Error('Please sign in first.');
  const row = {transaction_date: entry.date, amount: Math.abs(Number(entry.amount))};
  if(kind === 'income') row.source = entry.source;
  else { row.category = entry.category; row.description = entry.description || null; }
  if(fingerprintAvailable) row.fingerprint = makeFingerprint(kind, entry);
  const save = r => dbClient.from('transactions').update(r).eq('id', id).eq('user_id', currentUser.id);
  let {error} = await save(row);
  if(error && row.fingerprint && /fingerprint|schema cache|column/i.test(error.message || '')){
    fingerprintAvailable = false;
    delete row.fingerprint;
    ({error} = await save(row));
  }
  if(error && (String(error.code) === '23505' || /duplicate/i.test(error.message || ''))){
    throw new Error(`You already have ${kind === 'income' ? 'income' : 'an expense'} with this date, amount and ${kind === 'income' ? 'source' : 'category'}.`);
  }
  if(error) throw error;
}

function makeFingerprint(kind, entry){
  const label = kind === 'income' ? entry.source : entry.category;
  return `${kind}|${entry.date}|${String(label||'').trim().toLowerCase()}|${Number(entry.amount).toFixed(2)}`;
}

async function addEntriesToDatabase(entries){
  if(!databaseMode || !currentUser) throw new Error('Please sign in first.');
  let added = 0, skipped = 0;
  for(const item of entries){
    const kind = item.kind;
    const entry = item.entry;
    const fingerprint = makeFingerprint(kind, entry);


    let existing=null;
    if(fingerprintAvailable){
      const check=await dbClient.from('transactions').select('id').eq('user_id',currentUser.id).eq('fingerprint',fingerprint).limit(1);
      if(check.error){
        if(/fingerprint|schema cache|column/i.test(check.error.message||'')){ fingerprintAvailable=false; }
        else throw check.error;
      }else existing=check.data;
    }
    if((!existing || !existing.length) && hasTransaction(entry,kind)){ existing=[{id:'client-match'}]; }
    if(existing && existing.length){ skipped++; continue; }

    try{
      await insertTransaction(entry, kind, fingerprint);
      added++;
    }catch(err){
      // A unique-index race is also treated as a duplicate.
      if(String(err.message || '').toLowerCase().includes('duplicate') ||
         String(err.code || '') === '23505'){
        skipped++;
      }else{
        throw err;
      }
    }
  }
  await loadState();
  return {added, skipped};
}

function requireSignedIn(){
  if(!databaseMode){
    setAuthGateMessage('Database is not configured. Add your Supabase URL and anon key in the HTML first.', 'err');
    return false;
  }
  if(!currentUser){
    setAuthGateMessage('Please sign in before adding or importing transactions.', 'err');
    return false;
  }
  return true;
}


function friendlyAuthError(error){
  const msg = String((error && error.message) || '');
  if(/invalid login credentials/i.test(msg)) return 'That email and password don’t match. Check them, or use “Forgot password?” to set a new password.';
  if(/email not confirmed/i.test(msg)) return 'Please confirm your email first: open the link we emailed you, then sign in.';
  if(/sending confirmation email|email address not authorized|sending (magic link|recovery|invite) email/i.test(msg)) return 'We couldn’t send the email for this address. Ledger’s email service isn’t fully set up yet, so please ask the app owner to finish the email setup.';
  if(/rate limit|too many requests/i.test(msg)) return 'Too many attempts in a short time. Please wait a few minutes and try again.';
  return msg || 'Something went wrong. Please try again.';
}

function setAuthGateMessage(message,kind=''){const el=document.getElementById('authGateMessage');if(!el)return;el.textContent=message||'';el.className='auth-feedback'+(kind?' '+kind:'')}
function showAuthGate(show){const gate=document.getElementById('authGate');if(!gate)return;gate.classList.toggle('hidden',!show);document.body.style.overflow=show?'hidden':''}
async function signInFromGate(){if(!databaseMode){setAuthGateMessage('Database is not configured yet.','err');return}const email=document.getElementById('gateEmail').value.trim();const password=document.getElementById('gatePassword').value;if(!email||!password){setAuthGateMessage('Enter your email and password.','err');return}setAuthGateMessage('Signing in…');document.getElementById('gateSignInBtn').disabled=true;document.getElementById('gateSignUpBtn').disabled=true;const {error}=await dbClient.auth.signInWithPassword({email,password});document.getElementById('gateSignInBtn').disabled=false;document.getElementById('gateSignUpBtn').disabled=false;if(error)setAuthGateMessage(friendlyAuthError(error),'err');else setAuthGateMessage('Signed in successfully.','ok')}
async function signUpFromGate(){
  if(!databaseMode){
    setAuthGateMessage('Database is not configured yet.', 'err');
    return;
  }

  const email = document.getElementById('gateEmail').value.trim();
  const password = document.getElementById('gatePassword').value;
  if(!email || !password){
    setAuthGateMessage('Enter an email and password to create your account.', 'err');
    return;
  }
  if(password.length < 8){
    setAuthGateMessage('Use a password with at least 8 characters.', 'err');
    return;
  }

  const signInBtn = document.getElementById('gateSignInBtn');
  const signUpBtn = document.getElementById('gateSignUpBtn');
  signInBtn.disabled = true;
  signUpBtn.disabled = true;
  setAuthGateMessage('Creating your account…');

  try{
    const {data, error} = await dbClient.auth.signUp({
      email,
      password,
      options:{ emailRedirectTo:getAuthRedirectUrl() }
    });

    if(error){
      setAuthGateMessage(friendlyAuthError(error), 'err');
      return;
    }

  
    if(data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0){
      setAuthGateMessage('An account with this email already exists. Sign in instead, or reset your password below if you’ve forgotten it.', 'err');
      document.getElementById('resetPanel').classList.add('visible');
      document.getElementById('resetEmail').value = email;
      return;
    }

    if(data.session){
      setAuthGateMessage('Account created and signed in.', 'ok');
      await handleAuthSession(data.session);
    }else{
      setAuthGateMessage('Account created ✓ Check your inbox (and spam folder) for the confirmation email, open the link, then sign in here.', 'ok');
    }
  }catch(err){
    console.error('Sign-up failed:', err);
    setAuthGateMessage('Could not create the account. Please try again.', 'err');
  }finally{
    signInBtn.disabled = false;
    signUpBtn.disabled = false;
  }
}

document.getElementById('toggleGatePassword').addEventListener('click', ()=>{
  const input = document.getElementById('gatePassword');
  const button = document.getElementById('toggleGatePassword');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.textContent = show ? 'Hide' : 'Show';
});

document.getElementById('forgotPasswordBtn').addEventListener('click', ()=>{
  const panel = document.getElementById('resetPanel');
  panel.classList.toggle('visible');
  const email = document.getElementById('gateEmail').value.trim();
  if(email) document.getElementById('resetEmail').value = email;
});

document.getElementById('sendResetBtn').addEventListener('click', async ()=>{
  if(!databaseMode) return;

  const email = document.getElementById('resetEmail').value.trim();
  const msg = document.getElementById('resetMessage');

  if(!email){
    msg.textContent = 'Enter your email address.';
    msg.className = 'auth-feedback err';
    return;
  }

  msg.textContent = 'Sending reset email…';
  msg.className = 'auth-feedback';

  try{
    const {error} = await dbClient.auth.resetPasswordForEmail(email, {
      redirectTo:getAuthRedirectUrl()
    });

    if(error){
      msg.textContent = friendlyAuthError(error);
      msg.className = 'auth-feedback err';
    }else{
      msg.textContent = 'Check your email for the password reset link.';
      msg.className = 'auth-feedback ok';
    }
  }catch(err){
    console.error(err);
    msg.textContent = 'Could not send the reset email. Please try again.';
    msg.className = 'auth-feedback err';
  }
});

document.getElementById('gateSignInBtn').addEventListener('click',signInFromGate);document.getElementById('gateSignUpBtn').addEventListener('click',signUpFromGate);['gateEmail','gatePassword'].forEach(id=>document.getElementById(id).addEventListener('keydown',e=>{if(e.key==='Enter')signInFromGate()}));
async function initDatabase(){
  if(!isDatabaseConfigured()){
    databaseMode = false;
    setAuthGateMessage('Database not configured — add your Supabase Project URL and anon/public key in the code.', 'err');
    setAppEnabled(false);
    updateStorageStatus();
    return;
  }

  try{
   
    captureJoinToken();
    const arrivedFromInvite = /(^|[#&?])type=invite(&|$)/.test(window.location.hash + window.location.search);
    dbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    databaseMode = true;

    const {data:{session}} = await dbClient.auth.getSession();
    await handleAuthSession(session);
    if(arrivedFromInvite && session){
      history.replaceState(null, '', window.location.pathname);
      showTab('intelligence');
      await handlePasswordRecovery('Welcome to Ledger! Choose a password so you can sign in next time (at least 8 characters):');
    }

    dbClient.auth.onAuthStateChange((event, session)=>{
  
      setTimeout(()=>{
        if(event === 'PASSWORD_RECOVERY'){
          handlePasswordRecovery();
        }else{
          handleAuthSession(session);
        }
      }, 0);
    });
  }catch(e){
    console.error(e);
    setAuthGateMessage('Could not initialize the database connection.', 'err');
    setAppEnabled(false);
  }
}

async function handlePasswordRecovery(promptText='Enter your new password (at least 8 characters):'){
  const newPassword = window.prompt(promptText);
  if(newPassword === null) return;

  if(newPassword.length < 8){
    alert('Password must be at least 8 characters.');
    return;
  }

  try{
    const {error} = await dbClient.auth.updateUser({password:newPassword});
    if(error){
      alert('Could not update your password: ' + error.message);
    }else{
      alert('Your password has been updated successfully.');
    }
  }catch(err){
    console.error(err);
    alert('Could not update your password. Please try again.');
  }
}

async function handleAuthSession(session){
  currentUser=session?.user||null;
  const signedIn=!!currentUser;
  showAuthGate(!signedIn);
  const ledgerTopbar = document.getElementById('ledgerTopbar');
  if(ledgerTopbar){
    ledgerTopbar.classList.toggle('visible', signedIn);
    if(signedIn){
      document.getElementById('signedInName').title=currentUser.email||'';
      refreshProfile();
    }
  }
  if(signedIn){setAuthGateMessage('');setAppEnabled(true);await loadState();await processPendingJoin()}else{setAppEnabled(false);state={income:[],expenses:[],goals:[]};goalMembers={};openSharePanel=null;render();setProfileOpen(false);if(peekPendingJoin())setAuthGateMessage('Sign in or create an account to join the shared goal you were invited to.','ok');updateStorageStatus()}}

async function logoutLedger(){
  if(!databaseMode) return;
  const {error} = await dbClient.auth.signOut({scope:'local'});
  if(error){
    setAuthGateMessage(error.message, 'err');
  }else{

    setAuthGateMessage('');
  }
}


const profileBtn = document.getElementById('profileBtn');
const profilePanel = document.getElementById('profilePanel');
function profileDisplayName(){
  const meta = (currentUser && currentUser.user_metadata) || {};
  const full = String(meta.full_name || meta.name || '').trim();
  if(full) return full;
  const local = String((currentUser && currentUser.email) || '').split('@')[0].split(/[._-]/)[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : 'Account';
}
function refreshProfile(){
  if(!currentUser) return;
  const name = profileDisplayName(), initial = name.charAt(0).toUpperCase();
  document.getElementById('signedInName').textContent = name;
  document.getElementById('profileAvatar').textContent = initial;
  document.getElementById('profileAvatarLg').textContent = initial;
  document.getElementById('profileNameText').textContent = name;
  document.getElementById('profileEmailText').textContent = currentUser.email || '';
  const nameInput = document.getElementById('profileName');
  if(document.activeElement !== nameInput) nameInput.value = name;
  const since = currentUser.created_at ? new Date(currentUser.created_at).toLocaleDateString(undefined, {month:'short', year:'numeric'}) : '';
  const tx = (state.income||[]).length + (state.expenses||[]).length;
  document.getElementById('profileStats').textContent =
    [since && `Member since ${since}`, `${tx} transaction${tx===1?'':'s'}`].filter(Boolean).join(' · ');

  
  const whole = n => (n<0?'-$':'$') + Math.round(Math.abs(n)).toLocaleString();
  const setNumber = (id, text, tone, title) => {
    const el = document.getElementById(id);
    el.textContent = text; el.className = tone; el.title = title || '';
  };
  const {year, month} = currentPeriod();
  const income = state.income.filter(e => inPeriod(e.date, year, month)).reduce((t,e)=>t+e.amount, 0);
  const expenses = state.expenses.filter(e => inPeriod(e.date, year, month));
  const left = income - expenses.reduce((t,e)=>t+e.amount, 0) - lentOutOf(expenses);
  document.getElementById('profileLeftLabel').textContent = (year === 0 || month === 0) ? 'Left overall' : 'Left this month';
  setNumber('profileLeft', whole(left), left >= 0 ? 'good' : 'warn', fmt(left));
  const goals = state.goals || [];
  const saved = goals.reduce((t,g)=>t+(Number(g.saved_amount)||0), 0);
  setNumber('profileSaved', whole(saved), saved > 0 ? 'good' : '', fmt(saved));
  const reached = goals.filter(g => g.status === 'achieved' || (Number(g.saved_amount)||0) >= (Number(g.target_amount)||0)).length;
  setNumber('profileGoals', goals.length ? `${reached} of ${goals.length}` : '0', reached ? 'good' : '');
}

function setProfileSection(id){
  document.querySelectorAll('#profilePanel .menu-item[aria-controls]').forEach(btn=>{
    const open = btn.getAttribute('aria-controls') === id;
    btn.setAttribute('aria-expanded', String(open));
    document.getElementById(btn.getAttribute('aria-controls')).hidden = !open;
  });
  const input = id && document.getElementById(id).querySelector('input');
  if(input) input.focus();
}
function setProfileOpen(open){
  profilePanel.hidden = !open;
  document.getElementById('profileBackdrop').hidden = !open;
  document.body.classList.toggle('sheet-open', open);
  profileBtn.setAttribute('aria-expanded', String(open));
  if(open){
    document.getElementById('profileStatus').textContent = '';
    refreshProfile();
    setProfileSection(null);
    document.getElementById('profileCloseBtn').focus();
  }
}
profileBtn.addEventListener('click', ()=>setProfileOpen(true));
document.getElementById('profileCloseBtn').addEventListener('click', ()=>{ setProfileOpen(false); profileBtn.focus(); });
document.getElementById('profileBackdrop').addEventListener('click', ()=>setProfileOpen(false));
document.addEventListener('keydown', e=>{
  if(e.key === 'Escape' && !profilePanel.hidden){ setProfileOpen(false); profileBtn.focus(); }
});
document.querySelectorAll('#profilePanel .menu-item[aria-controls]').forEach(btn=>btn.addEventListener('click', ()=>{
  setProfileSection(btn.getAttribute('aria-expanded') === 'true' ? null : btn.getAttribute('aria-controls'));
}));
document.getElementById('profileImportBtn').addEventListener('click', ()=>{
  setProfileOpen(false);
  showTab('budget');
  document.getElementById('smartFile').click();
});
document.getElementById('profileLogoutBtn').addEventListener('click', ()=>{ setProfileOpen(false); logoutLedger(); });
const deleteConfirm = document.getElementById('profileDeleteConfirm');
deleteConfirm.addEventListener('input', ()=>{ document.getElementById('profileDeleteBtn').disabled = deleteConfirm.value.trim() !== 'DELETE'; });
document.getElementById('profileDeleteBtn').addEventListener('click', async ()=>{
  if(!requireSignedIn() || deleteConfirm.value.trim() !== 'DELETE') return;
  const btn = document.getElementById('profileDeleteBtn'), status = document.getElementById('profileStatus');
  btn.disabled = true;
  status.textContent = 'Deleting your account…';
  const {error} = await dbClient.rpc('delete_my_account');
  if(error){
    btn.disabled = false;
    status.textContent = /delete_my_account|schema cache/i.test(error.message || '')
      ? 'Delete account needs the database update first.'
      : 'Could not delete your account: ' + error.message;
    return;
  }
  setProfileOpen(false);
  await logoutLedger();
  setAuthGateMessage('Your account and all its data were deleted.', 'ok');
});
document.getElementById('profileSaveBtn').addEventListener('click', async ()=>{
  if(!requireSignedIn()) return;
  const status = document.getElementById('profileStatus');
  const name = document.getElementById('profileName').value.trim();
  if(!name){ status.textContent = 'Enter a name.'; return; }
  const {data, error} = await dbClient.auth.updateUser({data:{full_name:name}});
  if(error){ status.textContent = 'Could not save: ' + error.message; return; }
  if(data && data.user) currentUser = data.user;
  refreshProfile();
  status.textContent = 'Name saved ✓';
});
document.getElementById('profilePasswordBtn').addEventListener('click', async ()=>{
  if(!requireSignedIn()) return;
  const status = document.getElementById('profileStatus');
  const input = document.getElementById('profileNewPassword');
  if(input.value.length < 8){ status.textContent = 'Use at least 8 characters.'; return; }
  const {error} = await dbClient.auth.updateUser({password:input.value});
  input.value = '';
  status.textContent = error ? 'Could not update password: ' + error.message : 'Password updated ✓';
});


function updateStorageStatus(message){
  const el = document.getElementById('storageStatus');
  if(!el) return;
  clearTimeout(updateStorageStatus.timer);
  if(!message){ el.hidden = true; return; }
  el.textContent = message;
  el.className = 'storage-toast' + (/failed|error|could not|unavailable|not installed/i.test(message) ? ' err' : '');
  el.hidden = false;
  updateStorageStatus.timer = setTimeout(() => { el.hidden = true; }, 3000);
}

function populateSelectors(){
  const monthSel = document.getElementById('monthSel');
  const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const allMonthOpt = document.createElement('option');
  allMonthOpt.value = 0;
  allMonthOpt.textContent = 'All months';
  monthSel.appendChild(allMonthOpt);
  months.forEach((m,i)=>{
    const opt = document.createElement('option'); opt.value = i+1; opt.textContent = m;
    monthSel.appendChild(opt);
  });
  const now = new Date();
  monthSel.value = now.getMonth()+1;

  const yearSel = document.getElementById('yearSel');
  const thisYear = now.getFullYear();
  const allYearOpt = document.createElement('option');
  allYearOpt.value = 0;
  allYearOpt.textContent = 'All years';
  yearSel.appendChild(allYearOpt);
  for(let y=thisYear-2; y<=thisYear+1; y++){
    const opt = document.createElement('option'); opt.value = y; opt.textContent = y;
    yearSel.appendChild(opt);
  }
  yearSel.value = thisYear;

  const catSel = document.getElementById('expCategory');
  CATEGORIES.forEach(([name])=>{
    const opt = document.createElement('option'); opt.value = name; opt.textContent = name;
    catSel.appendChild(opt);
  });

  const today = new Date().toISOString().slice(0,10);
  document.getElementById('incDate').value = today;
  document.getElementById('expDate').value = today;

  monthSel.addEventListener('change', render);
  yearSel.addEventListener('change', render);
  ['tgtNeed','tgtWant','tgtSave'].forEach(id=>{
    document.getElementById(id).addEventListener('input', render);
  });
}

function currentPeriod(){
  return { year: parseInt(document.getElementById('yearSel').value), month: parseInt(document.getElementById('monthSel').value) };
}
function inPeriod(dateStr, year, month){
  const d = new Date(dateStr + 'T00:00:00');
  return (year === 0 || d.getFullYear() === year) && (month === 0 || (d.getMonth()+1) === month);
}

async function loadGoals(){
  if(!databaseMode || !currentUser) return;
  try{
   
    const {data,error}=await dbClient.from('savings_goals').select('id,user_id,name,target_amount,saved_amount,target_date,status,created_at').order('target_date',{ascending:true});
    if(error) throw error;
    state.goals=data||[];
    goalMembers={};
    if(state.goals.length){
      const m=await dbClient.from('goal_members').select('goal_id,email,user_id').in('goal_id',state.goals.map(g=>g.id));
      if(!m.error) (m.data||[]).forEach(r=>{(goalMembers[r.goal_id]=goalMembers[r.goal_id]||[]).push(r);});
    }
    goalsSchemaAvailable=true;
    renderGoals();
  }catch(err){
    console.warn('Savings goals unavailable:',err.message||err);
    goalsSchemaAvailable=false; state.goals=[]; renderGoals(); document.getElementById('goalStatus').textContent='Savings goals need the database update.';
  }
}


function goalPlanText(g){
  const target = Number(g.target_amount)||0, saved = Number(g.saved_amount)||0;
  const remaining = Math.max(0, target - saved);
  if(!remaining) return 'Goal reached — nice work!';
  const today = new Date(), end = new Date(String(g.target_date) + 'T00:00:00');
  const months = Math.max(1, (end.getFullYear()-today.getFullYear())*12 + (end.getMonth()-today.getMonth()));
  const needed = remaining / months;
  const plan = `Save ${fmt(needed)}/month for ${months} month${months===1?'':'s'} to reach it.`;
  const s = advisorMonthlyStats();
  if(!s.rows.length) return plan + ' Add income and expenses so Ledger can check that against your budget.';
  if(needed <= s.avgNet) return plan + ` Your recent leftover (${fmt(s.avgNet)}/month) covers that.`;
  const gap = needed - Math.max(0, s.avgNet);
  const totals = advisorCategoryTotals(), monthsOfData = Math.max(1, s.rows.length);
  const wants = CATEGORIES.filter(([c])=>CAT_TYPE[c]==='Want')
    .map(([c])=>[c, (totals[c]||0)/monthsOfData]).filter(x=>x[1]>0).sort((a,b)=>b[1]-a[1]);
  const top = wants[0];
  if(top && top[1] >= gap){
    return plan + ` That’s ${fmt(gap)} more than your recent leftover — spending about ${Math.min(100, Math.ceil(gap/top[1]*100))}% less on ${top[0]} would cover it.`;
  }
  return plan + ` That’s ${fmt(gap)} more than your recent leftover — try a later target date or a smaller goal.`;
}

let goalMembers = {};       
let openSharePanel = null; 

function renderGoals(){
  renderBadges();
  const list=document.getElementById('goalList'); if(!list) return;
  const goals=state.goals||[];
  if(!goals.length){list.innerHTML='<div class="mini-note">No goals yet. Create your first one above.</div>';return;}
  list.innerHTML='';
  goals.forEach(g=>{
    const mine = !g.user_id || !currentUser || g.user_id === currentUser.id;
    const target=Number(g.target_amount)||0, saved=Number(g.saved_amount)||0, pct=target?Math.min(100,saved/target*100):0;
    const members = goalMembers[g.id] || [];
    const badge = !mine ? '<span class="goal-badge">Shared with you</span>'
      : members.length ? `<span class="goal-badge">Shared with ${members.length}</span>` : '';
    const sharing = openSharePanel === g.id;
    const actions = mine
      ? `<button type="button" class="btn-secondary goal-share" data-id="${g.id}" aria-expanded="${sharing}">${sharing ? 'Close sharing' : 'Share'}</button><button type="button" class="btn-secondary goal-delete" data-id="${g.id}">Delete</button>`
      : `<button type="button" class="btn-secondary goal-leave" data-id="${g.id}">Leave</button>`;
    const wrap=document.createElement('div'); wrap.className='goal-item';
    wrap.innerHTML=`<div class="goal-top"><strong>${escapeHtml(g.name)} ${badge}</strong><span>${fmt(saved)} / ${fmt(target)}</span></div>`
      + `<div class="progress"><span style="width:${pct}%"></span></div>`
      + `<div class="mini-note">${pct.toFixed(0)}% complete • Target ${escapeHtml(g.target_date)}</div>`
      + `<div class="goal-plan">${escapeHtml(goalPlanText(g))}</div>`
      + `<div class="goal-actions"><button type="button" class="btn-secondary goal-add" data-id="${g.id}">Add savings</button>${actions}</div>`
      + (mine && sharing ? sharePanelHtml(g, members) : '');
    list.appendChild(wrap);
  });

  list.querySelectorAll('.goal-add').forEach(btn=>btn.addEventListener('click',async()=>{
    if(!requireSignedIn()) return;
    const amount=parseFloat(prompt('How much did you add to this goal?','25')||'');
    if(!Number.isFinite(amount)||amount<=0) return;
   
    const {error}=await dbClient.rpc('add_to_goal',{p_goal:btn.dataset.id,p_amount:Math.round(amount*100)/100});
    if(error){alert('Could not update goal: '+error.message);return;}
    await loadGoals();
  }));
  list.querySelectorAll('.goal-delete').forEach(btn=>btn.addEventListener('click',async()=>{
    if(!requireSignedIn()) return;
    if(!confirm('Delete this savings goal? Anyone it is shared with will lose access too.'))return;
    const {error}=await dbClient.from('savings_goals').delete().eq('id',btn.dataset.id).eq('user_id',currentUser.id);
    if(error){alert('Could not delete goal: '+error.message);return;}
    if(openSharePanel===btn.dataset.id) openSharePanel=null;
    await loadGoals();
  }));
  list.querySelectorAll('.goal-leave').forEach(btn=>btn.addEventListener('click',async()=>{
    if(!requireSignedIn()) return;
    if(!confirm('Leave this shared goal? It will disappear from your list.'))return;
    const {error}=await dbClient.from('goal_members').delete().eq('goal_id',btn.dataset.id).eq('email',String(currentUser.email||'').toLowerCase());
    if(error){alert('Could not leave the goal: '+error.message);return;}
    await loadGoals();
  }));
  list.querySelectorAll('.goal-share').forEach(btn=>btn.addEventListener('click',()=>{
    openSharePanel = openSharePanel===btn.dataset.id ? null : btn.dataset.id;
    renderGoals();
  }));
  list.querySelectorAll('.share-send').forEach(btn=>btn.addEventListener('click',async()=>{
    if(!requireSignedIn()) return;
    const goalId=btn.dataset.id;
    const email=btn.closest('.share-panel').querySelector('.share-email').value.trim().toLowerCase();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ setShareStatus(goalId,'Enter a valid email address.','err'); return; }
    if(email===String(currentUser.email||'').toLowerCase()){ setShareStatus(goalId,'That’s your own email.','err'); return; }
    btn.disabled=true;
    setShareStatus(goalId,'Adding them and sending the invite…');
    const added=await dbClient.from('goal_members').insert({goal_id:goalId,email});
    if(added.error && added.error.code!=='23505'){
      btn.disabled=false;
      setShareStatus(goalId,'Could not add that person: '+added.error.message,'err');
      return;
    }
    const result=await sendGoalInvite(goalId,email);
    await loadGoals();
    setShareStatus(goalId,result.message,result.ok?'ok':'err');
  }));
  list.querySelectorAll('.share-copy').forEach(btn=>btn.addEventListener('click',async()=>{
    if(!requireSignedIn()) return;
    const goalId=btn.dataset.id;
    try{
      const link=await getInviteLink(goalId);
      const copied=await copyText(link);
      const offline=location.protocol==='file:' ? ' This link only works once Ledger is online (for example on Netlify).' : '';
      setShareStatus(goalId,(copied?'Link copied ✓ ':'')+'Anyone who opens it and signs in joins this goal.'+offline,'ok');
    }catch(err){
      setShareStatus(goalId,'Could not create a link: '+(err.message||'Unknown error'),'err');
    }
  }));
  list.querySelectorAll('.share-revoke').forEach(btn=>btn.addEventListener('click',async()=>{
    if(!requireSignedIn()) return;
    const goalId=btn.dataset.id;
    const {error}=await dbClient.from('goal_invites').update({revoked_at:new Date().toISOString()}).eq('goal_id',goalId).is('revoked_at',null);
    setShareStatus(goalId, error ? 'Could not turn off the link: '+error.message
      : 'Link turned off ✓ Old links no longer work. People who already joined keep access.', error?'err':'ok');
  }));
  list.querySelectorAll('.member-remove').forEach(btn=>btn.addEventListener('click',async()=>{
    if(!requireSignedIn()) return;
    if(!confirm(`Remove ${btn.dataset.email} from this goal?`))return;
    const {error}=await dbClient.from('goal_members').delete().eq('goal_id',btn.dataset.goal).eq('email',btn.dataset.email);
    if(error){ setShareStatus(btn.dataset.goal,'Could not remove them: '+error.message,'err'); return; }
    await loadGoals();
  }));
}

async function createGoal(e){
  e.preventDefault(); if(!requireSignedIn())return;
  if(!goalsSchemaAvailable){document.getElementById('goalStatus').textContent='Savings goals are not enabled in this database yet. Run the database setup SQL, then reload Ledger.';return;}
  const name=document.getElementById('goalName').value.trim(), target=parseFloat(document.getElementById('goalTarget').value), date=document.getElementById('goalDate').value, saved=parseFloat(document.getElementById('goalSaved').value)||0;
  if(!name||!Number.isFinite(target)||target<=0||!date||saved<0||saved>target){document.getElementById('goalStatus').textContent='Enter a valid goal, target date, and saved amount.';return;}
  const {error}=await dbClient.from('savings_goals').insert({user_id:currentUser.id,name,target_amount:target,saved_amount:saved,target_date:date,status:saved>=target?'achieved':'active'});
  if(error){document.getElementById('goalStatus').textContent='Could not create goal: '+error.message;return;}
  e.target.reset();document.getElementById('goalSaved').value='0';document.getElementById('goalStatus').textContent='Goal created ✓';await loadGoals();
}


function lentOutOf(expenses){
  return expenses.reduce((t,e)=>t + (e.shared ? Math.max(0,(Number(e.grossAmount)||0)-(Number(e.amount)||0)) : 0), 0);
}

function render(){
  const {year, month} = currentPeriod();
  const hint = document.getElementById('periodHint');
  if(hint) hint.textContent = (year === 0 || month === 0) ? 'Showing all saved transactions' : 'Showing this month';
  const incomeThis = state.income.filter(e => inPeriod(e.date, year, month));
  const expenseThis = state.expenses.filter(e => inPeriod(e.date, year, month));

  const totalIncome = incomeThis.reduce((s,e)=>s+e.amount,0);
  const byType = {Need:0, Want:0, Savings:0};
  expenseThis.forEach(e=>{ byType[CAT_TYPE[e.category]||'Want'] += e.amount; });
  const totalExpenses = byType.Need + byType.Want + byType.Savings;
  const lentOut = lentOutOf(expenseThis);
  const leftover = totalIncome - totalExpenses - lentOut;

  document.getElementById('statIncome').textContent = fmt(totalIncome);
  document.getElementById('statExpenses').textContent = fmt(byType.Need + byType.Want);
  document.getElementById('statSavings').textContent = fmt(byType.Savings);
  const leftEl = document.getElementById('lblLeftover');
  leftEl.textContent = fmt(leftover);
  leftEl.className = 'stat-val ' + (leftover>=0?'pos':'neg');
  const owedBack = expenseThis.reduce((t,e)=>t + (e.shared ? Number(e.reimbursementDue)||0 : 0), 0);
  const owedNote = document.getElementById('owedNote');
  owedNote.hidden = owedBack <= 0;
  owedNote.textContent = owedBack > 0 ? `+ ${fmt(owedBack)} owed back to you` : '';

  const tgtNeed = parseFloat(document.getElementById('tgtNeed').value)||0;
  const tgtWant = parseFloat(document.getElementById('tgtWant').value)||0;
  const tgtSave = parseFloat(document.getElementById('tgtSave').value)||0;

  const splitTotal = Math.round(tgtNeed + tgtWant + tgtSave);
  const splitNote = document.getElementById('splitNote');
  splitNote.textContent = splitTotal === 100
    ? 'Share of your income for each part. 50 / 30 / 20 is a common rule.'
    : `These add up to ${splitTotal}%. Change them so they add up to 100%.`;
  splitNote.className = 'mini-note' + (splitTotal === 100 ? '' : ' warn');

  // Donut chart: how the tracked money (Needs + Wants + Savings) actually split this month
  renderDonut([['Needs', byType.Need, 'need'], ['Wants', byType.Want, 'want'], ['Savings', byType.Savings, 'save']], totalExpenses);
  document.getElementById('donutCenterVal').textContent = totalExpenses > 0 ? fmt(totalExpenses) : '$0';

  // One-line verdict under the bars. Targets are dollar amounts from the split in "Change targets".
  const target = {Need:totalIncome*tgtNeed/100, Want:totalIncome*tgtWant/100, Savings:totalIncome*tgtSave/100};
  const overNeed = byType.Need - target.Need, overWant = byType.Want - target.Want, saveGap = target.Savings - byType.Savings;
  let rec;
  if(totalIncome === 0) rec = 'Add your income to see how your month is going.';
  else if(overWant > 0) rec = `⚠️ Wants are ${fmt(overWant)} over. Cut back on extras like dining out or shopping.`;
  else if(overNeed > 0) rec = `⚠️ Needs are ${fmt(overNeed)} over. Look for a bill you can lower.`;
  else if(saveGap > 0) rec = `💡 Spending is on track. Save ${fmt(saveGap)} more to reach your savings target.`;
  else rec = '✅ On track: spending is within your targets and savings are reached.';
  document.getElementById('recommendation').textContent = rec;
  renderTargetBars(totalIncome, byType, target);

  renderEntryList('income', incomeThis, e=>`<td>${e.date}</td><td class="td-text">${escapeHtml(e.source)}</td><td class="amt">${fmt(e.amount)}</td>`);
  renderEntryList('expense', expenseThis, e=>{
    const type = CAT_TYPE[e.category]||'Want';
    return `<td>${e.date}</td><td class="td-text">${escapeHtml(e.category)} <span class="tag ${type}">${type}</span>${sharedBadges(e)}${expenseNoteHtml(e)}</td><td class="amt">${fmt(e.amount)}</td>`;
  });

  renderGoals();
  renderCalendar(renderIncomeReminders());
  refreshForecast();

  document.querySelectorAll('.got-back').forEach(btn=>btn.addEventListener('click',()=>markPaidBack(btn.dataset.id)));
}

const LIST_PREVIEW = 4;
const listExpanded = {income:false, expense:false};
function renderEntryList(kind, entries, cellsHtml){
  const body = document.getElementById(kind + 'Body'), more = document.getElementById(kind + 'More');
  if(!entries.length){
    body.innerHTML = `<tr class="empty-row"><td colspan="4">No ${kind === 'income' ? 'income' : 'expenses'} logged for this month yet.</td></tr>`;
    more.hidden = true;
    return;
  }
  // Newest first; on the same day the most recently added entry comes first.
  const sorted = entries.slice().reverse().sort((a,b)=>b.date.localeCompare(a.date));
  const shown = listExpanded[kind] ? sorted : sorted.slice(0, LIST_PREVIEW);
  body.innerHTML = shown.map(e=>`<tr data-id="${escapeHtml(e.id)}">${cellsHtml(e)}<td class="row-actions">`
    + `<button type="button" class="row-btn edit" data-act="edit" title="Edit" aria-label="Edit this ${kind}">✎</button>`
    + `<button type="button" class="row-btn del" data-act="delete" title="Delete" aria-label="Delete this ${kind}">✕</button></td></tr>`).join('');
  const extra = sorted.length - LIST_PREVIEW;
  more.hidden = extra <= 0;
  more.textContent = listExpanded[kind] ? 'Show less' : `Show ${extra} more`;
  more.setAttribute('aria-expanded', String(listExpanded[kind]));
}


function startEdit(kind, id){
  if(!requireSignedIn()) return;
  if(document.querySelector('tr.editing')) render();
  const e = (kind === 'income' ? state.income : state.expenses).find(x=>x.id === id);
  const tr = [...document.getElementById(kind + 'Body').rows].find(r=>r.dataset.id === id);
  if(!e || !tr) return;
  const date = `<input type="date" class="edit-input date" data-field="date" value="${escapeHtml(e.date)}" aria-label="Date">`;
  const amount = `<input type="number" class="edit-input amount" data-field="amount" value="${Number(e.amount).toFixed(2)}" step="0.01" min="0.01" aria-label="Amount"${e.shared ? ' disabled title="The amount of a shared expense can’t be changed. Delete it and add it again."' : ''}>`;
  const detail = kind === 'income'
    ? `<input type="text" class="edit-input" data-field="source" value="${escapeHtml(e.source)}" maxlength="80" aria-label="Source">`
    : `<div class="edit-stack"><select class="edit-input" data-field="category" aria-label="Category">${CATEGORIES.map(([c])=>`<option${c === e.category ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select>`
      + `<input type="text" class="edit-input" data-field="description" value="${escapeHtml(e.description === 'Shared expense' ? '' : e.description)}" maxlength="80" placeholder="Store or note (optional)" aria-label="Store or note">`
      + `${e.shared ? '<span class="edit-hint">Shared expense: the amount is your share.</span>' : ''}</div>`;
  tr.className = 'editing';
  tr.innerHTML = `<td>${date}</td><td class="td-text">${detail}</td><td class="amt">${amount}</td><td class="row-actions">`
    + `<button type="button" class="row-btn save" data-act="save" title="Save" aria-label="Save changes">✓</button>`
    + `<button type="button" class="row-btn" data-act="cancel" title="Cancel" aria-label="Cancel editing">✕</button></td>`;
  tr.querySelector(kind === 'income' ? '[data-field="source"]' : '[data-field="category"]').focus();
}

async function saveEdit(kind, id, tr){
  const e = (kind === 'income' ? state.income : state.expenses).find(x=>x.id === id);
  if(!e || !requireSignedIn()) return;
  const field = name => tr.querySelector(`[data-field="${name}"]`);
  const invalid = (el, message)=>{
    el.setCustomValidity(message);
    el.reportValidity();
    el.addEventListener('input', ()=>el.setCustomValidity(''), {once:true});
  };
  const date = field('date').value, amount = e.shared ? e.amount : Math.round(parseFloat(field('amount').value) * 100) / 100;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return invalid(field('date'), 'Pick a date.');
  if(!Number.isFinite(amount) || amount <= 0) return invalid(field('amount'), 'Enter an amount above $0.');
  let next;
  if(kind === 'income'){
    const source = field('source').value.trim();
    if(!source) return invalid(field('source'), 'Enter where this income came from.');
    next = {...e, date, amount, source};
  }else{
    const note = field('description').value.trim();
    next = {...e, date, amount, category: field('category').value, description: note || (e.description === 'Shared expense' ? e.description : '')};
  }
  const controls = [...tr.querySelectorAll('input, select, button')];
  controls.forEach(el=>{ el.disabled = true; });
  try{
    await updateTransaction(id, kind, next);
    Object.assign(e, next);
    const {year, month} = currentPeriod();
    render();
    updateStorageStatus(inPeriod(date, year, month) ? 'Changes saved ✓' : `Changes saved ✓ — moved to ${longDate(date, {month:'long', year:'numeric'})}`);
  }catch(err){
    console.error(err);
    controls.forEach(el=>{ el.disabled = el.dataset.field === 'amount' && e.shared; });
    updateStorageStatus('Could not save changes');
    alert('Could not save changes: ' + (err.message || 'Unknown error'));
  }
}

async function removeEntry(kind, id, btn){
  if(!requireSignedIn()) return;
  try{
    btn.disabled = true;
    await deleteTransaction(id);
    if(kind === 'income') state.income = state.income.filter(e=>e.id !== id);
    else state.expenses = state.expenses.filter(e=>e.id !== id);
    updateStorageStatus('Deleted ✓');
    render();
  }catch(err){
    console.error(err);
    updateStorageStatus('Delete failed');
    btn.disabled = false;
    alert('Could not delete this transaction: ' + (err.message || 'Unknown error'));
  }
}

['income', 'expense'].forEach(kind=>{
  const body = document.getElementById(kind + 'Body');
  body.addEventListener('click', ev=>{
    const btn = ev.target.closest('button[data-act]');
    if(!btn) return;
    const tr = btn.closest('tr'), id = tr.dataset.id;
    if(btn.dataset.act === 'edit') startEdit(kind, id);
    else if(btn.dataset.act === 'delete') removeEntry(kind, id, btn);
    else if(btn.dataset.act === 'save') saveEdit(kind, id, tr);
    else if(btn.dataset.act === 'cancel') render();
  });
  body.addEventListener('keydown', ev=>{
    const tr = ev.target.closest('tr.editing');
    if(!tr) return;
    if(ev.key === 'Escape'){ ev.preventDefault(); render(); }
    else if(ev.key === 'Enter' && ev.target.tagName === 'INPUT'){ ev.preventDefault(); saveEdit(kind, tr.dataset.id, tr); }
  });
  document.getElementById(kind + 'More').addEventListener('click', ()=>{
    listExpanded[kind] = !listExpanded[kind];
    render();
  });
});

// Store name / note under an expense (receipt store, bank description, or typed note).
function expenseNoteHtml(e){
  const note = String(e.description || '');
  if(!note || note === 'Shared expense') return '';
  return `<div class="row-note">${escapeHtml(note)}</div>`;
}

// Row badges for shared expenses: what's still owed, plus a "Got it back" button.
function sharedBadges(e){
  if(!e.shared) return '';
  const due = Number(e.reimbursementDue)||0;
  const shareOf = `<span class="tag Shared">Your share of ${fmt(Number(e.grossAmount)||0)}</span>`;
  return '<div class="row-badges">' + shareOf + (due > 0
    ? `<span class="tag Owed">Owed ${fmt(due)}</span><button type="button" class="got-back" data-id="${e.id}">Got it back</button>`
    : '<span class="tag Paid">Paid back</span>') + '</div>';
}


async function markPaidBack(expenseId){
  if(!requireSignedIn()) return;
  const exp = state.expenses.find(e=>e.id===expenseId);
  if(!exp || !exp.shared) return;
  const due = Number(exp.reimbursementDue)||0;
  if(due <= 0) return;

  const answer = prompt(`How much did you get back? (Still owed: ${fmt(due)})`, due.toFixed(2));
  if(answer === null) return;
  const amount = Math.round(parseFloat(answer)*100)/100;
  if(!Number.isFinite(amount) || amount <= 0 || amount > due){
    alert(`Enter an amount between $0.01 and ${fmt(due)}.`);
    return;
  }

  const today = new Date().toISOString().slice(0,10);
  const income = {id:crypto.randomUUID(), date:today, source:`Paid back · ${exp.category}`, amount, description:`reimbursement:${exp.id}`};
  try{
    // Fingerprint includes both ids so repeated partial repayments never collide.
    await insertTransaction(income, 'income', `income|reimbursement|${exp.id}|${income.id}`);
  }catch(err){
    alert('Could not record the repayment: ' + (err.message || 'Unknown error'));
    return;
  }

  const remaining = Math.round((due - amount)*100)/100;
  const {error} = await dbClient.from('transactions').update({reimbursement_due: remaining}).eq('id', exp.id).eq('user_id', currentUser.id);
  if(error){
 
    await deleteTransaction(income.id).catch(()=>{});
    alert('Could not update the shared expense: ' + error.message);
    return;
  }

  state.income.push(income);
  exp.reimbursementDue = remaining;
  jumpToDate(today);
  render();
  updateStorageStatus(remaining > 0 ? `Got ${fmt(amount)} back ✓ — ${fmt(remaining)} still owed` : `Got ${fmt(amount)} back ✓ — fully paid back`);
}

function transactionKey(r, kind){
  if(kind === 'income') return `I|${r.date}|${String(r.source).trim().toLowerCase()}|${Number(r.amount).toFixed(2)}`;
  return `E|${r.date}|${String(r.category).trim().toLowerCase()}|${Number(r.amount).toFixed(2)}`;
}
function hasTransaction(r, kind){
  const list = kind === 'income' ? state.income : state.expenses;
  const key = transactionKey(r, kind);
  return list.some(x => transactionKey(x, kind) === key);
}


function jumpToDate(dateStr){
  const monthSel = document.getElementById('monthSel');
  const yearSel = document.getElementById('yearSel');
  if(monthSel.value === '0' || yearSel.value === '0') return;
  const d = new Date(dateStr + 'T00:00:00');
  const y = d.getFullYear(), m = d.getMonth()+1;
  if(![...yearSel.options].some(o => parseInt(o.value) === y)){
    const opt = document.createElement('option'); opt.value = y; opt.textContent = y;
    yearSel.appendChild(opt);
    yearSel.innerHTML = [...yearSel.options].sort((a,b)=>a.value-b.value)
      .map(o=>`<option value="${o.value}">${o.textContent}</option>`).join('');
  }
  yearSel.value = y;
  document.getElementById('monthSel').value = m;
}

document.getElementById('incomeForm').addEventListener('submit', async e=>{
  e.preventDefault();
  if(!requireSignedIn()) return;

  const date = document.getElementById('incDate').value;
  const source = document.getElementById('incSource').value.trim();
  const amount = parseFloat(document.getElementById('incAmount').value);
  if(!date || !source || !Number.isFinite(amount) || amount <= 0){
    updateStorageStatus('Enter date, source, and a valid amount');
    return;
  }

  const entry = {id:crypto.randomUUID(), date, source, amount};
  if(hasTransaction(entry, 'income')){
    updateStorageStatus('That income entry already exists');
    return;
  }

  try{
    await insertTransaction(entry, 'income', makeFingerprint('income', entry));
    state.income.push(entry);
    jumpToDate(date);
    render();
    updateStorageStatus('Income saved ✓');
    e.target.reset();
    document.getElementById('incDate').value = new Date().toISOString().slice(0,10);
  }catch(err){
    console.error(err);
    updateStorageStatus('Could not save income');
    alert('Could not save income: ' + (err.message || 'Unknown error'));
  }
});

document.getElementById('expenseForm').addEventListener('submit', async e=>{
  e.preventDefault();
  if(!requireSignedIn()) return;

  const date = document.getElementById('expDate').value;
  const category = document.getElementById('expCategory').value;
  const note = document.getElementById('expNote').value.trim();
  const shared = !document.getElementById('sharedFields').hidden;
  let entry;

  if(shared){
    
    const gross = parseFloat(document.getElementById('expTotal').value);
    const share = parseFloat(document.getElementById('expShare').value);
    if(!date || !category || !Number.isFinite(gross) || !Number.isFinite(share) || gross <= 0 || share <= 0 || share > gross){
      setSharedHint('Enter the total amount, and a share no bigger than the total.', 'err');
      return;
    }
    if(!splitSchemaAvailable){
      setSharedHint('Shared expenses need the database update. Regular expenses still work.', 'err');
      return;
    }
    entry = {id:crypto.randomUUID(), date, category, amount:share, grossAmount:gross, userShare:share, reimbursementDue:Math.round((gross-share)*100)/100, shared:true, description:note||'Shared expense'};
  }else{
    const amount = parseFloat(document.getElementById('expAmount').value);
    if(!date || !category || !Number.isFinite(amount) || amount <= 0){
      updateStorageStatus('Enter date, category, and a valid amount');
      return;
    }
    entry = {id:crypto.randomUUID(), date, category, amount, description:note||null};
  }

  if(hasTransaction(entry, 'expense')){
    updateStorageStatus('That expense entry already exists');
    return;
  }

  try{
    await insertTransaction(entry, 'expense', makeFingerprint('expense', entry));
    state.expenses.push(entry);
    jumpToDate(date);
    render();
    updateStorageStatus(shared ? `Shared expense saved ✓ — ${fmt(entry.grossAmount - entry.userShare)} owed back to you` : 'Expense saved ✓');
    document.getElementById('expDate').value = new Date().toISOString().slice(0,10);
    ['expAmount','expTotal','expShare','expNote'].forEach(id=>{ document.getElementById(id).value=''; });
    if(shared) setSharedHint('Tap “Got it back” in the list when you’re repaid.');
  }catch(err){
    console.error(err);
    updateStorageStatus('Could not save expense');
    alert('Could not save expense: ' + (err.message || 'Unknown error'));
  }
});


const sharedToggle = document.getElementById('sharedToggle');
const sharedFields = document.getElementById('sharedFields');
const expAmountInput = document.getElementById('expAmount');
function setSharedHint(message, kind=''){
  const el = document.getElementById('sharedHint');
  el.textContent = message;
  el.className = 'shared-hint' + (kind ? ' ' + kind : '');
}
sharedToggle.addEventListener('click', ()=>{
  const on = sharedFields.hidden;
  sharedFields.hidden = !on;
  sharedToggle.setAttribute('aria-expanded', String(on));
  sharedToggle.textContent = on ? '− Shared' : '＋ Shared';
  expAmountInput.hidden = on;
  expAmountInput.required = !on;
  if(on) document.getElementById('expTotal').focus();
});
['expTotal','expShare'].forEach(id=>document.getElementById(id).addEventListener('input', ()=>{
  const gross = parseFloat(document.getElementById('expTotal').value);
  const share = parseFloat(document.getElementById('expShare').value);
  if(!Number.isFinite(gross) || !Number.isFinite(share)) return setSharedHint('Tap “Got it back” in the list when you’re repaid.');
  if(share > gross) return setSharedHint('Your share can’t be more than the total.', 'err');
  setSharedHint(`Your share: ${fmt(share)} · owed back to you: ${fmt(gross - share)}`);
}));

document.getElementById('goalForm').addEventListener('submit',createGoal);
function setDefaultGoalDates(){
  const d=new Date().toISOString().slice(0,10); ['goalDate'].forEach(id=>{const el=document.getElementById(id);if(el&&!el.value)el.value=d;});
}
setDefaultGoalDates();


class LedgerAssistant {
  constructor(){
    this.messagesEl=document.getElementById('chatMessages');
    this.inputEl=document.getElementById('chatInput');
  }
  start(){
    this.messagesEl.innerHTML='';
    this.addMessage('bot','Hi! I\'m your Ledger Financial Copilot. Ask me about spending, saving, goals, forecasts, or whether a purchase fits your current cash flow.');
    this.addMessage('bot','I use the data Ledger currently has and clearly label estimates.');
    this.inputEl.disabled=false;
    this.inputEl.value='';
  }
  handle(raw){
    const text=String(raw??'').trim();
    if(!text) return;
    this.addMessage('user',text);
    this.addMessage('bot',copilotAnswer(text));
  }
  addMessage(who,text){
    const wrap=document.createElement('div'); wrap.className='chat-msg '+who;
    const bubble=document.createElement('div'); bubble.className='chat-bubble'; bubble.textContent=text;
    wrap.appendChild(bubble); this.messagesEl.appendChild(wrap); this.messagesEl.scrollTop=this.messagesEl.scrollHeight;
  }
}

let ledgerChatbot=null;
function initLedgerChatbot(){
  ledgerChatbot=new LedgerAssistant();
  document.getElementById('chatSendBtn').addEventListener('click',()=>{
    const value=ledgerChatbot.inputEl.value.trim();
    if(!value || ledgerChatbot.inputEl.disabled) return;
    ledgerChatbot.inputEl.value='';
    ledgerChatbot.handle(value);
  });
  ledgerChatbot.inputEl.addEventListener('keydown',e=>{
    if(e.key==='Enter') document.getElementById('chatSendBtn').click();
  });
  document.getElementById('chatResetBtn').addEventListener('click',()=>ledgerChatbot.start());
  ledgerChatbot.start();
}


function csvEscape(value){
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCsv(){
  const rows = [['SECTION','Date','Source or Category','Amount','Type']];
  state.income.forEach(e => rows.push(['Income', e.date, e.source, Number(e.amount).toFixed(2), '']));
  state.expenses.forEach(e => rows.push(['Expense', e.date, e.category, Number(e.amount).toFixed(2), CAT_TYPE[e.category] || 'Want']));
  return rows.map(row => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

function downloadBlob(content, filename, type){
  const blob = new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById('exportBtn').addEventListener('click', ()=>{
  if(!requireSignedIn()) return;
  downloadBlob(buildCsv(), 'ledger-export.csv', 'text/csv;charset=utf-8');
});


document.getElementById('exportPdfBtn').addEventListener('click', ()=>{
  if(!requireSignedIn()) return;
  const {year, month} = currentPeriod();
  const byDate = (a,b)=>a.date.localeCompare(b.date);
  const inc = state.income.filter(e=>inPeriod(e.date, year, month)).sort(byDate);
  const exp = state.expenses.filter(e=>inPeriod(e.date, year, month)).sort(byDate);
  const monthName = month ? document.getElementById('monthSel').selectedOptions[0].textContent : 'All months';
  const period = `${monthName} ${year || '(all years)'}`;
  const sum = arr => arr.reduce((t,e)=>t + (Number(e.amount)||0), 0);
  const savings = exp.filter(e=>CAT_TYPE[e.category]==='Savings');
  const spending = exp.filter(e=>CAT_TYPE[e.category]!=='Savings');
  const lent = exp.reduce((t,e)=>t + (e.shared ? Math.max(0,(Number(e.grossAmount)||0)-(Number(e.amount)||0)) : 0), 0);
  const rows = (arr, label) => arr.map(e=>`<tr><td>${e.date}</td><td>${escapeHtml(label(e))}</td><td class="r">${fmt(e.amount)}</td></tr>`).join('')
    || '<tr><td colspan="3" class="empty">None recorded</td></tr>';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Ledger — ${escapeHtml(period)}</title><style>
    body{font-family:Helvetica,Arial,sans-serif;color:#2E2A24;margin:32px}
    h1{margin:0 0 4px;font-size:24px}.sub{color:#736C5F;margin:0 0 20px}
    .sum{display:flex;gap:10px;margin-bottom:20px}.sum div{flex:1;border:1px solid #E6DDC6;border-radius:8px;padding:10px 12px;font-size:12px;color:#736C5F}
    .sum b{display:block;font-size:16px;color:#2E2A24;margin-top:3px}
    h2{font-size:15px;margin:22px 0 6px}table{width:100%;border-collapse:collapse;font-size:12px}
    th,td{text-align:left;padding:6px 4px;border-bottom:1px solid #E6DDC6}.r{text-align:right}.empty{color:#999;font-style:italic}
  </style></head><body>
    <h1>Ledger report</h1><p class="sub">${escapeHtml(period)} · generated ${new Date().toLocaleDateString()}</p>
    <div class="sum"><div>Income<b>${fmt(sum(inc))}</b></div><div>Expenses<b>${fmt(sum(spending))}</b></div><div>Savings<b>${fmt(sum(savings))}</b></div><div>Left in account<b>${fmt(sum(inc)-sum(exp)-lent)}</b></div></div>
    <h2>Income</h2><table><thead><tr><th>Date</th><th>Source</th><th class="r">Amount</th></tr></thead><tbody>${rows(inc, e=>e.source)}</tbody></table>
    <h2>Expenses</h2><table><thead><tr><th>Date</th><th>Category</th><th class="r">Amount</th></tr></thead><tbody>${rows(exp, e=>e.category + (e.shared ? ` (your share of ${fmt(e.grossAmount)})` : ''))}</tbody></table>
  </body></html>`;
  const frame = document.createElement('iframe');
  frame.id = 'ledgerPrintFrame';
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  frame.contentDocument.open();
  frame.contentDocument.write(html);
  frame.contentDocument.close();
  setTimeout(()=>{
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(()=>frame.remove(), 1000);
  }, 250);
});


const INCOME_DOC_WORDS = /\b(net\s*pay|gross\s*pay|pay\s*(?:stub|slip|statement|period|date|cheque|check)|earnings|salary|wages?|payroll|direct\s*deposit|deposited|you(?:'ve)?\s*received|payment\s*received|money\s*received|received\s*from|funds\s*(?:received|deposited)|refund(?:ed)?|reimburse(?:ment|d)?|cash\s*back|remittance|invoice\s*paid|paid\s*to\s*you)\b/gi;
const EXPENSE_DOC_WORDS = /\b(receipt|sub\s*-?\s*total|total\s*due|amount\s*due|balance\s*due|hst|gst|pst|vat|sales\s*tax|cashier|change\s*due|visa|master\s*card|amex|debit\s*card|purchase|you\s*paid|you\s*sent|sent\s*to|order\s*(?:total|summary)|billing|thank\s*you\s*for\s*shopping)\b/gi;
const DOC_MONEY = /\$?\s?(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\b/g;

function classifyDocument(text){
  const votes = re => (text.match(re) || []).length;
  return votes(INCOME_DOC_WORDS) > votes(EXPENSE_DOC_WORDS) ? 'Income' : 'Expense';
}

function amountsIn(line){
  return [...line.matchAll(DOC_MONEY)].map(m=>parseFloat(m[1].replace(/,/g, '') + '.' + m[2])).filter(v=>v > 0);
}


function incomeDocAmount(lines){
  const labels = [/\bnet\s*(pay|amount|deposit)\b/i, /\b(amount|total)\s*(received|deposited|refunded|paid)\b/i, /\b(deposit|refund|reimbursement|amount|total)\b/i];
  for(const re of labels){
    for(let i = 0; i < lines.length; i++){
      if(!re.test(lines[i])) continue;
      const found = amountsIn(lines[i]).concat(amountsIn(lines[i + 1] || ''));
      if(found.length) return found[0];
    }
  }
  return null;
}


function incomeDocSource(text, lines){
  const store = receiptStoreName(lines);
  const m = text.match(/\b(?:received\s+from|deposit\s+from|paid\s+by|from|employer|sender)\s*:?\s+([^\n]{2,60})/i);
  if(m){
    const words = [];
    for(const w of m[1].trim().split(/\s+/)){
      if(words.length === 4 || !/^[A-Z0-9&][\w&'.\-]*$/.test(w)) break;
      words.push(w);
    }
    const name = words.join(' ');
    if(name.length >= 2 && !/^\d/.test(name) && !/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(name)) return name;
  }
  if(/\b(net\s*pay|pay\s*(stub|slip)|payroll|salary|wages?)\b/i.test(text)) return store ? `Paycheck · ${store}` : 'Paycheck';
  if(/\brefund/i.test(text)) return store ? `Refund · ${store}` : 'Refund';
  return store || 'Income';
}


function wordDate(text){
  const monthFirst = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  const dayFirst = text.match(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+(20\d{2})\b/i);
  if(monthFirst) return toIsoDate(`${monthFirst[1]} ${monthFirst[2]}, ${monthFirst[3]}`);
  if(dayFirst) return toIsoDate(`${dayFirst[2]} ${dayFirst[1]}, ${dayFirst[3]}`);
  return null;
}


function incomeDocDate(lines){
  const i = lines.findIndex(l=>/\b(pay|deposit|payment|transfer)\s*date\b|\bdate\s*(paid|deposited|received)\b/i.test(l));
  if(i < 0) return null;
  const near = lines[i] + '\n' + (lines[i + 1] || '');
  return parseReceiptOcr(near).date || wordDate(near);
}

function analyzeDocumentText(text){
  if(!text.trim()) return {kind:'unreadable', reason:'no text could be read from it. Try a sharper, well-lit photo.'};
  const statementRows = parseBankPdfText(text);
  if(statementRows.length >= 3) return {kind:'statement', rows:statementRows};
  const lines = text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const receipt = parseReceiptOcr(text);
  const type = classifyDocument(text);
  const date = (type === 'Income' && incomeDocDate(lines)) || receipt.date || wordDate(text) || calToday();
  const amount = type === 'Income' ? (incomeDocAmount(lines) ?? receipt.amount) : receipt.amount;
  if(!(amount > 0) && statementRows.length) return {kind:'statement', rows:statementRows};
  if(type === 'Income') return {kind:'single', type, amount, date, source:incomeDocSource(text, lines)};

  const guessed = guessCategory(text);
  const category = receipt.category === 'Groceries' && guessed !== 'Other' ? guessed : receipt.category;
  return {kind:'single', type, amount, date, category, store:receipt.store, receipt};
}

async function ocrText(source, statusEl, label){
  if(typeof Tesseract === 'undefined') throw new Error('the text reader did not load. Check your connection and try again.');
  const result = await Tesseract.recognize(source, 'eng', {
    logger: info => {
      if(info.status === 'recognizing text' && typeof info.progress === 'number') statusEl.textContent = `Reading ${label}… ${Math.round(info.progress * 100)}%`;
    }
  });
  return result.data.text || '';
}


async function ocrPdfPages(bytes, statusEl, label, maxPages = 3){
  const pdfjsLib = await getPdfJs();
  const pdf = await pdfjsLib.getDocument({data: bytes.slice(0)}).promise;
  const texts = [];
  for(let n = 1; n <= Math.min(pdf.numPages, maxPages); n++){
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({scale: 2});
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({canvasContext: canvas.getContext('2d'), viewport}).promise;
    texts.push(await ocrText(canvas, statusEl, pdf.numPages > 1 ? `${label}, page ${n}` : label));
  }
  return texts.join('\n');
}

async function readUpload(file, statusEl, label){
  const name = file.name || '';
  if(/\.csv$/i.test(name) || /csv|vnd\.ms-excel/i.test(file.type || '')){
    statusEl.textContent = `Reading ${label}…`;
    const rows = parseBankCsv(await file.text());
    return rows.length ? {kind:'statement', rows}
      : {kind:'unreadable', reason:'no transactions found. Ledger reads bank exports (a date column plus an amount, or withdrawal and deposit columns) and budget sheets with months across the top.'};
  }
  if(/\.pdf$/i.test(name) || file.type === 'application/pdf'){
    statusEl.textContent = `Opening ${label}…`;
    
    const bytes = new Uint8Array(await file.arrayBuffer());
    if(!bytes.length) return {kind:'unreadable', reason:'the browser could not read this file. If it is in OneDrive or still downloading, save a local copy and upload that.'};
    const lines = await extractPdfLines(bytes, statusEl);
    if(lines.some(l=>l.text)){
      const card = parseCardStatement(lines);
      if(card){
        const note = card.payments ? `Left out ${card.payments} payment${card.payments === 1 ? '' : 's'} to the card: that's money moved from your bank, not spending.` : '';
        return card.rows.length ? {kind:'statement', rows:card.rows, note}
          : {kind:'unreadable', reason:'this credit card statement has no purchases, interest or refunds to add.'};
      }
      const rows = parseBankStatement(lines);
      if(rows.length >= 3) return {kind:'statement', rows};
      return analyzeDocumentText(lines.map(l=>l.text).join('\n'));
    }
    return analyzeDocumentText(await ocrPdfPages(bytes, statusEl, label));
  }
  if(/^image\//.test(file.type || '') || /\.(jpe?g|png|webp|bmp|gif)$/i.test(name)){
    return analyzeDocumentText(await ocrText(file, statusEl, label));
  }
  return {kind:'unreadable', reason:'upload a photo, PDF or CSV file.'};
}

function setImportStatus(kind, html){
  const el = document.getElementById('pdfBankStatus');
  el.className = 'inline-import-status' + (kind ? ' ' + kind : '');
  el.innerHTML = html;
  return el;
}


function prefillEntryForm(doc){
  if(doc.type === 'Income'){
    document.getElementById('incDate').value = doc.date;
    document.getElementById('incSource').value = doc.source || '';
  }else{
    if(!document.getElementById('sharedFields').hidden) document.getElementById('sharedToggle').click();
    document.getElementById('expDate').value = doc.date;
    if(doc.category) document.getElementById('expCategory').value = doc.category;
    document.getElementById('expNote').value = doc.store || '';
  }
}

async function handleUploads(fileList){
  const files = [...fileList];
  if(!files.length || handleUploads.busy || !requireSignedIn()) return;
  handleUploads.busy = true;
  const zone = document.getElementById('uploadZone');
  zone.classList.add('busy');
  const statusEl = setImportStatus('', 'Starting…');
  statusEl.scrollIntoView({block:'center', behavior:'smooth'});
  const statementRows = [], docs = [], problems = [], notes = [];
  try{
    for(const [i, file] of files.entries()){
      const label = files.length > 1 ? `${file.name} (${i + 1} of ${files.length})` : file.name;
      try{
        const result = await readUpload(file, statusEl, label);
        if(result.kind === 'statement'){
          statementRows.push(...result.rows);
          if(result.note) notes.push(escapeHtml(result.note));
        }
        else if(result.kind === 'single') docs.push({name: file.name, ...result});
        else problems.push(`${escapeHtml(file.name)}: ${escapeHtml(result.reason)}`);
      }catch(err){
        console.error('Upload failed:', file.name, err);
        problems.push(`${escapeHtml(file.name)}: ${escapeHtml(err.message || 'it could not be read.')}`);
      }
    }
    docs.filter(d=>!(d.amount > 0)).forEach(d=>{
      const income = d.type === 'Income';
      problems.push(`${escapeHtml(d.name)}: looks like ${income ? 'income' : 'an expense'}, but the amount wasn't clear. The ${income ? 'Income' : 'Expenses'} form below is filled in; add the amount and click Add.`);
      prefillEntryForm(d);
    });
    const entries = docs.filter(d=>d.amount > 0).map(d=>d.type === 'Income'
      ? {doc:d, kind:'income', entry:{id:crypto.randomUUID(), date:d.date, source:d.source, amount:d.amount}}
      : {doc:d, kind:'expense', entry:{id:crypto.randomUUID(), date:d.date, category:d.category, amount:d.amount, description:d.store || 'Receipt'}});
    let added = [], skipped = 0;
    if(entries.length){
      statusEl.textContent = 'Adding to your ledger…';
      try{
        skipped = (await addEntriesToDatabase(entries)).skipped;
        added = entries.filter(x=>(x.kind === 'income' ? state.income : state.expenses).some(e=>e.id === x.entry.id));
        if(added.length){ jumpToDate(added[added.length - 1].entry.date); render(); }
      }catch(err){
        console.error(err);
        problems.push(`Could not save to your ledger: ${escapeHtml(err.message || 'Unknown error')}`);
      }
    }
    showUploadResult(added, skipped, statementRows, problems, notes);
  }finally{
    handleUploads.busy = false;
    zone.classList.remove('busy');
  }
}

function showUploadResult(added, skipped, statementRows, problems, notes = []){
  const parts = [];
  if(added.length){
    const describe = ({kind, entry})=>(kind === 'income'
      ? `income of <strong>${fmt(entry.amount)}</strong> from ${escapeHtml(entry.source)}`
      : `an expense of <strong>${fmt(entry.amount)}</strong> (${escapeHtml(entry.category)}${entry.description && entry.description !== 'Receipt' ? ', ' + escapeHtml(entry.description) : ''})`)
      + ` on ${longDate(entry.date, {month:'short', day:'numeric', year:'numeric'})}`;
    parts.push(`✓ Added ${added.map(describe).join('; ')}. If something is wrong, tap ✎ on the row to fix the amount or category, or undo.`);
  }
  if(skipped) parts.push(`Skipped ${skipped} already in your ledger.`);
  if(statementRows.length){
    const income = statementRows.filter(r=>r.type === 'Income').length, expenses = statementRows.length - income;
    parts.push(`Found ${statementRows.length} statement row${statementRows.length === 1 ? '' : 's'}: ${income} income, ${expenses} expense${expenses === 1 ? '' : 's'}. Check them below, then add them.`);
  }
  parts.push(...notes);
  const receipt = added.length === 1 && added[0].kind === 'expense' && added[0].doc.receipt && added[0].doc.receipt.items.length >= 2 ? added[0] : null;
  const buttons = (added.length ? '<button type="button" class="btn-secondary" data-upload="undo">Undo</button>' : '')
    + (receipt ? `<button type="button" class="btn-secondary" data-upload="split">Split its ${receipt.doc.receipt.items.length} items by category</button>` : '');
  const statusEl = setImportStatus(parts.length ? 'ok' : 'err',
    parts.map(p=>`<div>${p}</div>`).join('') + problems.map(p=>`<div class="import-problem">${p}</div>`).join('')
    + (buttons ? `<div class="import-actions">${buttons}</div>` : ''));
  const undo = statusEl.querySelector('[data-upload="undo"]');
  if(undo) undo.addEventListener('click', ()=>undoUpload(added.map(x=>x.entry.id), undo));
  const split = statusEl.querySelector('[data-upload="split"]');
  if(split) split.addEventListener('click', ()=>{
    renderReceiptReview(receipt.doc.receipt, receipt.entry.date);
    receiptReview.replaceId = receipt.entry.id;
    document.getElementById('receiptReviewWrap').scrollIntoView({block:'start', behavior:'smooth'});
  });
  if(statementRows.length){
    renderBankPreview(statementRows);
    document.getElementById('bankPreviewWrap').scrollIntoView({block:'start', behavior:'smooth'});
  }else statusEl.scrollIntoView({block:'center', behavior:'smooth'});
}

async function undoUpload(ids, btn){
  if(!requireSignedIn()) return;
  btn.disabled = true;
  try{
    for(const id of ids) await deleteTransaction(id);
    await loadState();
    setImportStatus('', 'Undone. Nothing from that upload is in your ledger.');
  }catch(err){
    console.error(err);
    await loadState();
    setImportStatus('err', 'Could not undo: ' + escapeHtml(err.message || 'Unknown error'));
  }
}

const uploadZone = document.getElementById('uploadZone');

document.getElementById('smartFile').addEventListener('change', async e=>{
  try{ await handleUploads([...e.target.files]); }
  finally{ e.target.value = ''; }
});
uploadZone.addEventListener('keydown', e=>{
  if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); document.getElementById('smartFile').click(); }
});
['dragenter', 'dragover'].forEach(type=>uploadZone.addEventListener(type, e=>{ e.preventDefault(); uploadZone.classList.add('drag'); }));
['dragleave', 'drop'].forEach(type=>uploadZone.addEventListener(type, ()=>uploadZone.classList.remove('drag')));
uploadZone.addEventListener('drop', e=>{
  e.preventDefault();
  if(!document.getElementById('smartFile').disabled) handleUploads(e.dataTransfer.files);
});


const RECEIPT_ITEM_KEYWORDS = [
  ['Groceries', /\b(milk|bread|egg|cheese|butter|yog|banana|apple|orange|grape|berr|lettuce|tomato|potato|onion|carrot|chicken|beef|pork|fish|salmon|rice|pasta|flour|sugar|cereal|juice|coffee|tea\b|water|soda|chips|snack|cookie|cracker|fruit|veg|produce|meat|deli|bakery|frozen|grocer|sauce|soup|bean|nuts?\b|chocolate|candy|avocado|lemon|lime|pepper|cucumber|spinach|broccoli|cream|oats)/i],
  ['Personal Care', /\b(shampoo|conditioner|soap|body\s*wash|lotion|deodorant|toothpaste|toothbrush|floss|razor|makeup|cosmetic|nail|hair|skin|sunscreen|tissue|cotton|mouthwash)/i],
  ['Health & Medical', /\b(pharm|rx\b|prescription|vitamin|tylenol|advil|ibuprofen|acetaminophen|aspirin|allergy|cough|cold\s*med|bandage|band-aid|first\s*aid|medicine|supplement|antacid)/i],
  ['Childcare', /\b(diaper|wipes|formula|baby)/i],
  ['Dining Out', /\b(burger|pizza|sandwich|fries|combo|meal|latte|cappuccino|espresso|donut|muffin|bagel|wrap|taco|burrito|sushi|noodle|entree|appetizer|dessert|tip\b|gratuity)/i],
  ['Transportation', /\b(gas\b|fuel|diesel|unleaded|car\s*wash|parking|oil\s*change|transit|fare)/i],
  ['Entertainment', /\b(movie|ticket|game|streaming|concert|toy)/i],
  ['Shopping', /\b(shirt|pants|jeans|dress|sock|shoe|jacket|cloth|book|cable|charger|batter|headphone|phone\s*case|electronic|kitchen|towel|pillow|decor|gift|stationery|pen\b|notebook|bag\b|detergent|paper\s*towel|cleaner)/i],
];
// Lines that are totals, taxes, payment details or promotions, never items.
const RECEIPT_SKIP_LINE = /\b(sub\s*-?\s*total|total|tax|gst|hst|pst|qst|vat|change|cash|tender|visa|master\s*card|amex|debit|credit|card|balance|amount\s*due|payment|approved|auth|ref\b|terminal|saving|discount|coupon|you\s*saved|points|reward|loyalty|thank|items?\s*sold|qty|quantity)\b/i;

function guessItemCategory(name, fallback){
  for(const [category, re] of RECEIPT_ITEM_KEYWORDS){ if(re.test(name)) return category; }
  return fallback;
}


function receiptStoreName(lines){
  for(const raw of lines.slice(0, 6)){
    const line = raw.replace(/[^A-Za-z0-9&'.\- ]/g, ' ').replace(/\s+/g, ' ').trim();
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    if(line.length < 3 || letters < 3 || letters / line.length < 0.6) continue;
    if(/\b(receipt|invoice|welcome|tel|phone|www|http|store\s*#|st|street|ave|avenue|rd|road|blvd|suite|unit|date|time|cashier|order)\b/i.test(line)) continue;
    if(/\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/.test(raw)) continue;
    return line.split(' ')
      .map(w=>w.length > 1 && /[A-Z]/.test(w) && w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w)
      .join(' ').slice(0, 60);
  }
  return '';
}


function parseReceiptOcr(text){
  const lines = text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const joined = lines.join(' ');

  let date = null;
  for(const re of [/\b(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})\b/, /\b(\d{1,2})[-\/](\d{1,2})[-\/](20\d{2})\b/, /\b(\d{1,2})[-\/](\d{1,2})[-\/](\d{2})\b/]){
    const m = joined.match(re);
    if(!m) continue;
    let y, mo, d;
    if(m[1].length === 4){ y=+m[1]; mo=+m[2]; d=+m[3]; }
    else { mo=+m[1]; d=+m[2]; y=+m[3]; if(y < 100) y += 2000; }
    if(mo>=1 && mo<=12 && d>=1 && d<=31){ date = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`; break; }
  }


  const priceOf = line => {
    const all = [...line.matchAll(/(\d{1,5}(?:,\d{3})*\.\d{2})/g)];
    return all.length ? {value: parseFloat(all[all.length-1][1].replace(/,/g,'')), firstIndex: all[0].index} : null;
  };
  const priced = lines.map(line=>({line, price: priceOf(line)})).filter(x=>x.price);

 
  const isTotalLine = line => /\b(grand\s*total|total\s*due|amount\s*due|balance\s*due|total)\b/i.test(line)
    && !/\b(sub\s*-?\s*total|total\s*(tax|savings?|discount|items?|qty|quantity|points)|tax\s*total)\b/i.test(line);
  const totals = priced.filter(x=>isTotalLine(x.line));
  let amount = null;
  if(totals.length) amount = Math.max(...totals.map(x=>x.price.value));
  else {
    const plausible = priced.filter(x=>!/\b(change|cash|tender)/i.test(x.line));
    if(plausible.length) amount = Math.max(...plausible.map(x=>x.price.value));
  }

  const lower = joined.toLowerCase();
  let category = 'Groceries';
  if(/\b(restaurant|cafe|coffee|pizza|burger|diner|takeout|delivery|starbucks|tim\s*hortons|mcdonald)/.test(lower)) category = 'Dining Out';
  else if(/\b(pharmacy|drug\s*mart|shoppers|clinic|dental|medical|hospital)/.test(lower)) category = 'Health & Medical';
  else if(/\b(gas\b|fuel|shell|esso|petro|uber|lyft|transit|taxi)/.test(lower)) category = 'Transportation';
  else if(/\b(amazon|best\s*buy|winners|ikea|canadian\s*tire|clothing|shoes)/.test(lower)) category = 'Shopping';
  else if(/\b(netflix|spotify|disney|prime\s*video|subscription)/.test(lower)) category = 'Subscriptions';

  const store = receiptStoreName(lines);


  const stopAt = lines.findIndex(l=>/\b(sub\s*-?\s*total|total|amount\s*due|balance\s*due)\b/i.test(l));
  const items = [];
  (stopAt >= 0 ? lines.slice(0, stopAt) : lines).forEach(line=>{
    const price = priceOf(line);
    if(!price || RECEIPT_SKIP_LINE.test(line)) return;
    const name = line.slice(0, price.firstIndex).replace(/^[\d\s#*xX@]+/, '').replace(/[^A-Za-z0-9&%'.\- ]/g, ' ').replace(/\s+/g, ' ').trim();
    if(price.value <= 0 || name.length < 2 || !/[A-Za-z]{2}/.test(name)) return;
    if(amount !== null && price.value > amount) return;
    items.push({name: name.slice(0, 48), amount: price.value, category: guessItemCategory(name, category)});
  });

  return {date, amount, category, store, items};
}


let receiptReview = null;   // {store, date, total, items:[{name, amount, category, include}]}

function renderReceiptReview(parsed, date){
  receiptReview = {store: parsed.store, date, total: parsed.amount, items: parsed.items.map(it=>({...it, include:true}))};
  const body = document.getElementById('receiptItemsBody');
  body.innerHTML = '';
  receiptReview.items.forEach((it, i)=>{
    const options = CATEGORIES.map(([name])=>`<option value="${escapeHtml(name)}"${name===it.category?' selected':''}>${escapeHtml(name)}</option>`).join('');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="checkbox" data-i="${i}" data-field="include" checked aria-label="Include ${escapeHtml(it.name)}"></td>`
      + `<td class="td-text">${escapeHtml(it.name)}</td>`
      + `<td class="amt"><input type="number" class="receipt-amount" step="0.01" min="0" value="${it.amount.toFixed(2)}" data-i="${i}" data-field="amount" aria-label="Amount for ${escapeHtml(it.name)}"></td>`
      + `<td><select data-i="${i}" data-field="category" aria-label="Category for ${escapeHtml(it.name)}">${options}</select></td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll('[data-field]').forEach(el=>el.addEventListener(el.type === 'checkbox' ? 'change' : 'input', ()=>{
    const it = receiptReview.items[+el.dataset.i];
    if(el.dataset.field === 'include') it.include = el.checked;
    else if(el.dataset.field === 'amount') it.amount = Math.max(0, parseFloat(el.value) || 0);
    else it.category = el.value;
    updateReceiptTotals();
  }));
  document.getElementById('receiptMeta').textContent = [receiptReview.store, receiptReview.date, `Receipt total ${fmt(receiptReview.total)}`].filter(Boolean).join(' · ');
  document.getElementById('receiptReviewStatus').textContent = '';
  document.getElementById('receiptReviewWrap').hidden = false;
  updateReceiptTotals();
}

function receiptCategoryTotals(){
  const round = n => Math.round(n*100)/100;
  const all = receiptReview.items.filter(it=>it.amount > 0);
  const included = all.filter(it=>it.include);
  const allSum = all.reduce((t,it)=>t + it.amount, 0);
  const includedSum = included.reduce((t,it)=>t + it.amount, 0);
  if(!includedSum) return {byCat:{}, itemsSum:0, extra:0, addTotal:0};
  const extra = allSum ? round((receiptReview.total - allSum) * includedSum / allSum) : 0;
  const raw = {};
  included.forEach(it=>{ raw[it.category] = (raw[it.category] || 0) + it.amount; });
  const cats = Object.keys(raw), byCat = {};
  let allocated = 0;
  cats.forEach((c, i)=>{
    const share = i === cats.length - 1 ? round(extra - allocated) : round(extra * raw[c] / includedSum);
    allocated = round(allocated + share);
    byCat[c] = Math.max(0, round(raw[c] + share));
  });
  return {byCat, itemsSum: round(includedSum), extra, addTotal: round(includedSum + extra)};
}

function updateReceiptTotals(){
  const {byCat, itemsSum, extra, addTotal} = receiptCategoryTotals();
  const parts = Object.entries(byCat).map(([c,v])=>`${escapeHtml(c)} ${fmt(v)}`);
  document.getElementById('receiptTotals').innerHTML = parts.length
    ? `Items ${fmt(itemsSum)} ${extra >= 0 ? '+' : '−'} tax &amp; other ${fmt(Math.abs(extra))} = <strong>${fmt(addTotal)}</strong><br>Will add: ${parts.join(' · ')}`
    : 'Tick at least one item.';
}

document.getElementById('receiptAddBtn').addEventListener('click', async ()=>{
  if(!receiptReview || !requireSignedIn()) return;
  const status = document.getElementById('receiptReviewStatus');
  const {byCat} = receiptCategoryTotals();
  const entries = Object.entries(byCat).filter(([,v])=>v > 0).map(([category, amount])=>({
    kind:'expense',
    entry:{id:crypto.randomUUID(), date:receiptReview.date, category, amount, description:receiptReview.store || 'Receipt'}
  }));
  if(!entries.length){ status.textContent = ' Tick at least one item.'; return; }
  
  const replaced = receiptReview.replaceId ? state.expenses.find(e=>e.id === receiptReview.replaceId) : null;
  try{
    if(replaced){
      await deleteTransaction(replaced.id);
      state.expenses = state.expenses.filter(e=>e.id !== replaced.id);
    }
    let result;
    try{
      result = await addEntriesToDatabase(entries);
    }catch(err){
      if(replaced){
        await insertTransaction(replaced, 'expense', makeFingerprint('expense', replaced)).then(()=>state.expenses.push(replaced)).catch(()=>{});
        render();
      }
      throw err;
    }
    receiptReview.replaceId = null;
    status.textContent = ` Added ${result.added} expense${result.added===1?'':'s'}${result.skipped ? `, skipped ${result.skipped} duplicate${result.skipped===1?'':'s'}` : ''}.`;
    if(replaced) setImportStatus('ok', `✓ Receipt split into ${result.added} expense${result.added===1?'':'s'} by category.`);
    jumpToDate(receiptReview.date);
    render();
    setTimeout(()=>{ document.getElementById('receiptReviewWrap').hidden = true; receiptReview = null; }, 2500);
  }catch(err){
    status.textContent = ' Could not add these expenses: ' + (err.message || 'Unknown error');
  }
});
document.getElementById('receiptCancelBtn').addEventListener('click', ()=>{
  document.getElementById('receiptReviewWrap').hidden = true;
  receiptReview = null;
});


const CATEGORY_KEYWORDS = [
  ["Groceries", ["walmart","target","costco","kroger","safeway","trader joe","whole foods","aldi","publix","grocery","supermarket"]],
  ["Transportation", ["uber","lyft","shell","chevron","exxon","mobil","gas station","transit","parking","dmv","auto repair","tesla supercharge"]],
  ["Dining Out", ["restaurant","mcdonald","starbucks","chipotle","doordash","grubhub","ubereats","cafe","coffee","pizza","taco","diner"]],
  ["Subscriptions", ["netflix","spotify","hulu","disney+","apple.com/bill","prime video","subscription","icloud","youtube premium","google one","google storage"]],
  ["Housing", ["rent","mortgage","hoa","property mgmt","landlord"]],
  ["Utilities", ["electric","water utility","gas utility","comcast","xfinity","verizon","at&t","t-mobile","internet","spectrum","utility"]],
  ["Insurance", ["insurance","geico","progressive","state farm","allstate"]],
  ["Health & Medical", ["pharmacy","cvs","walgreens","medical","dental","clinic","doctor","hospital"]],
  ["Personal Care", ["gym","fitness","salon","spa","barber","haircut"]],
  ["Shopping", ["amazon","best buy","clothing","ebay","etsy","macy","nordstrom","ikea"]],
  ["Debt Payments", ["loan payment","credit card payment","student loan","auto loan"]],
  ["Education", ["tuition","university","college","school fee"]],
  ["Childcare", ["daycare","childcare","babysit"]],
];
const INCOME_KEYWORDS = ["payroll","salary","paycheck","direct dep","direct deposit","deposit from","employer","refund","reimbursement","interest earned","cashback","cash back","credit"];
const EXPENSE_KEYWORDS = ["debit","withdrawal","purchase","payment","fee","charge","transfer out","bill pay","autopay","pos ","purchase at"];
// Keywords must start a word, so "rent" matches "RENT SEPT" but not "Parents".
function guessCategory(desc){const words=s=>' '+String(s).toLowerCase().replace(/[^a-z0-9]+/g,' ');const d=words(desc);for(const [cat,keys] of CATEGORY_KEYWORDS){if(keys.some(k=>d.includes(words(k).trimEnd())))return cat;}return "Other";}
function looksLikeIncome(desc){const d=desc.toLowerCase();return INCOME_KEYWORDS.some(w=>d.includes(w));}
function looksLikeExpense(desc){const d=desc.toLowerCase();return EXPENSE_KEYWORDS.some(w=>d.includes(w));}
function findDirectionFromText(desc){const d=desc.toLowerCase();if(/\b(cr|credit)\b/.test(d)||looksLikeIncome(d))return 'Income';if(/\b(dr|debit)\b/.test(d)||looksLikeExpense(d))return 'Expense';return null;}
function toIsoDate(raw){if(!raw)return null;raw=raw.trim();if(/^\d{4}-\d{2}-\d{2}$/.test(raw))return raw;let m=raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);if(m){let[_,mo,da,yr]=m;if(yr.length===2)yr='20'+yr;return `${yr}-${mo.padStart(2,'0')}-${da.padStart(2,'0')}`;}m=raw.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:,?\s+(\d{2,4}))?$/i);if(m){const months={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};const mo=months[m[1].slice(0,3).toLowerCase()];const da=+m[2];const yr=m[3]?(m[3].length===2?'20'+m[3]:m[3]):new Date().getFullYear();return `${yr}-${String(mo).padStart(2,'0')}-${String(da).padStart(2,'0')}`;}const d=new Date(raw);if(!isNaN(d.getTime()))return d.toISOString().slice(0,10);return null;}
let bankPreviewRows=[];
function renderBankPreview(rows){const body=document.getElementById('bankPreviewBody');if(!body)return;body.innerHTML='';bankPreviewRows=rows.map((r,i)=>({...r,id:i,amount:Math.abs(Number(r.signedAmount)),category:r.category||guessCategory(r.desc)}));bankPreviewRows.forEach(r=>{const tr=document.createElement('tr');const typeOpts=['Expense','Income'].map(t=>`<option value="${t}" ${t===r.type?'selected':''}>${t}</option>`).join('');const catOpts=CATEGORIES.map(([name])=>`<option value="${name}" ${name===r.category?'selected':''}>${name}</option>`).join('');tr.innerHTML=`<td>${r.date}</td><td class="td-text">${escapeHtml(r.desc)}</td><td class="amt">${fmt(r.amount)}</td><td><select data-id="${r.id}" data-field="type" style="font-size:12px;">${typeOpts}</select></td><td><select data-id="${r.id}" data-field="category" style="font-size:12px;" ${r.type==='Income'?'disabled':''}>${catOpts}</select></td>`;body.appendChild(tr);});body.querySelectorAll('select').forEach(sel=>{sel.addEventListener('change',()=>{const row=bankPreviewRows.find(r=>r.id===parseInt(sel.dataset.id));if(!row)return;row[sel.dataset.field]=sel.value;if(sel.dataset.field==='type'){const catSelect=sel.closest('tr').querySelector('select[data-field="category"]');catSelect.disabled=(sel.value==='Income');}});});document.getElementById('bankPreviewWrap').style.display=rows.length?'block':'none';}


let pdfjsReady = null;
async function getPdfJs(){
  if(pdfjsReady) return pdfjsReady;
  pdfjsReady = import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs').then(pdfjsLib=>{
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
    return pdfjsLib;
  });
  return pdfjsReady;
}

// Reads every text item with its position, grouped into visual lines per page.
async function extractPdfLines(bytes, statusEl){
  const pdfjsLib = await getPdfJs();
  const pdf = await pdfjsLib.getDocument({data: bytes.slice(0)}).promise;
  const lines = [];
  for(let pageNo=1; pageNo<=pdf.numPages; pageNo++){
    statusEl.textContent = `Reading statement… page ${pageNo} of ${pdf.numPages}`;
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();
    const rows = [];
    for(const item of content.items || []){
      const str = (item.str || '').trim();
      if(!str || !item.transform) continue;
      const x = item.transform[4], y = item.transform[5];
      let row = rows.find(r=>Math.abs(r.y - y) <= 3);
      if(!row){ row = {y, items:[]}; rows.push(row); }
      row.items.push({str, x, right: x + (item.width || 0)});
    }
    rows.sort((a,b)=>b.y - a.y).forEach(r=>{
      r.items.sort((a,b)=>a.x - b.x);
      lines.push({page:pageNo, items:r.items, text:r.items.map(i=>i.str).join(' ').replace(/\s+/g,' ').trim()});
    });
  }
  return lines;
}

const BANK_DATE_AT_START = /^(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?|\d{4}[\/-]\d{1,2}[\/-]\d{1,2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,?\s+\d{2,4})?|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:\s+\d{2,4})?)/i;
const BANK_MONEY_ITEM = /^\(?-?\$?\s?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)?-?$/;
const BANK_MONEY_IN_TEXT = /\d\.\d{2}\b/;

function bankLineIsoDate(raw){
  let t = raw.trim().replace(/\./g,'');
  const year = new Date().getFullYear();
  const dayFirst = t.match(/^(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:\s+(\d{2,4}))?$/i);
  if(dayFirst) t = `${dayFirst[2]} ${dayFirst[1]}${dayFirst[3] ? ', ' + dayFirst[3] : ''}`;
  if(/^\d{1,2}[\/-]\d{1,2}$/.test(t)) t += '/' + year;
  if(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(t) && !/\d{4}/.test(t)) t += ' ' + year;
  return toIsoDate(t);
}


function bankHeaderColumns(line){
  if(BANK_DATE_AT_START.test(line.text) || line.items.some(i=>BANK_MONEY_ITEM.test(i.str))) return null;
  const find = re => line.items.find(i=>re.test(i.str));
  const withdrawal = find(/\b(withdrawals?|debits?|money\s+out|paid\s+out|charges)\b/i);
  const deposit = find(/\b(deposits?|credits?|money\s+in|paid\s+in)\b/i);
  if(!withdrawal || !deposit || withdrawal === deposit) return null;
  const balance = find(/\bbalance\b/i);
  const col = i => i ? {right:i.right, center:(i.x + i.right)/2} : null;
  return {withdrawal:col(withdrawal), deposit:col(deposit), balance:col(balance)};
}

function nearestBankColumn(cols, item){
  const center = (item.x + item.right)/2;
  let best = null, bestDistance = Infinity;
  for(const name of ['withdrawal','deposit','balance']){
    const col = cols[name];
    if(!col) continue;
    const distance = Math.min(Math.abs(item.right - col.right), Math.abs(center - col.center));
    if(distance < bestDistance){ bestDistance = distance; best = name; }
  }
  return best;
}


function parseBankStatement(lines){
  const rows = [], fallback = [];
  let cols = null;
  for(const line of lines){
    const header = bankHeaderColumns(line);
    if(header){ cols = header; continue; }
    if(!cols){ fallback.push(line.text); continue; }

    const dateMatch = line.text.match(BANK_DATE_AT_START);
    if(!dateMatch) continue;
    const moneyItems = line.items.filter(i=>BANK_MONEY_ITEM.test(i.str));
    if(!moneyItems.length){
      // Amounts glued into one text item can't be placed in a column; use the text parser.
      if(BANK_MONEY_IN_TEXT.test(line.text)) fallback.push(line.text);
      continue;
    }
    const iso = bankLineIsoDate(dateMatch[1]);
    if(!iso) continue;

    let desc = line.items.filter(i=>!BANK_MONEY_ITEM.test(i.str) && i.str !== '$').map(i=>i.str).join(' ').replace(/\s+/g,' ').trim();
    const descDate = desc.match(BANK_DATE_AT_START);
    if(descDate) desc = desc.slice(descDate[0].length).trim();
    desc = desc || '(no description)';

    for(const item of moneyItems){
      const value = Math.abs(parseFloat(item.str.replace(/[$,()\s-]/g,'')));
      if(!Number.isFinite(value) || value === 0) continue;
      const column = nearestBankColumn(cols, item);
      if(column === 'withdrawal') rows.push({date:iso, desc, signedAmount:-value, type:'Expense'});
      else if(column === 'deposit') rows.push({date:iso, desc, signedAmount:value, type:'Income'});
    }
  }
  const textRows = fallback.length ? parseBankPdfText(fallback.join('\n')) : [];
  const seen = new Set();
  return [...rows, ...textRows]
    .filter(r=>{ const k = `${r.date}|${r.desc}|${r.signedAmount}`; if(seen.has(k)) return false; seen.add(k); return true; })
    .sort((a,b)=>a.date.localeCompare(b.date));
}

// Credit card statements list payments, interest and new charges in separate sections, each
// row with a transaction date, a posting date and one amount. Payments to the card are money
// moving from the bank, so they are left out (counting them would double-count spending).
// Interest and fees are expenses, purchases are expenses, and credits (refunds) are income.
const CARD_SPEND_CATEGORIES = [
  [/^restaurants?$/i, 'Dining Out'],
  [/^hotel,? entertainment (and|&) recreation$/i, 'Entertainment'],
  [/^transportation$/i, 'Transportation'],
  [/^health (and|&) education$/i, 'Health & Medical'],
  [/^personal (and|&) household expenses$/i, 'Personal Care'],
  [/^home (and|&) office improvement$/i, 'Shopping'],
  [/^retail (and|&) grocery$/i, 'Shopping'],
  [/^professional (and|&) financial services$/i, 'Other'],
  [/^foreign currency transactions$/i, 'Other'],
  [/^other transactions$/i, 'Other'],
];

const CARD_PRECISE_CATEGORIES = new Set(['Dining Out', 'Entertainment', 'Transportation', 'Health & Medical']);

function parseCardStatement(lines){
  const text = lines.map(l=>l.text).join('\n');
  const isCard = /\b(visa|master\s*card|amex|american express)\b/i.test(text)
    && /\b(minimum payment|credit limit|available credit)\b/i.test(text)
    && /\b(purchases|new charges)\b/i.test(text);
  if(!isCard) return null;

 
  const monthIndex = m => 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m.slice(0, 3).toLowerCase()) / 3 + 1;
  const stated = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+(20\d{2})\b/i);
  const endMonth = stated ? monthIndex(stated[1]) : new Date().getMonth() + 1;
  const endYear = stated ? +stated[2] : new Date().getFullYear();
  const namedDate = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})$/i;
  const isDate = s => namedDate.test(s) || /^\d{1,2}[\/-]\d{1,2}$/.test(s);
  const toIso = s => {
    const named = s.match(namedDate);
    const [mo, d] = named ? [monthIndex(named[1]), +named[2]] : s.split(/[\/-]/).map(Number);
    if(!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    return `${mo > endMonth ? endYear - 1 : endYear}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };

  const rows = [];
  let section = 'charges', payments = 0;
  for(const {items, text: lineText} of lines){
    if(!items.length) continue;
    const money = items.filter(i=>BANK_MONEY_ITEM.test(i.str));
    if(!isDate(items[0].str)){
      // Short lines with no date and no amount are section headings.
      if(!money.length && lineText.length < 40){
        if(/\bpayments?\b/i.test(lineText) && !/\b(due|minimum)\b/i.test(lineText)) section = 'payments';
        else if(/\binterest\b/i.test(lineText)) section = 'interest';
        else if(/\bfees?\b/i.test(lineText)) section = 'fees';
        else if(/\b(charges|purchases|credits)\b/i.test(lineText)) section = 'charges';
      }
      continue;
    }
    const date = toIso(items[0].str);
    if(!date || !money.length) continue;
    const amountItem = money[money.length - 1];
    const credit = /^\(.*\)$|^-|-$/.test(amountItem.str) || items.some(i=>/^CR$/i.test(i.str));
    const value = Math.abs(parseFloat(amountItem.str.replace(/[$,()\s-]/g, '')));
    if(!value) continue;

    let spend = '';
    const desc = items.slice(1).filter((item, k)=>{
      if(k === 0 && isDate(item.str)) return false;   // posting date
      if(money.includes(item) || /%$/.test(item.str) || /^CR$/i.test(item.str) || item.str === '$') return false;
      if(CARD_SPEND_CATEGORIES.some(([re])=>re.test(item.str))){ spend = item.str; return false; }
      return true;
    }).map(i=>i.str).join(' ').replace(/\b\d{3}-\d{3}-\d{4}\b/g, '').replace(/\s+/g, ' ').trim()
      .replace(/\s+(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)$/, '') || '(no description)';

    if(section === 'payments' || /payment\s*(thank\s*you|received)|paiement\s*merci/i.test(desc)){ payments++; continue; }
    if(section === 'interest' || section === 'fees'){
      rows.push({date, desc:`${section === 'interest' ? 'Interest charge' : 'Card fee'} · ${desc}`, signedAmount:-value, type:'Expense', category:'Debt Payments'});
      continue;
    }
    if(credit){ rows.push({date, desc:`Refund · ${desc}`, signedAmount:value, type:'Income'}); continue; }
    const byMerchant = guessCategory(desc);
    const byCard = (CARD_SPEND_CATEGORIES.find(([re])=>re.test(spend)) || [])[1];
    const category = byCard && (CARD_PRECISE_CATEGORIES.has(byCard) || byMerchant === 'Other') ? byCard : byMerchant;
    rows.push({date, desc, signedAmount:-value, type:'Expense', category});
  }
  return {rows: rows.sort((a,b)=>a.date.localeCompare(b.date)), payments};
}

function parseBankPdfText(text){
  const lines=text.split(/\r?\n/).map(x=>x.replace(/\s+/g,' ').trim()).filter(Boolean);
  const candidates=[]; let currentYear=new Date().getFullYear(); let previousBalance=null;
  const openingMatch=text.match(/(?:opening|beginning)\s+balance[^$\d-]*\(?-?([\d,]+(?:\.\d{2})?)\)?/i);
  if(openingMatch) previousBalance=parseFloat(openingMatch[1].replace(/,/g,''));
  const dateAtStart=/^(\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?|\d{4}[\/-]\d{1,2}[\/-]\d{1,2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,?\s+\d{2,4})?)/i;
  const money=/(?:\$\s*)?\(?-?\d{1,3}(?:,\d{3})*(?:\.\d{2})\)?|(?:\$\s*)?\(?-?\d+(?:\.\d{2})\)?/g;
  const skip=/^(date|transaction date|posted|description|details|merchant|amount|balance|opening balance|closing balance|account|statement|page \d|total|subtotal|summary|debits?|credits?|withdrawals?|deposits?)/i;
  for(const line of lines){
    if(skip.test(line)) continue;
    const dm=line.match(dateAtStart); if(!dm) continue;
    let dateText=dm[1];
    if(/^\d{1,2}[\/-]\d{1,2}$/.test(dateText)) dateText+='/'+currentYear;
    if(/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(dateText)&&!/\d{4}/.test(dateText)) dateText+=' '+currentYear;
    const iso=toIsoDate(dateText); if(!iso) continue;
    const rest=line.slice(dm[0].length).trim();
    const matches=[]; let mm; money.lastIndex=0;
    while((mm=money.exec(rest))!==null) matches.push({raw:mm[0],index:mm.index});
    if(!matches.length) continue;
    const parsedAmounts=matches.map(m=>({raw:m.raw,index:m.index,value:parseFloat(m.raw.replace(/[$,\s]/g,'').replace(/^\((.*)\)$/,'-$1'))})).filter(x=>Number.isFinite(x.value));
    if(!parsedAmounts.length) continue;
    const first=parsedAmounts[0];
    const last=parsedAmounts[parsedAmounts.length-1];
    const desc=rest.slice(0,first.index).trim() || rest.replace(first.raw,'').trim() || '(no description)';
    const lower=rest.toLowerCase();
    const explicit=findDirectionFromText(rest);
    const hasNegative=/^-|^\(/.test(first.raw);
    const hasCredit=/\b(cr|credit|deposit|deposited|payroll|salary|direct\s+dep(?:osit)?)\b/i.test(lower);
    const hasDebit=/\b(dr|debit|withdrawal|withdrawn|purchase|payment|fee|charge|autopay|bill\s+pay|pos)\b/i.test(lower);
    let typeHint=explicit || (hasCredit&&!hasDebit?'Income':hasDebit&&!hasCredit?'Expense':null);
    let balance=null;
    // On statements with a running balance, the last amount is normally the balance.
    if(parsedAmounts.length>=2) balance=last.value;
    let signedAmount=hasNegative ? -Math.abs(first.value) : Math.abs(first.value);
    if(!typeHint && Number.isFinite(balance) && Number.isFinite(previousBalance)){
      const delta=balance-previousBalance;
      if(delta>0.005) { typeHint='Income'; signedAmount=Math.abs(first.value); }
      else if(delta<-0.005) { typeHint='Expense'; signedAmount=-Math.abs(first.value); }
    }
    candidates.push({date:iso,desc,signedAmount,typeHint,balance});
    if(Number.isFinite(balance)) previousBalance=balance;
  }
  const rows=candidates.map(r=>{
   
    const type=r.typeHint || 'Expense';
    return {date:r.date,desc:r.desc,signedAmount:type==='Income'?Math.abs(r.signedAmount):-Math.abs(r.signedAmount),type};
  });
  const seen=new Set();
  return rows.filter(r=>{const k=`${r.date}|${r.desc}|${r.signedAmount}`;if(seen.has(k))return false;seen.add(k);return true;});
}


function parseCsvTable(text){
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/).find(l=>l.trim()) || '';
  const delim = [',', ';', '\t'].sort((a,b)=>firstLine.split(b).length - firstLine.split(a).length)[0];
  const table = [];
  let row = [], field = '', quoted = false;
  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(quoted){
      if(c === '"' && text[i+1] === '"'){ field += '"'; i++; }
      else if(c === '"') quoted = false;
      else field += c;
    }else if(c === '"') quoted = true;
    else if(c === delim){ row.push(field); field = ''; }
    else if(c === '\n' || c === '\r'){
      if(c === '\r' && text[i+1] === '\n') i++;
      row.push(field); table.push(row); row = []; field = '';
    }else field += c;
  }
  row.push(field); table.push(row);
  return table.map(r=>r.map(f=>f.trim())).filter(r=>r.some(Boolean));
}
const CSV_MONEY = /^\(?[-+]?\$?\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?\)?-?(?:\s?(?:CR|DR))?$/i;
function csvMoney(raw){
  const s = String(raw || '').trim();
  if(!CSV_MONEY.test(s)) return null;
  const value = parseFloat(s.replace(/[^\d.]/g, ''));
  return /^[(-]|-$|DR$/i.test(s) ? -value : value;
}
function csvIsoDate(raw, dayFirst){
  const t = String(raw || '').trim();
  const valid = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31 ? calIso(y, m, d) : null;
  let m = t.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})\b/);
  if(m) return valid(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4}|\d{2})\b/);
  if(m){
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return dayFirst ? valid(y, +m[2], +m[1]) : valid(y, +m[1], +m[2]);
  }
  m = t.match(BANK_DATE_AT_START);
  return m && m[0] === t ? bankLineIsoDate(m[1]) : null;
}

const TRACKER_MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const TRACKER_CATEGORY_WORDS = [
  ['Housing', /\brent\b|housing|mortgage/], ['Groceries', /grocer|\bfood\b/], ['Transportation', /transport|transit|\bbus\b|\bcar\b|\bgas\b|\bfuel\b/],
  ['Utilities', /utilit|\bphone\b|internet|hydro|electric/], ['Debt Payments', /\bdebt\b|credit card|\bloans?\b/],
  ['Education', /educat|universit|college|tuition|school/], ['Savings & Investments', /\bsaving|invest|rrsp|tfsa/],
  ['Insurance', /insur/], ['Health & Medical', /health|medic|pharm|dental/], ['Dining Out', /dining|restaurant|takeout/],
  ['Subscriptions', /subscri|netflix|spotify/], ['Entertainment', /entertain|movie|\bgames?\b/], ['Shopping', /shopping|cloth/],
  ['Personal Care', /personal care|\bgym\b|\bhair/], ['Childcare', /\bchild|daycare/],
];
function trackerMonth(cell){
  const t = String(cell || '').trim().toLowerCase().replace(/\.$/, '');
  const i = TRACKER_MONTHS.findIndex(m=>t === m || t === m.slice(0,3) || (m === 'september' && t === 'sept'));
  return i + 1;
}
function trackerCategory(name, sub){
  const exact = CATEGORIES.find(([c])=>[name, sub].some(x=>x.toLowerCase() === c.toLowerCase()));
  if(exact) return exact[0];
  const text = `${name} ${sub}`.toLowerCase();
  const hit = TRACKER_CATEGORY_WORDS.find(([, re])=>re.test(text));
  return hit ? hit[0] : guessCategory(text);
}
function parseTrackerCsv(table){
  const isMonthRow = r => r.filter(trackerMonth).length >= 2;
  if(!table.some(isMonthRow)) return null;
  const yearText = table.filter(r=>isMonthRow(r) || r.filter(Boolean).length === 1).flat().join(' ').match(/\b(20\d{2})\b/);
  const year = yearText ? +yearText[1] : new Date().getFullYear();
  const rows = [];
  let type = 'Expense', months = null, cols = null;
  for(const r of table){
    const name = (r[0] || '').trim(), sub = (r[1] || '').trim();
    if(r.filter(Boolean).length === 1 && /income|earning/i.test(name)){ type = 'Income'; continue; }
    if(r.filter(Boolean).length === 1 && /expense|spending|bills/i.test(name)){ type = 'Expense'; continue; }
    if(isMonthRow(r)){
      let current = 0;
      months = r.map(c=>{ if(c) current = trackerMonth(c); return current; });
      cols = null;
      continue;
    }
    if(months && !cols && !r.some(c=>csvMoney(c))){
      // The header under the months: which columns hold amounts, and the day each stands for.
      const weeksIn = {};
      r.forEach((c, j)=>{ const w = c.match(/week\s*(\d+)/i); if(w && months[j]) weeksIn[months[j]] = Math.max(weeksIn[months[j]] || 0, +w[1]); });
      cols = [];
      r.forEach((c, j)=>{
        const month = months[j], w = c.match(/week\s*(\d+)/i);
        if(!month) return;
        if(w) cols.push({col:j, month, day: weeksIn[month] <= 2 ? (w[1] === '1' ? 1 : 15) : Math.min(28, 1 + (w[1]-1)*7)});
        else if(!weeksIn[month] && !/total/i.test(c) && !cols.some(x=>x.month === month)) cols.push({col:j, month, day:1});
      });
      continue;
    }
    if(!cols || (!name && !sub) || /^(total|net|balance|grand total)/i.test(name)) continue;
    for(const c of cols){
      const value = csvMoney(r[c.col]);
      if(!value) continue;
      const date = calIso(year, c.month, c.day);
      if(type === 'Income') rows.push({date, desc: sub.length > name.length ? sub : name, signedAmount: Math.abs(value), type:'Income'});
      else rows.push({date, desc: name || sub, signedAmount: -Math.abs(value), type:'Expense', category: trackerCategory(name, sub)});
    }
  }
  return rows.sort((a,b)=>a.date.localeCompare(b.date));
}

function parseBankCsv(text){
  const table = parseCsvTable(text);
  const tracker = parseTrackerCsv(table);
  if(tracker) return tracker;
  const isDate = c => !!(csvIsoDate(c, false) || csvIsoDate(c, true));
  const headerAt = table.slice(0, 10).findIndex(r=>r.some(c=>/date/i.test(c)) && !r.some(isDate));
  const header = headerAt >= 0 ? table[headerAt].map(h=>h.toLowerCase()) : null;
  const body = header ? table.slice(headerAt + 1) : table;
  const find = re => header.findIndex(h=>re.test(h));
  const col = header && {
    date: find(/date/),
    desc: header.map((h,i)=>/description|details|merchant|payee|memo|narrative|particulars|^name$|^transaction$/.test(h) ? i : -1).filter(i=>i >= 0),
    type: find(/^(transaction )?type$|cr\s*\/\s*dr|dr\s*\/\s*cr|debit\s*\/\s*credit|credit\s*\/\s*debit/),
    out: find(/withdraw|^debits?( amount)?$|money out|paid out|^charges?$/),
    in: find(/deposit|^credits?( amount)?$|money in|paid in/),
    amount: find(/amount|^value$|cad\$|usd\$|^\$$/),
  };
  if(header && col.date < 0) return [];
  const dates = body.map(r=>header ? r[col.date] : r.find(isDate)).filter(Boolean);
  const dayFirst = dates.some(c=>{ const m = c.match(/^(\d{1,2})[\/.-]\d{1,2}[\/.-]/); return m && +m[1] > 12; });

  const rows = [];
  for(const r of body){
    let date, desc, out = null, inn = null, signed = null, typeText = '';
    if(header){
      date = csvIsoDate(r[col.date], dayFirst);
      desc = col.desc.map(i=>r[i]).filter(Boolean).join(' · ');
      if(col.out >= 0 || col.in >= 0){ out = csvMoney(r[col.out]); inn = csvMoney(r[col.in]); }
      else if(col.amount >= 0) signed = csvMoney(r[col.amount]);
      if(col.type >= 0) typeText = String(r[col.type] || '').toLowerCase();
    }else{
      const di = r.findIndex(isDate);
      if(di < 0) continue;
      date = csvIsoDate(r[di], dayFirst);
      const ti = r.findIndex((c,i)=>i > di && c && !CSV_MONEY.test(c));
      desc = ti >= 0 ? r[ti] : '';
      const slots = r.slice((ti >= 0 ? ti : di) + 1);
      if(slots.length >= 2){ out = csvMoney(slots[0]); inn = csvMoney(slots[1]); }
      else signed = csvMoney(slots[0]);
    }
    if(!date) continue;
    desc = desc || '(no description)';
    if(/opening balance|closing balance|balance forward/i.test(desc)) continue;
    if(out) rows.push({date, desc, signedAmount:-Math.abs(out), type:'Expense'});
    if(inn) rows.push({date, desc, signedAmount:Math.abs(inn), type:'Income'});
    if(signed){
      const type = /debit|withdraw|\bdr\b/.test(typeText) ? 'Expense' : /credit|deposit|\bcr\b/.test(typeText) ? 'Income' : signed < 0 ? 'Expense' : 'Income';
      rows.push({date, desc, signedAmount:type === 'Expense' ? -Math.abs(signed) : Math.abs(signed), type});
    }
  }
  return rows.sort((a,b)=>a.date.localeCompare(b.date));
}

document.getElementById('bankConfirmBtn').addEventListener('click', async ()=>{
  if(!bankPreviewRows.length || !requireSignedIn()) return;
  const status=document.getElementById('bankConfirmStatus');
  try{
    const entries=bankPreviewRows.map(r=>r.type==='Expense'?{kind:'expense',entry:{id:crypto.randomUUID(),date:r.date,category:r.category||'Other',amount:Math.abs(Number(r.amount)),description:r.desc||null}}:{kind:'income',entry:{id:crypto.randomUUID(),date:r.date,source:r.desc||'(bank transaction)',amount:Math.abs(Number(r.amount)),description:r.desc||null}}).filter(x=>x.entry.date&&Number.isFinite(x.entry.amount)&&x.entry.amount>0);
    const result=await addEntriesToDatabase(entries);
    
    const dates=entries.map(x=>x.entry.date).sort();
    const monthName=iso=>longDate(iso,{month:'long',year:'numeric'});
    const monthSel=document.getElementById('monthSel'), yearSel=document.getElementById('yearSel');
    if(dates.length){
      if(monthSel.value==='0') monthSel.value='1';
      if(yearSel.value==='0') yearSel.value=String(new Date().getFullYear());
      jumpToDate(dates[dates.length-1]);
    }
    await loadState();
    const added=`Added ${result.added} transaction${result.added===1?'':'s'}${result.skipped?`; skipped ${result.skipped} duplicate${result.skipped===1?'':'s'}`:''}.`;
    const range=dates.length?(monthName(dates[0])===monthName(dates[dates.length-1])?monthName(dates[0]):`${monthName(dates[0])} to ${monthName(dates[dates.length-1])}`):'';
    status.textContent=added;
    const importStatus=document.getElementById('pdfBankStatus');
    importStatus.className='inline-import-status ok';
    importStatus.textContent=range?`${added} They cover ${range}, each saved in its own month. Showing ${monthName(dates[dates.length-1])}; pick another month at the top to see the rest.`:added;
    window.scrollTo({top:0,behavior:'smooth'});
    updateStorageStatus(`Statement import: ${result.added} added ✓`);
    setTimeout(()=>{document.getElementById('bankPreviewWrap').style.display='none';status.textContent='';},3500);
  }catch(err){
    console.error(err);status.textContent='Could not save imported transactions.';status.style.color='var(--rust)';
  }
});

document.getElementById('bankCancelBtn').addEventListener('click',()=>{
  document.getElementById('bankPreviewWrap').style.display='none';
  document.getElementById('pdfBankStatus').textContent='';
  bankPreviewRows=[];
});

populateSelectors();
setAppEnabled(false);
initDatabase();


function advisorMonthlyStats(){const rows=mlMonthlyData();const recent=rows.slice(-3);const n=recent.length||1;const avgIncome=recent.reduce((a,x)=>a+x.income,0)/n;const avgExpense=recent.reduce((a,x)=>a+x.expense,0)/n;return {rows,recent,avgIncome,avgExpense,avgNet:avgIncome-avgExpense};}
function advisorCategoryTotals(){const totals={};(state.expenses||[]).forEach(e=>{const c=e.category||'Other';totals[c]=(totals[c]||0)+Math.abs(Number(e.amount)||0);});return totals;}

function leftThisMonth(){
  const {year, month} = currentPeriod();
  const income = state.income.filter(e=>inPeriod(e.date, year, month)).reduce((t,e)=>t + (Number(e.amount)||0), 0);
  const spent = state.expenses.filter(e=>inPeriod(e.date, year, month));
  const out = spent.reduce((t,e)=>t + (Number(e.amount)||0), 0) + lentOutOf(spent);
  return {income, out, left: round2(income - out), hasData: income > 0 || spent.length > 0};
}

function advisorGoalMonthlyNeed(){const today=new Date();let need=0;(state.goals||[]).forEach(g=>{const remaining=Math.max(0,(Number(g.target_amount)||0)-(Number(g.saved_amount)||0));if(!remaining)return;const end=new Date(String(g.target_date)+'T00:00:00');const months=Math.max(1,(end.getFullYear()-today.getFullYear())*12+(end.getMonth()-today.getMonth()));need+=remaining/months;});return need;}


let mlShownKey = '';     // the monthly totals the Next month card currently reflects
let mlTraining = false;
const round2 = n => Math.round((Number(n)||0) * 100) / 100;

function mlMonthlyData(){
  const byMonth = new Map();
  (state.income||[]).forEach(x=>{
    const k=String(x.date).slice(0,7); if(!/^\d{4}-\d{2}$/.test(k)) return;
    if(!byMonth.has(k)) byMonth.set(k,{income:0,expense:0});
    byMonth.get(k).income += Math.abs(Number(x.amount)||0);
  });
  (state.expenses||[]).forEach(x=>{
    const k=String(x.date).slice(0,7); if(!/^\d{4}-\d{2}$/.test(k)) return;
    if(!byMonth.has(k)) byMonth.set(k,{income:0,expense:0});
    // Cash out: the user's share plus anything paid on someone else's behalf.
    byMonth.get(k).expense += Math.abs(Number(x.amount)||0) + (x.shared ? Math.max(0,(Number(x.grossAmount)||0)-(Number(x.amount)||0)) : 0);
  });
  const all=[...byMonth.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([month,v])=>({month,income:v.income,expense:v.expense,net:v.income-v.expense}));
 
  const complete=all.filter(r=>r.month < String(calToday()).slice(0,7));
  return complete.length ? complete : all;
}

function mlFallbackForecast(rows){
  const n=Math.min(3,rows.length);
  if(!n){
    ['mlIncomeForecast','mlExpenseForecast','mlNetForecast'].forEach(id=>{document.getElementById(id).textContent='—';});
    document.getElementById('mlForecastNote').textContent='Add income and expenses to see a forecast.';
    return;
  }
  const recent=rows.slice(-n);
  // Round first, then subtract, so the three numbers on the card always add up.
  const avgIncome=round2(recent.reduce((a,x)=>a+x.income,0)/n), avgExpense=round2(recent.reduce((a,x)=>a+x.expense,0)/n);
  document.getElementById('mlIncomeForecast').textContent=fmt(avgIncome);
  document.getElementById('mlExpenseForecast').textContent=fmt(avgExpense);
  document.getElementById('mlNetForecast').textContent=fmt(avgIncome-avgExpense);
  const partial=rows[rows.length-1].month === String(calToday()).slice(0,7);
  document.getElementById('mlForecastNote').textContent = partial
    ? 'Based on this month so far, which isn’t finished yet. Once you have a full month, the estimate gets better.'
    : `Based on your average over the last ${n} complete month${n===1?'':'s'}. An estimate, not a guarantee.`;
}


function refreshForecast(){
  const rows=mlMonthlyData(), key=JSON.stringify(rows);
  if(key===mlShownKey || mlTraining) return;
  if(rows.length<4 || typeof tf==='undefined'){ mlFallbackForecast(rows); mlShownKey=key; return; }
  if(!mlShownKey) mlFallbackForecast(rows);
  trainLedgerML(rows, key);
}

async function trainLedgerML(rows, key){
  mlTraining=true;
  try{
    const inputs=[],targets=[];
  
    for(let i=3;i<rows.length;i++){
      const win=rows.slice(i-3,i);
      inputs.push(win.flatMap(r=>[r.income,r.expense,r.net]));
      targets.push([rows[i].income,rows[i].expense]);
    }
    const maxAbs=Math.max(1,...inputs.flat().map(x=>Math.abs(x)),...targets.flat().map(x=>Math.abs(x)));
    const X=tf.tensor2d(inputs).div(maxAbs); const Y=tf.tensor2d(targets).div(maxAbs);
    const model=tf.sequential();
    model.add(tf.layers.dense({inputShape:[9],units:24,activation:'relu'}));
    model.add(tf.layers.dense({units:12,activation:'relu'}));
    model.add(tf.layers.dense({units:2,activation:'linear'}));
    model.compile({optimizer:tf.train.adam(0.01),loss:'meanSquaredError'});
    const epochs=Math.min(120,Math.max(50,rows.length*10));
    await model.fit(X,Y,{epochs,batchSize:Math.min(8,inputs.length),shuffle:false,verbose:0});
    X.dispose();Y.dispose();
    const last3=rows.slice(-3);
    const feature=tf.tensor2d([last3.flatMap(r=>[r.income,r.expense,r.net])]).div(maxAbs);
    const pred=model.predict(feature); const vals=Array.from(await pred.data()); feature.dispose(); pred.dispose(); model.dispose();
    // Round first, then subtract, so the three numbers on the card always add up.
    const income=round2(Math.max(0,vals[0]*maxAbs)), expense=round2(Math.max(0,vals[1]*maxAbs));
    document.getElementById('mlIncomeForecast').textContent=fmt(income);
    document.getElementById('mlExpenseForecast').textContent=fmt(expense);
    document.getElementById('mlNetForecast').textContent=fmt(income-expense);
    document.getElementById('mlForecastNote').textContent='Based on your recent complete months. An estimate, not a guarantee.';
  }catch(err){console.error('Forecast training failed:', err);mlFallbackForecast(rows);}
  finally{mlShownKey=key;mlTraining=false;}
  refreshForecast();   
}

initLedgerChatbot();
const assistantFab=document.getElementById('assistantFab'), assistantPanel=document.getElementById('manualChatbot'), assistantClose=document.getElementById('assistantCloseBtn');
function openLedgerAssistant(){assistantPanel.classList.add('open');assistantFab.style.display='none';}
function closeLedgerAssistant(){assistantPanel.classList.remove('open');assistantFab.style.display='flex';}
assistantFab.addEventListener('click',openLedgerAssistant);
assistantClose.addEventListener('click',closeLedgerAssistant);

function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}


var pendingJoinToken;


function captureJoinToken(){
  const params = new URLSearchParams(window.location.search);
  const token = params.get('join');
  if(!token) return;
  pendingJoinToken = token;
  try{ localStorage.setItem('ledgerPendingJoin', token); }catch(e){}
  params.delete('join');
  const query = params.toString();
  history.replaceState(null, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash);
}

function peekPendingJoin(){
  try{ return pendingJoinToken || localStorage.getItem('ledgerPendingJoin'); }catch(e){ return pendingJoinToken; }
}

async function processPendingJoin(){
  if(!databaseMode || !currentUser) return;
  const token = peekPendingJoin();
  if(!token) return;
  pendingJoinToken = null;
  try{ localStorage.removeItem('ledgerPendingJoin'); }catch(e){}
  showTab('intelligence');
  const status = document.getElementById('goalStatus');
  const {error} = await dbClient.rpc('join_goal', {p_token: token});
  if(error){
    status.textContent = 'Could not join the shared goal: ' + (error.message || 'Unknown error');
    return;
  }
  status.textContent = 'You joined a shared goal ✓ It’s in your savings goals below.';
  await loadGoals();
}

function sharePanelHtml(g, members){
  const people = members.length
    ? members.map(m=>`<li><span>${escapeHtml(m.email)}${m.user_id ? '' : ' <em>(invited)</em>'}</span><button type="button" class="link-btn member-remove" data-goal="${g.id}" data-email="${escapeHtml(m.email)}">Remove</button></li>`).join('')
    : '<li class="mini-note">Nobody yet.</li>';
  return `<div class="share-panel" data-goal="${g.id}">
    <strong>Share “${escapeHtml(g.name)}”</strong>
    <div class="share-row"><input type="email" class="share-email" placeholder="Partner’s email" aria-label="Partner’s email"><button type="button" class="btn-primary share-send" data-id="${g.id}">Send invite</button></div>
    <div class="share-or">or</div>
    <div class="share-row"><button type="button" class="btn-secondary share-copy" data-id="${g.id}">Copy invite link</button><button type="button" class="link-btn share-revoke" data-id="${g.id}">Turn off link</button></div>
    <div class="share-status mini-note" aria-live="polite">Anyone with the link can join after signing in.</div>
    <ul class="share-members">${people}</ul>
  </div>`;
}

function setShareStatus(goalId, message, kind=''){
  const el = document.querySelector(`.share-panel[data-goal="${goalId}"] .share-status`);
  if(!el) return;
  el.textContent = message;
  el.className = 'share-status mini-note' + (kind ? ' ' + kind : '');
}

// Emails the invite through the invite-partner Edge Function. The function holds the
// Supabase secret key on the server; that key must never be placed in this file.
async function sendGoalInvite(goalId, email){
  const {data, error} = await dbClient.functions.invoke('invite-partner', {
    body:{goal_id:goalId, email, redirect_to:getAuthRedirectUrl()}
  });
  if(error){
    let detail = error.message || 'unknown error';
    try{ const body = await error.context.json(); if(body && body.error) detail = body.error; }catch(e){}
    return {ok:false, message:`${email} was added, but the invite email couldn’t be sent (${detail}). Use “Copy invite link” to share it another way.`};
  }
  return {ok:true, message: data && data.status === 'existing_user'
    ? `${email} already has a Ledger account, so they were emailed a sign-in link. The goal is waiting in their savings goals.`
    : `Invite sent to ${email} ✓ Once they accept and sign in, the goal appears in their savings goals.`};
}


async function getInviteLink(goalId){
  const {data, error} = await dbClient.from('goal_invites').select('token').eq('goal_id', goalId).is('revoked_at', null).order('created_at', {ascending:false}).limit(1);
  if(error) throw error;
  let token = data && data[0] && data[0].token;
  if(!token){
    const created = await dbClient.from('goal_invites').insert({goal_id: goalId}).select('token').single();
    if(created.error) throw created.error;
    token = created.data.token;
  }
  return `${getAuthRedirectUrl()}?join=${encodeURIComponent(token)}`;
}

async function copyText(text){
  try{
    await navigator.clipboard.writeText(text);
    return true;
  }catch(e){
    window.prompt('Copy this link:', text);
    return false;
  }
}

function copilotStats(){
  const rows=mlMonthlyData(), recent=rows.slice(-3), n=recent.length||1;
  const avgIncome=recent.reduce((a,x)=>a+x.income,0)/n,avgExpense=recent.reduce((a,x)=>a+x.expense,0)/n,avgNet=avgIncome-avgExpense;
  const totals=advisorCategoryTotals(); const ranked=Object.entries(totals).sort((a,b)=>b[1]-a[1]);
  return {rows,recent,avgIncome,avgExpense,avgNet,totals,ranked};
}

function copilotMonthContext(){
  const {year, month} = currentPeriod();
  const thisMonth = monthOf(calToday());
  const ym = year && month ? calIso(year, month, 1).slice(0, 7) : thisMonth;
  return {ym, isCurrentMonth: ym === thisMonth, label: longDate(ym + '-01', {month:'long', year:'numeric'})};
}
function copilotAllInsights(ym, isCurrentMonth){
  const decisions = copilotDecisions();
  const spend = spendingInsights(ym, decisions, isCurrentMonth);
  const subs = subscriptionInsight(isCurrentMonth);
  const all = [...spend.insights, ...(subs ? [subs] : [])];
  
  const isHidden = i=>{ const d = decisions[i.id]; return !!d && (d.action === 'ignore' || d.month === ym); };
  return {spend, shown: all.filter(i=>!isHidden(i)), hidden: all.filter(isHidden)};
}
const insightLines = list => list.map(i=>`• ${i.title}\n  ${i.why}${i.goal ? '\n  ' + i.goal : ''}`).join('\n\n');

function copilotNoticedText(){
  const {ym, isCurrentMonth, label} = copilotMonthContext();
  if(!state.income.length && !state.expenses.length) return 'Add or upload a few transactions first, then I can tell you what changed.';
  const {spend, shown, hidden} = copilotAllInsights(ym, isCurrentMonth);
  if(spend.learning) return 'I need at least two earlier months of spending before I can tell what is normal for you. Keep adding transactions, or upload past statements.';
  const head = shown.length ? `Here is what I noticed in ${label}:\n\n${insightLines(shown)}` : `Nothing unusual in ${label}.`;
  const hiddenNote = hidden.length ? `\n\n${hidden.length} insight${hidden.length === 1 ? ' is' : 's are'} hidden right now. Say “show hidden” to see ${hidden.length === 1 ? 'it' : 'them'}, or “reset alerts” to bring everything back.` : '';
  const learned = spend.ignored ? `\n\nYou have ignored ${spend.ignored} spending alert${spend.ignored === 1 ? '' : 's'}, so I now only mention jumps of ${Math.round((spend.threshold - 1) * 100)}% or more above usual.` : '';
  return head + hiddenNote + learned;
}
function copilotHiddenText(){
  const {ym, isCurrentMonth} = copilotMonthContext();
  const {hidden} = copilotAllInsights(ym, isCurrentMonth);
  return hidden.length
    ? `These are hidden at the moment:\n\n${insightLines(hidden)}\n\nSay “reset alerts” to show them again.`
    : 'Nothing is hidden right now.';
}
function copilotResetText(){
  writeStore(copilotStoreKey(), '{}');
  return 'Done — nothing is hidden any more, and I am back to mentioning any jump of 25% or more above usual. Ask “what did you notice?” to see everything.';
}
function copilotPatternsText(){
  const patterns = incomePatterns();
  if(!patterns.length) return 'I have not spotted a regular income yet. Once the same income arrives 3 times on a steady schedule, I learn it and mark the next expected day on the calendar.';
  return 'Your regular income:\n\n' + patterns.map(p=>`• ${p.source} · ${p.schedule} · about ${fmt(p.amount)}\n  Next expected ${longDate(p.next, {weekday:'short', month:'short', day:'numeric'})} (${whenText(p.next)})`).join('\n\n')
    + '\n\nPayday reminders can also pop up as notifications: turn them on from your profile.';
}
function copilotNormalsText(){
  const {ym, isCurrentMonth} = copilotMonthContext();
  const {earlier, cats} = learnSpending(ym);
  const normals = cats.filter(c=>c.usual > 0).sort((a,b)=>b.usual - a.usual).slice(0, 6);
  if(earlier.length < 2 || !normals.length) return 'I need at least two earlier months of spending before I can say what is normal for you.';
  return `Based on your last ${earlier.length} month${earlier.length === 1 ? '' : 's'}, this is what you usually spend:\n\n`
    + normals.map(c=>`• ${c.category}: usually ${usualText(c)} a month — ${isCurrentMonth ? 'so far this month' : 'that month'} ${fmt(c.now)}`).join('\n');
}
function copilotSubsText(){
  const subs = subscriptionInsight(copilotMonthContext().isCurrentMonth);
  return subs ? `${subs.title}\n${subs.why}${subs.goal ? '\n' + subs.goal : ''}` : 'I have not spotted any charge that repeats every month yet.';
}

function copilotChatAnswer(text){
  if(/reset (alerts|insights)|unignore|un-ignore|bring .*back|restore|show everything/.test(text)) return copilotResetText();
  if(/show hidden|what.*hidden|hidden|ignored/.test(text)) return copilotHiddenText();
  if(/notice|unusual|anomal|what changed|changed this month|insight|alert/.test(text)) return copilotNoticedText();
  if(/income pattern|payday|when .*(paid|paycheck|income)/.test(text)) return copilotPatternsText();
  if(/subscription|recurring|repeat/.test(text)) return copilotSubsText();
  if(/normal|usual|typical/.test(text)) return copilotNormalsText();
  return null;
}

function copilotAnswer(q){
  const text=String(q||'').toLowerCase(); const s=copilotStats();
  const noticed = copilotChatAnswer(text);
  if(noticed) return noticed;
  if(!s.rows.length)return 'I need some transaction history before I can give you a useful financial answer. Start by adding a few income and expense records or importing a statement.';
  const amountMatch=text.match(/(?:\$|cad\s*)?(\d+(?:\.\d{1,2})?)/); const amount=amountMatch?Number(amountMatch[1]):null;
 
  if(/afford|buy|purchase|spend .*\$/.test(text)){
    const month = leftThisMonth();
    const goalNeed = round2(advisorGoalMonthlyNeed());
    const buffer = round2(Math.max(50, s.avgIncome * 0.05));
    const basis = month.hasData ? month.left : round2(s.avgNet);
    const basisText = month.hasData
      ? `You have ${fmt(basis)} left this month (${fmt(month.income)} in, ${fmt(month.out)} out)`
      : `Nothing is recorded for this month yet, so I am going by your recent average leftover of ${fmt(basis)}`;
    const flexible = round2(basis - goalNeed - buffer);
    const commitments = `${goalNeed > 0 ? ` After ${fmt(goalNeed)} for your goals this month and a ${fmt(buffer)} buffer, about ${fmt(Math.max(0, flexible))} is free to spend.` : ` Keeping a ${fmt(buffer)} buffer, about ${fmt(Math.max(0, flexible))} is free to spend.`}`;
    if(!amount) return `${basisText}.${commitments} Tell me an amount, such as “can I afford $60?”, and I'll check it.`;
    if(basis <= 0) return `${basisText}, so a ${fmt(amount)} purchase would put you further behind this month. I'd wait for your next income.`;
    if(amount <= flexible) return `Yes. ${basisText}.${commitments} A ${fmt(amount)} purchase fits with ${fmt(round2(flexible - amount))} to spare.`;
    if(amount <= basis - goalNeed) return `Probably yes, but it eats into your safety buffer. ${basisText}.${commitments} A ${fmt(amount)} purchase still leaves your goal money untouched.`;
    if(amount <= basis){
      // The goals may already be short before this purchase, so don't blame the purchase for all of it.
      const shortNow = round2(goalNeed - basis), shortAfter = round2(goalNeed - (basis - amount));
      return shortNow > 0
        ? `It fits what's left, but your goals are already short this month. ${basisText}, and they need ${fmt(goalNeed)} — ${fmt(shortNow)} more than you have. Spending ${fmt(amount)} would widen that gap to ${fmt(shortAfter)}.`
        : `It fits what's left, but it takes from money your goals need. ${basisText}, and your goals need ${fmt(goalNeed)} this month. Spending ${fmt(amount)} would leave ${fmt(round2(basis - amount))}, which is ${fmt(shortAfter)} short for them.`;
    }
    return `Not this month. ${basisText}, so a ${fmt(amount)} purchase is ${fmt(round2(amount - basis))} more than you have left.`;
  }
  if(/save|saving|goal/.test(text)&&amount){
    const months=Math.max(1,Number((text.match(/(\d+)\s*(?:month|months)/)||[])[1]||3)); const needed=amount/months;
    return `To save ${fmt(amount)} in ${months} month${months===1?'':'s'}, you would need about ${fmt(needed)} per month. Your recent average leftover is about ${fmt(s.avgNet)} per month. ${needed<=s.avgNet?'That target is within your recent average leftover.':'That target is above your recent average leftover, so Ledger would focus on flexible spending or additional income.'}`;
  }
  if(/where.*spend|spending.*most|largest|category/.test(text)){
    if(!s.ranked.length)return 'I do not have enough categorized expenses yet.';
    const top=s.ranked.slice(0,3).map(([c,v])=>`${c}: ${fmt(v)}`).join(' • '); return `Your largest recorded spending categories are ${top}. Start with the largest flexible category rather than cutting essentials blindly.`;
  }
  if(/next month|forecast|predict|future/.test(text)){
    const rows=s.rows; const last=rows[rows.length-1]; return `Ledger's current baseline is about ${fmt(s.avgIncome)} income and ${fmt(s.avgExpense)} spending per month based on your recent history. ${last?`Your latest recorded month was ${last.month}, with ${fmt(last.income)} income and ${fmt(last.expense)} spending. `:''}The Next month card on the Goals tab has the full forecast, which sharpens once you have four months of history.`;
  }
  if(/best move|what should i do|what.*do now|advice|recommend/.test(text)){
    if(s.avgNet<0)return `Your recent average cash flow is negative by ${fmt(Math.abs(s.avgNet))}/month. Your best first move is to review the largest flexible category and recurring costs.`;
    const top=s.ranked[0]; return `Your recent average leftover is about ${fmt(s.avgNet)}/month. Protect part of it for goals first; ${top?`your largest recorded category is ${top[0]} at ${fmt(top[1])}, so even a modest reduction there could create more room.`:''}`;
  }
  if(/balance|leftover|cash flow|income|expense/.test(text))return `Your recent average is about ${fmt(s.avgIncome)} income, ${fmt(s.avgExpense)} spending, and ${fmt(s.avgNet)} leftover per month. These are averages from your recorded history, not guaranteed future amounts.`;
  return `I can help with affordability, saving targets, spending reductions, forecasts, anomalies, and your next best move. Try “Can I afford $100?” or “How can I save $500?”`;
}
function initShortcutsAndOffline(){
  document.querySelectorAll('[data-copilot]').forEach(b=>b.addEventListener('click',()=>{openLedgerAssistant();setTimeout(()=>{const v=b.dataset.copilot;ledgerChatbot.inputEl.value=v;document.getElementById('chatSendBtn').click();},50);}));
  if('serviceWorker' in navigator && location.protocol!=='file:') navigator.serviceWorker.register('./sw.js').catch(()=>{});
}

initShortcutsAndOffline();


function renderDonut(parts, total){
  const r = 52, stroke = 12, circumference = 2 * Math.PI * r, gap = 8;
  const shown = parts.filter(([, value])=>value > 0);
  const ring = (color, extra = '') => `<circle cx="60" cy="60" r="${r}" style="stroke:var(--${color})"${extra}/>`;
  let html, start = 0;
  if(!shown.length) html = ring('line');
  else if(shown.length === 1) html = ring(shown[0][2]);
  else html = shown.map(([, value, color])=>{
    const length = value / total * circumference;
    // Round ends stick out half the stroke width on each side, so shorten the dash to keep the gap.
    const dash = Math.max(0.01, length - gap - stroke);
    const svg = ring(color, ` stroke-dasharray="${dash.toFixed(2)} ${circumference.toFixed(2)}" stroke-dashoffset="${(-(start + (gap + stroke) / 2)).toFixed(2)}"`);
    start += length;
    return svg;
  }).join('');
  document.getElementById('donutSegments').innerHTML = html;
  document.getElementById('donutChart').setAttribute('aria-label', total > 0
    ? 'Spending split: ' + parts.map(([label, value])=>`${label} ${Math.round(value / total * 100)}%`).join(', ')
    : 'No spending tracked yet');
}


function renderTargetBars(income, byType, target){
  const box = document.getElementById('targetBars');
  box.hidden = income <= 0;
  if(income <= 0){ box.innerHTML = ''; return; }
  box.innerHTML = [['Needs','Need','need'], ['Wants','Want','want'], ['Savings','Savings','save']].map(([label, type, color])=>{
    const amount = byType[type], goal = target[type], saving = type === 'Savings';
    const ok = saving ? amount >= goal : amount <= goal;
    const note = saving ? (ok ? 'target reached' : `${fmt(goal - amount)} to go`) : (ok ? `${fmt(goal - amount)} left` : `${fmt(amount - goal)} over`);
    const pct = goal > 0 ? Math.min(100, amount / goal * 100) : (amount > 0 ? 100 : 0);
    return `<div class="tbar"><div class="tbar-top"><span>${label}</span><em>${fmt(amount)} of ${fmt(goal)}</em><strong class="${ok ? 'good' : 'warn'}">${note}</strong></div>`
      + `<div class="tbar-track" role="img" aria-label="${label}: ${fmt(amount)} of ${fmt(goal)}, ${note}"><span class="tbar-fill" style="width:${pct}%;background:${!saving && !ok ? 'var(--orange)' : `var(--${color})`}"></span></div></div>`;
  }).join('');
}

/* ========================= CALENDAR ========================= */
function calIso(y, m, d){ return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }
function calToday(){ const n = new Date(); return calIso(n.getFullYear(), n.getMonth()+1, n.getDate()); }
function calDayNum(iso){ return Date.UTC(+iso.slice(0,4), +iso.slice(5,7)-1, +iso.slice(8,10)) / 86400000; }
function calAddDays(iso, days){ return new Date((calDayNum(iso) + days) * 86400000).toISOString().slice(0,10); }
function medianOf(values){ const v = values.slice().sort((a,b)=>a-b), mid = Math.floor(v.length/2); return v.length % 2 ? v[mid] : (v[mid-1] + v[mid]) / 2; }
function longDate(iso, opts = {weekday:'long', month:'long', day:'numeric'}){ return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, opts); }
function shortMoney(n){ const a = Math.abs(n), sign = n < 0 ? '-$' : '$'; return a >= 1000 ? sign + (a/1000).toFixed(a >= 10000 ? 0 : 1).replace(/\.0$/,'') + 'k' : sign + Math.round(a); }
function whenText(iso){
  const d = calDayNum(iso) - calDayNum(calToday());
  return d === 0 ? 'today' : d === 1 ? 'tomorrow' : d === -1 ? 'yesterday' : d < 0 ? `${-d} days ago` : `in ${d} days`;
}

function renderCalendar(patterns = incomePatterns()){
  const {year, month} = currentPeriod();
  if(year && month){ cal.year = year; cal.month = month; }
  if(!cal.year){ const n = new Date(); cal.year = n.getFullYear(); cal.month = n.getMonth()+1; }
  const first = calIso(cal.year, cal.month, 1), isMonth = cal.mode === 'month';
  const monthBtn = document.getElementById('calMonthBtn');
  monthBtn.textContent = longDate(first, {month:'short'});
  monthBtn.setAttribute('aria-pressed', String(isMonth));
  document.getElementById('calYearBtn').setAttribute('aria-pressed', String(!isMonth));
  document.getElementById('calTitle').textContent = isMonth ? longDate(first, {month:'long', year:'numeric'}) : String(cal.year);
  document.getElementById('calPrev').setAttribute('aria-label', isMonth ? 'Previous month' : 'Previous year');
  document.getElementById('calNext').setAttribute('aria-label', isMonth ? 'Next month' : 'Next year');
  document.getElementById('calGrid').hidden = !isMonth;
  document.getElementById('calDay').hidden = !isMonth;
  document.getElementById('calYear').hidden = isMonth;
  if(!isMonth){ renderCalendarYear(); return; }

  const days = {};
  const add = (e, kind) => {
    if(!inPeriod(e.date, cal.year, cal.month)) return;
    const t = days[e.date] = days[e.date] || {inc:0, exp:0, items:[]};
    t[kind] += e.amount;
    t.items.push({kind, e});
  };
  state.income.forEach(e=>add(e, 'inc'));
  state.expenses.forEach(e=>add(e, 'exp'));
  const expected = new Set(patterns.map(p=>p.next));
  const today = calToday();
  if(!cal.selected || cal.selected.slice(0,7) !== first.slice(0,7)) cal.selected = today.slice(0,7) === first.slice(0,7) ? today : first;

  const lead = new Date(cal.year, cal.month-1, 1).getDay(), count = new Date(cal.year, cal.month, 0).getDate();
  let html = ['S','M','T','W','T','F','S'].map(d=>`<div class="cal-dow" aria-hidden="true">${d}</div>`).join('') + '<div class="cal-cell blank"></div>'.repeat(lead);
  for(let d = 1; d <= count; d++){
    const iso = calIso(cal.year, cal.month, d), t = days[iso] || {inc:0, exp:0};
    const due = expected.has(iso) && !t.inc;
    const label = [longDate(iso), t.inc && `income ${fmt(t.inc)}`, t.exp && `spent ${fmt(t.exp)}`, due && 'income expected'].filter(Boolean).join(', ');
    html += `<button type="button" class="cal-cell${iso === today ? ' today' : ''}" data-date="${iso}" aria-pressed="${iso === cal.selected}" aria-label="${escapeHtml(label)}">`
      + `<span class="cal-num">${d}</span>${t.exp ? `<span class="cal-amt">${shortMoney(t.exp)}</span>` : ''}`
      + `<span class="cal-dots">${t.inc ? '<i class="dot inc"></i>' : ''}${t.exp ? '<i class="dot exp"></i>' : ''}${due ? '<i class="dot due"></i>' : ''}</span></button>`;
  }
  html += '<div class="cal-cell blank"></div>'.repeat((7 - (lead + count) % 7) % 7);
  const grid = document.getElementById('calGrid');
  grid.innerHTML = html;
  grid.querySelectorAll('[data-date]').forEach(b=>b.addEventListener('click', ()=>{
    if(cal.selected !== b.dataset.date) cal.dayOpen = false;
    cal.selected = b.dataset.date;
    renderCalendar(patterns);
    grid.querySelector(`[data-date="${cal.selected}"]`).focus();
  }));

  const t = days[cal.selected];
  const rows = (t ? t.items : []).map(({kind, e})=>{
    const note = kind === 'exp' && e.description && e.description !== 'Shared expense' ? ` · ${escapeHtml(e.description)}` : '';
    return `<li><span>${kind === 'inc' ? escapeHtml(e.source || 'Income') : escapeHtml(e.category) + note}</span><strong class="${kind === 'inc' ? 'in' : 'out'}">${kind === 'inc' ? '+' : '−'}${fmt(e.amount)}</strong></li>`;
  }).concat(patterns.filter(p=>p.next === cal.selected).map(p=>`<li class="expected"><span>${escapeHtml(p.source)} usually arrives</span><strong class="in">about ${fmt(p.amount)}</strong></li>`));
  // The day's entries fold into a drop-down under the date and totals.
  const box = document.getElementById('calDay');
  const heading = `<span class="cal-day-head"><h3>${longDate(cal.selected)}</h3><span class="cal-day-sum">${t ? `In ${fmt(t.inc)} · Out ${fmt(t.exp)}` : 'Nothing logged on this day.'}</span></span>`;
  if(!rows.length){ box.innerHTML = heading; return; }
  box.innerHTML = `<details class="cal-drop"${cal.dayOpen ? ' open' : ''}><summary>${heading}`
    + `<span class="cal-day-count">${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}</span>`
    + `<svg class="cal-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>`
    + `<ul class="cal-list">${rows.join('')}</ul></details>`;
  box.querySelector('details').addEventListener('toggle', e=>{ cal.dayOpen = e.target.open; });
}

function renderCalendarYear(){
  const now = new Date(), box = document.getElementById('calYear');
  box.innerHTML = Array.from({length:12}, (_, i)=>{
    const m = i+1;
    const inc = state.income.filter(e=>inPeriod(e.date, cal.year, m)).reduce((t,e)=>t+e.amount, 0);
    const exps = state.expenses.filter(e=>inPeriod(e.date, cal.year, m));
    const out = exps.reduce((t,e)=>t+e.amount, 0), left = inc - out - lentOutOf(exps);
    const current = cal.year === now.getFullYear() && m === now.getMonth()+1;
    const body = inc || out
      ? `<span class="in">In ${shortMoney(inc)}</span><span>Out ${shortMoney(out)}</span><span class="${left >= 0 ? 'good' : 'warn'}">Left ${shortMoney(left)}</span>`
      : '<span>No entries</span>';
    return `<button type="button" class="cal-month${current ? ' current' : ''}" data-month="${m}"><strong>${longDate(calIso(cal.year, m, 1), {month:'short'})}</strong>${body}</button>`;
  }).join('');
  box.querySelectorAll('[data-month]').forEach(b=>b.addEventListener('click', ()=>{ cal.mode = 'month'; setCalMonth(cal.year, +b.dataset.month); }));
}


function setCalMonth(year, month){
  const d = new Date(year, month-1, 1);
  cal.year = d.getFullYear(); cal.month = d.getMonth()+1; cal.selected = null;
  jumpToDate(calIso(cal.year, cal.month, 1));
  render();
}
document.getElementById('calPrev').addEventListener('click', ()=> cal.mode === 'month' ? setCalMonth(cal.year, cal.month-1) : setCalMonth(cal.year-1, cal.month));
document.getElementById('calNext').addEventListener('click', ()=> cal.mode === 'month' ? setCalMonth(cal.year, cal.month+1) : setCalMonth(cal.year+1, cal.month));
document.getElementById('calMonthBtn').addEventListener('click', ()=>{ cal.mode = 'month'; renderCalendar(); });
document.getElementById('calYearBtn').addEventListener('click', ()=>{ cal.mode = 'year'; renderCalendar(); });
document.querySelectorAll('[data-cal-add]').forEach(b=>b.addEventListener('click', ()=>{
  const income = b.dataset.calAdd === 'income';
  showTab('budget');
  document.getElementById(income ? 'incDate' : 'expDate').value = (cal.mode === 'month' && cal.selected) || calToday();
  document.getElementById(income ? 'incomeForm' : 'expenseForm').scrollIntoView({block:'center'});
  document.getElementById(income ? 'incSource' : 'expAmount').focus({preventScroll:true});
}));


function incomePatterns(){
  const groups = {};
  state.income.forEach(e=>{
    const source = String(e.source || '').trim();
    if(!source || /^paid back/i.test(source)) return;
    (groups[source.toLowerCase()] = groups[source.toLowerCase()] || []).push(e);
  });
  const today = calDayNum(calToday()), patterns = [];
  Object.entries(groups).forEach(([key, list])=>{
    const items = list.slice().sort((a,b)=>a.date.localeCompare(b.date));
    const days = [...new Set(items.map(e=>calDayNum(e.date)))];
    if(days.length < 3) return;
    const gaps = days.slice(1).map((d,i)=>d - days[i]).slice(-6), gap = medianOf(gaps);
    const schedule = gap >= 6 && gap <= 8 ? 'every week' : gap >= 13 && gap <= 16 ? 'every two weeks' : gap >= 27 && gap <= 32 ? 'every month' : '';
    if(!schedule || gaps.filter(g=>Math.abs(g - gap) <= 4).length < Math.ceil(gaps.length * 0.75)) return;
    const recent = items.slice(-4), last = items[items.length-1];
    let next;
    if(schedule === 'every month'){
      const day = Math.round(medianOf(recent.map(e=>+e.date.slice(8,10))));
      const y = +last.date.slice(0,4), m = +last.date.slice(5,7) + 1;
      const ny = m > 12 ? y+1 : y, nm = m > 12 ? 1 : m;
      next = calIso(ny, nm, Math.min(day, new Date(ny, nm, 0).getDate()));
    }else{
      next = calAddDays(last.date, Math.round(gap));
    }
    if(calDayNum(next) - today < -45) return;   // stopped arriving; not a pattern any more
    patterns.push({key:`${key}|${next}`, source:last.source, schedule, next, amount:medianOf(recent.map(e=>e.amount))});
  });
  return patterns.sort((a,b)=>a.next.localeCompare(b.next));
}

function readStore(key){ try{ return localStorage.getItem(key); }catch(e){ return null; } }
function writeStore(key, value){ try{ localStorage.setItem(key, value); }catch(e){} }


function renderIncomeReminders(){
  const patterns = incomePatterns(), today = calToday();
  const due = patterns.filter(p=>{
    const d = calDayNum(p.next) - calDayNum(today);
    return d <= 1 && d >= -10 && readStore('ledgerSnooze:' + p.key) !== today;
  });
  const box = document.getElementById('incomeReminders');
  box.innerHTML = due.map((p, i)=>`<div class="income-reminder" role="status"><p><strong>💰 Did your ${escapeHtml(p.source)} arrive?</strong><br>It usually comes around ${longDate(p.next, {month:'short', day:'numeric'})} (${whenText(p.next)}), about ${fmt(p.amount)}.</p><div class="reminder-actions"><button class="btn-primary" type="button" data-remind-add="${i}">Yes, add it</button><button class="btn-secondary" type="button" data-remind-snooze="${i}">Not yet</button></div></div>`).join('');
  box.querySelectorAll('[data-remind-add]').forEach(b=>b.addEventListener('click', ()=>addExpectedIncome(due[b.dataset.remindAdd])));
  box.querySelectorAll('[data-remind-snooze]').forEach(b=>b.addEventListener('click', ()=>{
    writeStore('ledgerSnooze:' + due[b.dataset.remindSnooze].key, today);
    renderIncomeReminders();
  }));

  const patternBox = document.getElementById('incomePatterns');
  if(patternBox) patternBox.innerHTML = patterns.length
    ? `<ul class="pattern-list">${patterns.map(p=>`<li><strong>${escapeHtml(p.source)}</strong> · ${p.schedule} · about ${fmt(p.amount)}<small>Next expected ${longDate(p.next, {weekday:'short', month:'short', day:'numeric'})} (${whenText(p.next)})</small></li>`).join('')}</ul>`
    : '<p class="mini-note">No regular income found yet. Once the same income arrives 3 times on a steady schedule, Ledger learns it.</p>';
  notifyIncomeDue(due);
  return patterns;
}


const monthOf = iso => String(iso).slice(0, 7);
function copilotStoreKey(){ return 'ledgerCopilot:' + (currentUser ? currentUser.id : 'guest'); }
function copilotDecisions(){ try{ return JSON.parse(readStore(copilotStoreKey()) || '{}'); }catch(e){ return {}; } }
function saveCopilotDecision(id, action, ym){
  const all = copilotDecisions();
  all[id] = {action, month: ym, at: calToday()};
  writeStore(copilotStoreKey(), JSON.stringify(all));
}


function learnSpending(ym){
  const earlier = [...new Set([...state.income, ...state.expenses].map(e=>monthOf(e.date)))].filter(m=>m < ym).sort().slice(-3);
  const byCat = {};
  state.expenses.forEach(e=>{
    const m = monthOf(e.date);
    if(CAT_TYPE[e.category] === 'Savings' || (m !== ym && !earlier.includes(m))) return;
    const c = byCat[e.category] = byCat[e.category] || {now:[], before:[]};
    (m === ym ? c.now : c.before).push(e);
  });
  const cats = Object.entries(byCat).map(([category, c])=>{
    const monthly = earlier.map(m=>c.before.filter(e=>monthOf(e.date) === m).reduce((t,e)=>t + e.amount, 0));
    const usual = monthly.reduce((a,b)=>a + b, 0) / Math.max(1, earlier.length);
    return {
      category, usual, now: c.now.reduce((t,e)=>t + e.amount, 0), nowItems: c.now,
      low: Math.min(...monthly), high: Math.max(...monthly),
      usualCount: c.before.length / Math.max(1, earlier.length),
      typicalPurchase: c.before.length ? medianOf(c.before.map(e=>e.amount)) : 0,
    };
  });
  return {earlier, cats};
}
function usualText(c){
  const steady = c.low > 0 && c.high - c.low <= c.usual * 0.5 && Math.round(c.low) !== Math.round(c.high);
  return steady ? `${fmt(c.low)}–${fmt(c.high)}` : `about ${fmt(c.usual)}`;
}


function goalImpactText(extraPerMonth, saving){
  const today = new Date();
  const next = (state.goals || []).map(g=>{
    const remaining = Math.max(0, (Number(g.target_amount)||0) - (Number(g.saved_amount)||0));
    const end = new Date(String(g.target_date) + 'T00:00:00');
    const months = Math.max(1, (end.getFullYear() - today.getFullYear()) * 12 + (end.getMonth() - today.getMonth()));
    return {g, remaining, months, need: remaining / months};
  }).filter(x=>x.remaining > 0).sort((a,b)=>String(a.g.target_date).localeCompare(String(b.g.target_date)))[0];
  if(!next || extraPerMonth <= 0) return '';
  const name = escapeHtml(next.g.name);
  if(saving) return `Cancelling the ones you don't use would free up to ${fmt(extraPerMonth)} a month for your ${name} goal.`;
  if(next.need - extraPerMonth <= 0) return `If this continues every month, it would use up the ${fmt(next.need)} a month your ${name} goal needs.`;
  const weeks = Math.round((next.remaining / (next.need - extraPerMonth) - next.months) * 4.35);
  return weeks >= 1
    ? `If this continues, your ${name} goal could be pushed back by about ${weeks} week${weeks === 1 ? '' : 's'}.`
    : `Your ${name} goal is still on schedule, but keep an eye on it.`;
}

function spendingInsights(ym, decisions, isCurrentMonth){
  const {earlier, cats} = learnSpending(ym);
  if(earlier.length < 2) return {learning:true, cats:[], insights:[], ignored:0};
  const ignored = Object.entries(decisions).filter(([id, d])=>id.startsWith('spend:') && d.action === 'ignore').length;
  const threshold = Math.min(1.75, 1.25 + 0.15 * ignored);
  const when = isCurrentMonth ? 'this month' : `in ${longDate(ym + '-01', {month:'long'})}`;
  const insights = cats.filter(c=>c.usual > 0 && c.now > c.usual * threshold && c.now - c.usual >= 20)
    .sort((a,b)=>(b.now - b.usual) - (a.now - a.usual))
    .map(c=>{
      const reasons = [];
      const count = c.nowItems.length, usualCount = Math.max(1, Math.round(c.usualCount));
      if(count >= usualCount + 2) reasons.push(`you made ${count} purchases in ${escapeHtml(c.category)} (usually about ${usualCount})`);
      const biggest = c.nowItems.reduce((b,e)=>e.amount > b.amount ? e : b, c.nowItems[0]);
      if(c.typicalPurchase && biggest.amount >= c.typicalPurchase * 2 && biggest.amount >= 15){
        const note = String(biggest.description || '');
        const where = note && !/^(receipt|shared expense)$/i.test(note) ? ` at ${escapeHtml(note)}` : '';
        reasons.push(`one purchase${where} (${fmt(biggest.amount)}) was much bigger than your typical ${fmt(c.typicalPurchase)}`);
      }
      const why = reasons.length ? reasons.join(', and ') : 'your purchases added up to more than usual';
      return {
        id:`spend:${c.category}`, kind:'spend', tag:`Spending change · ${escapeHtml(c.category)}`,
        title:`Your spending on ${escapeHtml(c.category)} is noticeably higher than usual ${when}.`,
        why:`${why.charAt(0).toUpperCase() + why.slice(1)}. It's usually ${usualText(c)} a month; ${isCurrentMonth ? 'so far' : 'that month it was'} ${fmt(c.now)}.`,
        goal: goalImpactText(c.now - c.usual, false),
        actions:[['noted', 'Got it'], ...(isCurrentMonth ? [['later', 'Remind me next month']] : []), ['ignore', 'Ignore this']],
      };
    });
  return {learning:false, cats, insights, ignored, threshold};
}

// Charges that repeat every month at about the same amount, among flexible (Want) spending.
function subscriptionInsight(isCurrentMonth){
  const groups = {};
  state.expenses.forEach(e=>{
    if(CAT_TYPE[e.category] !== 'Want') return;
    const key = String(e.description || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
    if(!key || /^(receipt|shared expense)$/.test(key)) return;
    (groups[key] = groups[key] || []).push(e);
  });
  const today = calDayNum(calToday());
  const recurring = Object.values(groups).map(list=>{
    const months = new Set(list.map(e=>monthOf(e.date))).size, amount = medianOf(list.map(e=>e.amount));
    const last = list.reduce((a,e)=>e.date > a.date ? e : a, list[0]);
    const steady = list.filter(e=>Math.abs(e.amount - amount) <= Math.max(1, amount * 0.1)).length >= Math.ceil(list.length * 0.75);
    return {name:last.description, amount, months, steady, perMonth:list.length / months, last};
  }).filter(r=>r.months >= 2 && r.steady && r.perMonth <= 1.5 && today - calDayNum(r.last.date) <= 45)
    .sort((a,b)=>b.amount - a.amount);
  if(!recurring.length) return null;
  const total = recurring.reduce((t,r)=>t + r.amount, 0);
  return {
    id:'subs:' + recurring.map(r=>r.name.toLowerCase()).sort().join('|'), kind:'subs', tag:'Recurring charges',
    title:`You have ${recurring.length} recurring charge${recurring.length === 1 ? '' : 's'} totalling about ${fmt(total)} a month. Worth a quick review?`,
    why: recurring.slice(0, 5).map(r=>`${escapeHtml(r.name)} ${fmt(r.amount)}`).join(' · ') + (recurring.length > 5 ? ` · and ${recurring.length - 5} more` : ''),
    goal: goalImpactText(total, true),
    actions:[['noted', 'I need these'], ...(isCurrentMonth ? [['later', 'Remind me next month']] : []), ['ignore', 'Ignore this']],
  };
}


async function addExpectedIncome(p){
  if(!requireSignedIn()) return;
  const answer = prompt(`How much ${p.source} did you get?`, p.amount.toFixed(2));
  if(answer === null) return;
  const amount = Math.round(parseFloat(answer) * 100) / 100;
  if(!Number.isFinite(amount) || amount <= 0){ updateStorageStatus('Enter a valid amount'); return; }
  const entry = {id:crypto.randomUUID(), date:calToday(), source:p.source, amount};
  if(hasTransaction(entry, 'income')){ updateStorageStatus('That income entry already exists'); return; }
  try{
    await insertTransaction(entry, 'income', makeFingerprint('income', entry));
    state.income.push(entry);
    jumpToDate(entry.date);
    render();
    updateStorageStatus('Income saved ✓');
  }catch(err){
    console.error(err);
    updateStorageStatus('Could not save income');
    alert('Could not save income: ' + (err.message || 'Unknown error'));
  }
}

// Browser notifications need the page open (there is no push server), so they fire when
// Ledger is opened or refreshed around payday — once per expected payment.
function notifyIncomeDue(due){
  if(!('Notification' in window) || Notification.permission !== 'granted') return;
  due.forEach(p=>{
    const tag = 'ledgerNotified:' + p.key;
    if(readStore(tag)) return;
    writeStore(tag, '1');
    const title = 'Payday? 💰';
    const options = {body:`Your ${p.source} (about ${fmt(p.amount)}) usually arrives ${whenText(p.next)}. Open Ledger to add it.`, icon:'icon-192.png', tag};
    if(navigator.serviceWorker && navigator.serviceWorker.controller) navigator.serviceWorker.ready.then(r=>r.showNotification(title, options)).catch(()=>{});
    else { try{ new Notification(title, options); }catch(e){} }
  });
}
// Lives in the profile menu: the label shows the current state, and it's only clickable
// while the browser hasn't been asked yet.
function updateNotifyButton(){
  const btn = document.getElementById('notifyBtn'), label = document.getElementById('notifyLabel'), status = document.getElementById('notifyStatus');
  const note = text => { status.textContent = text; status.hidden = !text; };
  if(!('Notification' in window)){
    btn.disabled = true;
    label.textContent = 'Notifications';
    note('This browser can’t show notifications. Payday reminders still appear at the top of Budget.');
    return;
  }
  const permission = Notification.permission;
  btn.disabled = permission !== 'default';
  label.textContent = permission === 'granted' ? 'Notifications are on' : permission === 'denied' ? 'Notifications are blocked' : 'Turn on notifications';
  note(permission === 'granted' ? 'Ledger reminds you around payday when you open it.'
    : permission === 'denied' ? 'Allow notifications for this site in your browser settings.' : '');
}
document.getElementById('notifyBtn').addEventListener('click', async ()=>{
  await Notification.requestPermission();
  updateNotifyButton();
  renderIncomeReminders();
});
updateNotifyButton();

/* ========================= BADGES ========================= */
function longestStreak(){
  const days = [...new Set([...state.income, ...state.expenses].map(e=>calDayNum(e.date)))].sort((a,b)=>a-b);
  let best = days.length ? 1 : 0, run = 1;
  for(let i = 1; i < days.length; i++){ run = days[i] - days[i-1] === 1 ? run + 1 : 1; best = Math.max(best, run); }
  return best;
}

function stayedUnderBudget(){
  const limit = (parseFloat(document.getElementById('tgtNeed').value)||0) + (parseFloat(document.getElementById('tgtWant').value)||0);
  const thisMonth = calToday().slice(0,7), months = {};
  const month = d => months[d.slice(0,7)] = months[d.slice(0,7)] || {income:0, spent:0};
  state.income.forEach(e=>{ month(e.date).income += e.amount; });
  state.expenses.forEach(e=>{ if(CAT_TYPE[e.category] !== 'Savings') month(e.date).spent += e.amount; });
  return Object.entries(months).some(([m, t])=>m < thisMonth && t.income > 0 && t.spent <= t.income * limit / 100);
}

const GOLD = '#F6B93B', GOLD_DARK = '#D98E1A';
const BADGE_ICONS = {
  thumbsUp: `<rect x="8" y="22" width="8" height="17" rx="1.5" fill="#fff"/><path d="M18 22l7-10c1.4-2 4.6-1.2 4.6 1.5V20H37a3 3 0 0 1 2.9 3.7l-3 11.3A3 3 0 0 1 34 37.3H18z" fill="${GOLD}"/>`,
  flame: `<path d="M24 5c2 7 11 11 11 22a11 11 0 0 1-22 0c0-5 3-8 5-10 0 4 2 6 4 6-2-6 0-12 2-18z" fill="${GOLD}"/><path d="M24 26c1.5 3 5 4.5 5 8.5a5 5 0 0 1-10 0c0-2.5 1.5-4 2.5-5 .3 1.8 1.2 2.5 2.2 2.5-.7-2.2-.2-4.3.3-6z" fill="#fff"/>`,
  star: `<path d="M24 6l5.4 11 12.1 1.8-8.8 8.5 2.1 12.1L24 33.7l-10.8 5.7 2.1-12.1-8.8-8.5L18.6 17z" fill="${GOLD}"/><path d="M24 6v27.7l-10.8 5.7 2.1-12.1-8.8-8.5L18.6 17z" fill="${GOLD_DARK}" opacity=".35"/>`,
  medal: `<path d="M14 4h8l4 13h-8z" fill="#fff"/><path d="M34 4h-8l-4 13h8z" fill="${GOLD_DARK}"/><circle cx="24" cy="30" r="13" fill="${GOLD}"/><circle cx="24" cy="30" r="9" fill="${GOLD_DARK}"/><text x="24" y="35" text-anchor="middle" font-family="Nunito,Arial,sans-serif" font-size="14" font-weight="800" fill="#fff">$</text>`,
  crown: `<path d="M7 16l9 7 8-12 8 12 9-7-4 20H11z" fill="${GOLD}"/><rect x="11" y="37" width="26" height="5" rx="1.5" fill="${GOLD_DARK}"/><circle cx="7" cy="15" r="3" fill="${GOLD}"/><circle cx="24" cy="9" r="3" fill="${GOLD}"/><circle cx="41" cy="15" r="3" fill="${GOLD}"/>`,
  shield: `<path d="M24 5l15 5.5v11.5c0 10-6.4 17.5-15 21-8.6-3.5-15-11-15-21V10.5z" fill="${GOLD}"/><path d="M24 5l15 5.5v11.5c0 10-6.4 17.5-15 21z" fill="${GOLD_DARK}" opacity=".45"/><path d="M16.5 24l5.5 5.5 10-11" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,
  trophy: `<path d="M16 11h-6v3a6 6 0 0 0 6 6M32 11h6v3a6 6 0 0 1-6 6" fill="none" stroke="${GOLD}" stroke-width="3.2"/><path d="M15 7h18v10a9 9 0 0 1-18 0z" fill="${GOLD}"/><rect x="21.5" y="25" width="5" height="7" fill="${GOLD_DARK}"/><rect x="15" y="32" width="18" height="4" rx="1" fill="${GOLD}"/><rect x="12" y="36" width="24" height="6" rx="1.5" fill="${GOLD_DARK}"/>`,
  people: `<circle cx="18" cy="16" r="6.5" fill="${GOLD}"/><path d="M5 39c0-7.5 5.8-13 13-13s13 5.5 13 13z" fill="${GOLD}"/><circle cx="32" cy="19" r="5.5" fill="#fff"/><path d="M22 39c.6-6.5 4.8-10.5 10-10.5S41.4 32.5 42 39z" fill="#fff"/>`,
};

function renderBadges(){
  const goals = state.goals || [];
  const saved = goals.reduce((t,g)=>t + (Number(g.saved_amount)||0), 0);
  const streak = longestStreak();
  // [icon, medallion colour, name, earned, what's left to do]
  const badges = [
    ['thumbsUp', 'red', 'First entry', state.income.length + state.expenses.length > 0, 'Add a transaction'],
    ['flame', 'dark', '7 days in a row', streak >= 7, `${Math.min(streak, 7)} of 7 days`],
    ['star', 'light', 'First goal', goals.length > 0, 'Create a savings goal'],
    ['medal', 'red', 'Saved $100', saved >= 100, `$${Math.floor(Math.min(saved, 100))} of $100`],
    ['crown', 'light', 'Saved $1,000', saved >= 1000, `$${Math.floor(saved).toLocaleString()} of $1,000`],
    ['shield', 'dark', 'Stayed under budget', stayedUnderBudget(), 'Finish a month within your Needs + Wants target'],
    ['trophy', 'red', 'Goal reached', goals.some(g=>g.status === 'achieved' || (Number(g.saved_amount)||0) >= (Number(g.target_amount)||0)), 'Reach a savings goal'],
    ['people', 'charcoal', 'Shared a goal', goals.some(g=>currentUser && g.user_id === currentUser.id && (goalMembers[g.id]||[]).length > 0), 'Share a goal with someone'],
  ];
  document.getElementById('badgeCount').textContent = `${badges.filter(b=>b[3]).length} of ${badges.length} earned`;
  document.getElementById('badgeGrid').innerHTML = badges.map(([icon, colour, name, earned, hint])=>
    `<div class="badge${earned ? '' : ' locked'}"><span class="badge-medal ${colour}" aria-hidden="true"><span class="badge-disc"><svg viewBox="0 0 48 48">${BADGE_ICONS[icon]}</svg></span></span>`
    + `<strong>${name}</strong><small>${earned ? 'Earned' : hint}</small></div>`).join('');
}


function showTab(name){
  const panels=[...document.querySelectorAll('[data-panel]')];
  if(!panels.some(p=>p.dataset.panel===name)) name=panels[0].dataset.panel;
  panels.forEach(p=>{p.hidden=p.dataset.panel!==name;});
  document.querySelectorAll('#appTabs [data-tab]').forEach(t=>{
    const on=t.dataset.tab===name;
    t.setAttribute('aria-selected',String(on));
    t.tabIndex=on?0:-1;
  });
  try{localStorage.setItem('ledgerTab',name);}catch(e){}
}
document.querySelectorAll('#appTabs [data-tab], [data-go]').forEach(btn=>btn.addEventListener('click',()=>{
  showTab(btn.dataset.tab||btn.dataset.go);
  window.scrollTo({top:0});
}));
(function(){let saved=null;try{saved=localStorage.getItem('ledgerTab');}catch(e){}showTab(saved||'budget');})();
