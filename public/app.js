let tests=[],test=null,qi=0,answers=[],marked=new Set(),seconds=0,timer=null,violations=0,editId=null,allResults=[],submitted=false;
const $=id=>document.getElementById(id);
const esc=x=>String(x??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

// -----------------------------------------------------------------------------
// Real-site routing: one URL maps to one active page. No page is ever rendered
// on top of another. Uses the browser History API, so URLs remain clean and
// refreshable (the server provides an SPA fallback).
// -----------------------------------------------------------------------------
const ROUTES={
  home:'/', tests:'/assessments', student:'/candidate', instructions:'/instructions',
  exam:'/exam', done:'/submitted', adminLogin:'/admin/login', admin:'/admin',
  editor:'/admin/assessments/new'
};
const PAGE_FOR_PATH={
  '/':'home','/assessments':'tests','/candidate':'student','/instructions':'instructions',
  '/exam':'exam','/submitted':'done','/admin/login':'adminLogin','/admin':'admin','/admin/assessments':'admin','/admin/results':'admin',
  '/admin/assessments/new':'editor'
};
let routeGuardRunning=false;

function normalizePath(path){
  const p=(path||'/').split('?')[0].replace(/\/+$/,'')||'/';
  if(p.startsWith('/admin/assessments/edit')) return '/admin/assessments/new';
  return p;
}

function renderRoute(path=location.pathname){
  const normalized=normalizePath(path);
  const pageId=PAGE_FOR_PATH[normalized]||'home';
  // HARD ROUTE ISOLATION: hide every page using both the hidden property and
  // the active class. This prevents page stacking even if stylesheet rules
  // are cached, delayed, or overridden by another style.
  document.querySelectorAll('.page').forEach(p=>{
    const active=p.id===pageId;
    p.classList.toggle('active',active);
    p.hidden=!active;
    p.setAttribute('aria-hidden',String(!active));
    p.style.display=active?'':'none';
  });
  const page=$(pageId);
  if(page){ page.hidden=false; page.style.display=''; }
  document.body.classList.toggle('exam',pageId==='exam');
  window.scrollTo(0,0);

  if(pageId==='admin'){
    const p=normalizePath(location.pathname);
    const tab=p==='/admin/results'?'resultsTab':p==='/admin/assessments'?'testsTab':'dashboard';
    setAdminTab(tab,false);
    if(!routeGuardRunning) guardAdminRoute();
  }
  if(pageId==='editor' && !routeGuardRunning) guardAdminRoute();
}

function navigate(path,{replace=false}={}){
  const target=path||'/';
  if(location.pathname+location.search!==target){
    history[replace?'replaceState':'pushState']({},'',target);
  }
  renderRoute(target);
}

// Backwards-compatible helper used by the page buttons.
function show(id){navigate(ROUTES[id]||'/');}

window.addEventListener('popstate',()=>renderRoute(location.pathname));
async function api(url,options={}){const r=await fetch(url,{...options,credentials:'include',headers:{'Content-Type':'application/json',...(options.headers||{})}});let d={};try{d=await r.json()}catch{}if(!r.ok)throw Error(d.error||'Request failed');return d}
function toast(message){const el=$('toast');el.textContent=message;el.classList.add('show');clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>el.classList.remove('show'),2400)}
async function loadTests(){try{tests=await api('/api/tests');$('testCount').textContent=`${tests.length} assessment${tests.length===1?'':'s'}`;$('testCards').innerHTML=tests.length?tests.map(t=>`<article class="assessment-card"><div class="assessment-top"><span class="assessment-tag">ACTIVE ASSESSMENT</span><span>◈</span></div><h3>${esc(t.title)}</h3><p>${esc(t.description||'Professional multiple-choice assessment designed to measure knowledge and skills.')}</p><div class="assessment-meta"><div><small>Questions</small><b>${t.questions.length}</b></div><div><small>Duration</small><b>${t.durationMinutes} min</b></div><div><small>Format</small><b>${t.questions.some(q=>q.type==='code_output')?'MCQ + Code':'MCQ'}</b></div></div><button class="button button-primary full" onclick="selectTest('${esc(t.id)}')">View assessment <span>→</span></button></article>`).join(''):'<div class="form-card" style="grid-column:1/-1;text-align:center"><strong>No active assessments</strong><p style="color:var(--muted);font-size:11px">There are no assessments available right now. Please check again later.</p></div>';navigate('/assessments')}catch(e){toast(e.message)}}
function selectTest(id){test=tests.find(x=>x.id===id);if(!test)return;sessionStorage.setItem('securetest.testId',test.id);navigate('/candidate')}
async function startTest(){if(!test)return toast('Please select an assessment first.');const fields=['fullName','collegeName','rollNumber','mobileNumber','semester','branch','course'];if(fields.some(id=>!$(id).value.trim()))return toast('Please complete all candidate details.');if(!/^\d{10}$/.test($('mobileNumber').value.trim()))return toast('Enter a valid 10-digit mobile number.');try{await api(`/api/tests/${encodeURIComponent(test.id)}/check-eligibility`,{method:'POST',body:JSON.stringify({rollNumber:$('rollNumber').value.trim()})});$('instructionName').textContent=test.title;$('instructionDescription').textContent=test.description||'Professional online assessment.';$('instructionQuestions').textContent=test.questions.length;$('instructionDuration').textContent=`${test.durationMinutes} min`;navigate('/instructions')}catch(e){toast(e.message)}}
function beginExam(){if(!test)return toast('Assessment session is missing. Please select the assessment again.');sessionStorage.setItem('securetest.testId',test.id);qi=0;answers=Array(test.questions.length).fill(null);marked.clear();violations=0;submitted=false;seconds=test.durationMinutes*60;$('examTitle').textContent=test.title;navigate('/exam');document.body.classList.add('exam');render();restoreFullscreen();clearInterval(timer);timer=setInterval(()=>{seconds--;clock();if(seconds<=0)submitExam()},1000);clock()}
function clock(){$('timer').textContent=`${String(Math.floor(Math.max(0,seconds)/60)).padStart(2,'0')}:${String(Math.max(0,seconds)%60).padStart(2,'0')}`}
function render(){const q=test.questions[qi],total=test.questions.length;$('qn').textContent=`Question ${qi+1} of ${total}`;$('bigQ').textContent=qi+1;$('sideProgress').textContent=`${qi+1}/${total}`;const pct=Math.round((qi+1)/total*100);$('progress').textContent=`${pct}% complete`;$('bar').style.width=pct+'%';$('question').textContent=q.question;const isCode=q.type==='code_output';$('options').innerHTML=isCode?`<div class="code-question"><div class="code-label">CODE</div><pre class="code-block"><code>${esc(q.codeSnippet||'')}</code></pre><label class="output-label">Your output<textarea id="codeAnswer" class="output-area" rows=6 placeholder="Write the exact output produced by the code...">${esc(answers[qi]||'')}</textarea></label><p class="code-hint">Enter the output exactly as it appears. Extra spaces at the start/end are ignored.</p></div>`:q.options.map((o,i)=>`<button class="answer ${answers[qi]===i?'selected':''}" onclick="choose(${i})"><span class="letter">${String.fromCharCode(65+i)}</span><span class="answer-text">${esc(o)}</span></button>`).join('');if(isCode){const ta=$('codeAnswer');ta.addEventListener('input',()=>{answers[qi]=ta.value;updateExamStats()})}$('markText').textContent=marked.has(qi)?'Marked for review':'Mark for review';$('next').textContent=qi===total-1?'Review & submit →':'Next question →';$('palette').innerHTML=test.questions.map((_,i)=>`<button class="pal ${i===qi?'c':''} ${answers[i]!==null&&String(answers[i]).trim()!==''?'a':''} ${marked.has(i)?'m':''}" onclick="jumpTo(${i})">${i+1}</button>`).join('');updateExamStats()}
function updateExamStats(){$('answered').textContent=answers.filter(v=>v!==null&&String(v).trim()!=='').length;$('marked').textContent=marked.size}

function choose(i){answers[qi]=i;render()}function jumpTo(i){qi=i;render()}function prev(){if(qi>0){qi--;render()}}function next(){if(qi<test.questions.length-1){qi++;render()}else openSubmit()}function mark(){marked.has(qi)?marked.delete(qi):marked.add(qi);render()}
function openSubmit(){$('modal').classList.add('active');$('modal').setAttribute('aria-hidden','false')}function closeModal(){$('modal').classList.remove('active');$('modal').setAttribute('aria-hidden','true')}
async function submitExam(){if(!test||submitted)return;submitted=true;closeModal();clearInterval(timer);try{if(document.fullscreenElement)await document.exitFullscreen()}catch{}const student={fullName:$('fullName').value,collegeName:$('collegeName').value,rollNumber:$('rollNumber').value,mobileNumber:$('mobileNumber').value,semester:$('semester').value,branch:$('branch').value,course:$('course').value};try{const d=await api(`/api/tests/${encodeURIComponent(test.id)}/submit`,{method:'POST',body:JSON.stringify({student,answers,violations})});$('sid').textContent=d.submissionId;sessionStorage.removeItem('securetest.testId');document.body.classList.remove('exam');navigate('/submitted')}catch(e){submitted=false;toast(e.message)}}
async function restoreFullscreen(){if(!document.body.classList.contains('exam')||submitted)return;try{if(!document.fullscreenElement&&document.documentElement.requestFullscreen){await document.documentElement.requestFullscreen();hideFullscreenGuard();}}catch{showFullscreenGuard()}}
function showFullscreenGuard(){$('fullscreenGuard')?.classList.add('active');$('fullscreenGuard')?.setAttribute('aria-hidden','false')}
function hideFullscreenGuard(){$('fullscreenGuard')?.classList.remove('active');$('fullscreenGuard')?.setAttribute('aria-hidden','true')}
document.addEventListener('fullscreenchange',()=>{if(document.body.classList.contains('exam')&&!submitted){if(document.fullscreenElement)hideFullscreenGuard();else{violation();showFullscreenGuard();setTimeout(()=>restoreFullscreen(),50)}}});

function violation(){if(!document.body.classList.contains('exam')||submitted)return;violations++;toast(`Security notice ${violations}/3`);if(violations>=3)submitExam()}
document.addEventListener('visibilitychange',()=>{if(document.hidden)violation()});window.addEventListener('blur',violation);document.addEventListener('contextmenu',e=>{if(document.body.classList.contains('exam'))e.preventDefault()});['copy','cut','paste','dragstart'].forEach(ev=>document.addEventListener(ev,e=>{if(document.body.classList.contains('exam'))e.preventDefault()}));document.addEventListener('keydown',e=>{if(document.body.classList.contains('exam')&&(((e.ctrlKey||e.metaKey)&&['c','v','x','a','s','p','u'].includes(e.key.toLowerCase()))||e.key==='F12'))e.preventDefault()});
async function login(){try{await api('/api/admin/login',{method:'POST',body:JSON.stringify({username:$('au').value,password:$('ap').value})});await adminData();navigate('/admin')}catch(e){toast(e.message)}}
async function logout(){try{await api('/api/admin/logout',{method:'POST'})}finally{location.reload()}}
async function adminData(){try{const[ts,rs]=await Promise.all([api('/api/admin/tests'),api('/api/admin/results')]);tests=ts;allResults=rs;$('kt').textContent=ts.length;$('kr').textContent=rs.length;$('kq').textContent=ts.reduce((a,t)=>a+t.questions.length,0);renderDashboardTests(ts);renderAdminTests(ts);filterResults();$('adminDate').textContent=new Intl.DateTimeFormat('en-IN',{day:'2-digit',month:'short',year:'numeric'}).format(new Date())}catch(e){toast(e.message)}}
function renderDashboardTests(ts){$('dashboardTests').innerHTML=ts.length?ts.slice(0,5).map(t=>`<div class="dash-test"><div><span class="test-icon">▣</span><div><strong>${esc(t.title)}</strong><small>${t.questions.length} questions · ${t.durationMinutes} minutes</small></div></div><span class="assessment-tag">ACTIVE</span></div>`).join(''):'<p style="font-size:10px;color:var(--subtle)">No assessments created yet.</p>'}
function renderAdminTests(ts){$('adminTests').innerHTML=ts.length?ts.map(t=>`<article class="admin-test-row"><div class="admin-test-main"><span class="admin-test-icon">▣</span><div><strong>${esc(t.title)}</strong><small>${t.questions.length} questions · ${t.durationMinutes} minutes · Active</small></div></div><div class="admin-test-actions"><button class="small-button" onclick="editTest('${esc(t.id)}')">Edit</button><button class="small-button delete" onclick="delTest('${esc(t.id)}')">Delete</button></div></article>`).join(''):'<div class="form-card" style="text-align:center"><strong>No assessments yet</strong><p style="font-size:11px;color:var(--muted)">Create your first assessment to get started.</p></div>'}
function setAdminTab(id,refresh=true){
  document.querySelectorAll('.tab').forEach(x=>x.classList.add('hidden'));
  $(id)?.classList.remove('hidden');
  document.querySelectorAll('.side-link').forEach(x=>x.classList.toggle('active',x.dataset.tab===id));
  $('adminCrumb').textContent=id==='dashboard'?'Overview':id==='testsTab'?'Assessments':'Results';
  if(refresh) adminData();
}
function adminTab(id){
  const path=id==='testsTab'?'/admin/assessments':id==='resultsTab'?'/admin/results':'/admin';
  navigate(path);
  adminData();
}
async function guardAdminRoute(){
  if(routeGuardRunning)return;
  routeGuardRunning=true;
  try{
    const d=await api('/api/admin/session');
    const isAdmin=!!d.authenticated;
    const adminPath=location.pathname.startsWith('/admin') && location.pathname!=='/admin/login';
    if(adminPath && !isAdmin) navigate('/admin/login',{replace:true});
    else if(location.pathname==='/admin/login' && isAdmin) navigate('/admin',{replace:true});
  }catch(e){
    if(location.pathname.startsWith('/admin') && location.pathname!=='/admin/login') navigate('/admin/login',{replace:true});
  }finally{routeGuardRunning=false;}
}
function newTest(){editId=null;$('tt').value='';$('td').value=30;$('tx').value='';$('questions').innerHTML='';$('editorHeading').textContent='Create assessment';$('editorMainTitle').textContent='Create a new assessment';addQ();navigate(editId?`/admin/assessments/edit?id=${encodeURIComponent(editId)}`:'/admin/assessments/new')}
function editTest(id){const t=tests.find(x=>x.id===id);if(!t)return;editId=id;$('tt').value=t.title;$('td').value=t.durationMinutes;$('tx').value=t.description||'';$('questions').innerHTML='';$('editorHeading').textContent='Edit assessment';$('editorMainTitle').textContent='Edit assessment';t.questions.forEach(q=>addQ(q));navigate(editId?`/admin/assessments/edit?id=${encodeURIComponent(editId)}`:'/admin/assessments/new')}
function addQ(q={type:'mcq',question:'',options:['','','',''],answer:0,codeSnippet:'',expectedOutput:''}){const d=document.createElement('div');d.className='question-editor';d.innerHTML=`<div class="question-editor-head"><span class="q-label">QUESTION ${document.querySelectorAll('.question-editor').length+1}</span><button class="remove-q" onclick="this.closest('.question-editor').remove()">Remove</button></div><div class="question-type-row"><label>Question type<select class="qt" onchange="toggleQuestionType(this)"><option value="mcq" ${q.type!=='code_output'?'selected':''}>Multiple choice (MCQ)</option><option value="code_output" ${q.type==='code_output'?'selected':''}>Code output</option></select></label></div><label>Question<textarea class="qq" rows=3 placeholder="Enter the question…">${esc(q.question)}</textarea></label><div class="mcq-fields" style="display:${q.type==='code_output'?'none':'block'}"><div class="option-editor">${q.options.map((o,i)=>`<label>Option ${String.fromCharCode(65+i)}<input class="qo" value="${esc(o)}" placeholder="Enter option"></label>`).join('')}</div><label style="max-width:190px">Correct answer<select class="qa">${q.options.map((_,i)=>`<option value="${i}" ${i===q.answer?'selected':''}>Option ${String.fromCharCode(65+i)}</option>`).join('')}</select></label></div><div class="code-fields" style="display:${q.type==='code_output'?'block':'none'}"><label>Code snippet<textarea class="qcode code-editor" rows=8 placeholder="Paste the code students must analyze…">${esc(q.codeSnippet||'')}</textarea></label><label>Expected output<textarea class="qoutput" rows=4 placeholder="Enter the exact expected output…">${esc(q.expectedOutput||'')}</textarea></label></div>`;$('questions').appendChild(d)}
function toggleQuestionType(select){const card=select.closest('.question-editor');const code=select.value==='code_output';card.querySelector('.mcq-fields').style.display=code?'none':'block';card.querySelector('.code-fields').style.display=code?'block':'none'}

async function saveTest(){const title=$('tt').value.trim(),duration=Number($('td').value);const qs=[...document.querySelectorAll('.question-editor')].map(d=>{const type=d.querySelector('.qt').value;if(type==='code_output')return{type,question:d.querySelector('.qq').value.trim(),codeSnippet:d.querySelector('.qcode').value.trim(),expectedOutput:d.querySelector('.qoutput').value.trim()};return{type:'mcq',question:d.querySelector('.qq').value.trim(),options:[...d.querySelectorAll('.qo')].map(x=>x.value.trim()),answer:Number(d.querySelector('.qa').value)}});if(!title)return toast('Enter an assessment title.');if(!duration||duration<1)return toast('Duration must be at least 1 minute.');if(!qs.length)return toast('Add at least one question.');if(qs.some(q=>!q.question))return toast('Complete every question.');if(qs.some(q=>q.type==='mcq'&&q.options.some(o=>!o)))return toast('Complete every MCQ option.');if(qs.some(q=>q.type==='code_output'&&(!q.codeSnippet||!q.expectedOutput)))return toast('Complete the code and expected output.');try{await api('/api/admin/tests',{method:'POST',body:JSON.stringify({id:editId,title,description:$('tx').value.trim(),durationMinutes:duration,questions:qs})});toast('Assessment saved successfully');await adminData();adminTab('testsTab')}catch(e){toast(e.message)}}

async function delTest(id){if(!confirm('Delete this assessment? This cannot be undone.'))return;try{await api(`/api/admin/tests/${encodeURIComponent(id)}`,{method:'DELETE'});await adminData();toast('Assessment deleted')}catch(e){toast(e.message)}}
function filterResults(){const input=$('resultSearch');if(!input)return;const q=input.value.toLowerCase().trim();const rows=allResults.filter(r=>Object.values(r).some(v=>String(v??'').toLowerCase().includes(q)));$('resultCount').textContent=`${rows.length} result${rows.length===1?'':'s'}`;$('results').innerHTML=rows.length?rows.map(r=>`<tr><td><div class="candidate-cell"><strong>${esc(r.Full_Name)}</strong><small>${esc(r.Student_ID||'')}</small></div></td><td><span class="roll-badge">${esc(r.Roll_Number||'—')}</span></td><td>${esc(r.College_Name)}</td><td>${esc(r.Mobile_Number)}</td><td>${esc(r.Semester)}</td><td>${esc(r.Branch)}</td><td>${esc(r.Course)}</td><td>${esc(r.Test_Name)}</td><td>${r.Attempted}/${r.Total_Questions}</td><td>${r.Correct}</td><td>${r.Wrong}</td><td><span class="score">${r.Marks}/${r.Total_Marks}</span></td><td><span class="percent">${r.Percentage}%</span></td></tr>`).join(''):'<tr><td colspan="13" style="text-align:center;padding:28px;color:var(--subtle)">No matching results.</td></tr>'}
function downloadExcel(){location.href='/api/admin/results.xlsx'}
async function deleteStudentData(){if(!confirm('Delete ALL student data? This permanently removes every student, attempt, answer, score, roll number and submission record. Assessments and questions will NOT be deleted. This action cannot be undone.'))return;try{const d=await api('/api/admin/student-data',{method:'DELETE'});toast(`Deleted ${d.deletedStudents||0} student(s), ${d.deletedAttempts||0} attempt(s) and ${d.deletedAnswers||0} answer(s)`);await adminData()}catch(e){toast(e.message)}}
async function hydrateRouteState(){
  // Apply the route before any API calls so the browser never renders several
  // application screens at once.
  const initial=window.__secureTestInitialPage;
  if(initial){
    const initialPath=Object.entries(ROUTES).find(([,v])=>{
      if(initial==='admin') return v==='/admin';
      if(initial==='editor') return v==='/admin/assessments/new';
      return v===location.pathname;
    })?.[1]||location.pathname;
    renderRoute(initialPath);
  }
  const storedId=sessionStorage.getItem('securetest.testId');
  if(storedId && !test){
    try{ test=await api(`/api/tests/${encodeURIComponent(storedId)}`); }catch{}
  }
  renderRoute(location.pathname);
  if(location.pathname==='/assessments') loadTests();
  if(location.pathname.startsWith('/admin')) guardAdminRoute();
}

hydrateRouteState().catch(()=>renderRoute('/'));
