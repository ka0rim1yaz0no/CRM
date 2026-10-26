import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.CRM_TEST_RUNTIME_PACKAGE || import.meta.url)('playwright');
const directory=path.resolve(process.argv[2]), origin='https://payroll-payment-fixture.invalid';
const browser=await chromium.launch({channel:'msedge',headless:true}), results=[], errors=[];
try{
 for(let index=0;index<6;index++){
  const business=`payment-review-fixture-${index}`, person={_id:`person-${index}`,employeeCode:`code-${index}`,name:'Synthetic Payment Employee',status:'Active',role:'Sales Agent'};
  const olderRosterApi=index===5,gapAction=olderRosterApi?'Review cutoff':'Generate payroll',gapLabel=olderRosterApi?'Not ready':'Not generated';
  const saved={_id:`payroll-${index}`,employeeId:person.employeeCode,employeeName:person.name,department:'Synthetic',payPeriod:'Oct 6, 2026 - Oct 20, 2026',
   payType:'Semi-monthly',status:'Review',paidOn:'-',grossPay:15000,basicPay:15000,deductions:51.63,netPay:14948.37,minuteRate:2.72,hourlyRate:163.04,
   paidHoursPerDay:8,workedHours:87.65,scheduledHours:88,attendanceDays:11,incompleteShiftDays:1,requiresReview:true,
   ...(index===5?{}:{nonBillableOffPhoneMinutes:11,lateMinutes:8})};
  const frozen=JSON.stringify([saved.grossPay,saved.deductions,saved.netPay,saved.workedHours,saved.incompleteShiftDays]);
  const second={...saved,_id:`second-${index}`,employeeId:`second-code-${index}`,employeeName:'Second Synthetic Employee'};
  const nextPeriod='Oct 21, 2026 - Nov 5, 2026',next={...saved,_id:`next-${index}`,payPeriod:nextPeriod,status:'Pending'};
  let previews=0,saves=0,unexpectedWrites=0,staleRejected=false,conflict=false,currentSaved=true,draftReads=0;
  const context=await browser.newContext({viewport:index%2?{width:390,height:844}:{width:1440,height:1000}});
  await context.addInitScript(({business})=>{
   localStorage.setItem('activeBusinessId',business);localStorage.setItem('authUser',JSON.stringify({userType:'admin',sessionToken:'synthetic-only-admin',
    user:{_id:'synthetic-admin',employeeCode:'synthetic-admin',name:'Synthetic Admin',role:'Admin'},business:{id:business,name:'Synthetic Business'},allowedBusinesses:[{id:business,name:'Synthetic Business'}]}));
  },{business});
  await context.route('**/*',route=>{errors.push('External fixture request blocked');return route.abort();});
  await context.route(`${origin}/**`,async route=>{
   const url=new URL(route.request().url()),file=path.extname(url.pathname)?path.resolve(directory,'.'+url.pathname):path.join(directory,'index.html');
   assert.ok(file.startsWith(directory+path.sep));const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml'};
   return route.fulfill({contentType:mime[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file)});
  });
  await context.routeWebSocket('**/socket.io/**',socket=>{
   socket.send('0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
   socket.onMessage(message=>{if(typeof message==='string'&&message.startsWith('40'))socket.send('40{"sid":"synthetic"}');});
  });
  await context.route('**/api/**',async route=>{
   const request=route.request(),url=new URL(request.url()),endpoint=url.pathname.slice(4),send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   assert.equal(request.headers()['x-business-id'],business);
   if(endpoint==='/payroll/recompute/preview'){
    const input=request.postDataJSON();assert.equal(input.payPeriod,nextPeriod);
    return send({payPeriod:nextPeriod,token:'synthetic-read-only-recompute',totalDifference:0,canApply:true,rows:[{
     employeeCode:person.employeeCode,employeeName:person.name,ownerBusinessId:business,businessIds:[business],before:saved,after:saved,
     difference:0,reviewDays:0,potentialOvertimeHours:0,approvedOvertimeHours:0,
     ...(index===5?{}:{nonBillableOffPhone:{before:{minutes:0,amount:0},after:{minutes:11,amount:29.89},minuteRate:30000/23/8/60}})}]});
   }
   if(endpoint.endsWith('/payment-status/preview')){
    assert.equal(endpoint,`/payroll/records/${saved._id}/payment-status/preview`);const input=request.postDataJSON();assert.equal(typeof input.paid,'boolean');previews++;
    return send({id:saved._id,payPeriod:saved.payPeriod,paid:input.paid,paidOn:input.paid?'Oct 26, 2026':'-',token:`fixture-${previews}`,businessIds:[business],
     canApply:!conflict,blockers:conflict?['Saved cutoff copies have different payroll amounts. Confirm the correct amounts before payment.']:[],
     warnings:['Saved attendance review history is retained; this action changes payment status only.'],
     rows:[{businessId:business,businessName:'Synthetic Business',grossPay:saved.grossPay,deductions:saved.deductions,netPay:saved.netPay,status:saved.status==='Review'?'Pending':saved.status,paidOn:saved.paidOn,savedCopies:2,currentAttendanceReviewDays:0}]});
   }
   if(endpoint.endsWith('/payment-status/confirm')){
    const input=request.postDataJSON();assert.equal(input.token,`fixture-${previews}`);assert.equal(input.confirm,true);assert.equal(input.acknowledgeAttendance,true);assert.ok(input.reason.trim());assert.equal(conflict,false);
    if(index===0&&!staleRejected){staleRejected=true;return send({message:'Payroll changed. Refresh the payment preview.'},409);}
    saves++;Object.assign(saved,{status:input.paid?'Paid':'Pending',paidOn:input.paid?'Oct 26, 2026':'-'});return send({applied:true,businesses:1,records:2});
   }
   if(request.method()!=='GET'){unexpectedWrites++;return send({message:'Unexpected fixture write'},500);}
   if(endpoint==='/payroll/accuracy-config')return send({enabled:true,workedHoursEditingEnabled:true,paymentStatusPreviewEnabled:true,cutoffSelectionEnabled:true,employeeRosterEnabled:!olderRosterApi,automaticPreviewsEnabled:!olderRosterApi});
   if(endpoint==='/payroll/current-previews'){
    assert.equal(olderRosterApi,false);assert.equal(url.searchParams.get('payPeriod'),nextPeriod);draftReads++;
    return send({previewOnly:true,businessId:business,payPeriod:nextPeriod,asOf:'2026-10-26T20:00:00Z',rows:[{
     employeeCode:second.employeeId,employeeName:second.employeeName,department:'Synthetic',warnings:['Cutoff in progress: future shift days are not final deductions.'],
     calculation:{basicPay:15000,monthlySalary:30000,grossPay:15000,deductions:51.63,netPay:14948.37,hourlyRate:30000/23/8,minuteRate:30000/23/8/60,
      paidHoursPerDay:8,attendanceDays:3,workedHours:23.65,nonBillableOffPhoneMinutes:11,nonBillableOffPhoneDeduction:29.89,incompleteShiftDays:0,scheduledDays:8,
      deductionDetails:[{label:'Late',minutes:8,amount:21.74},{label:'Non-billable Off the Phone',minutes:11,amount:29.89}]}}]});
   }
   if(endpoint==='/payroll/cutoffs')return send({defaultPayPeriod:nextPeriod,currentPayPeriod:nextPeriod,historyFrom:'2026-10-06',items:[
    {payPeriod:nextPeriod,start:'2026-10-21',end:'2026-11-05',recordedEmployees:currentSaved?1:0,visibleEmployees:2},{payPeriod:saved.payPeriod,start:'2026-10-06',end:'2026-10-20',recordedEmployees:2,visibleEmployees:2}]});
   const period=url.searchParams.get('payPeriod')||nextPeriod,records=period===nextPeriod?(currentSaved?[next]:[]):[saved,second];
   if(endpoint==='/payroll/roster-gaps'){
    assert.equal(olderRosterApi,false,'An older live backend must not receive a request for the new endpoint');
    const rows=period===nextPeriod?[...(!currentSaved?[{employeeId:person.employeeCode,employeeName:person.name,email:'',department:'Synthetic',payPeriod:nextPeriod,state:'not-generated'}]:[]),
     {employeeId:second.employeeId,employeeName:second.employeeName,email:'',department:'Synthetic',payPeriod:nextPeriod,state:'not-generated'}]:[];
    return send(rows.filter(row=>(!url.searchParams.get('status')||url.searchParams.get('status')==='Not generated')&&(!url.searchParams.get('search')||row.employeeName.toLowerCase().includes(url.searchParams.get('search').toLowerCase()))));
   }
   if(endpoint==='/payroll/records')return send(records.filter(row=>(!url.searchParams.get('status')||row.status===url.searchParams.get('status')||(row.status==='Review'&&url.searchParams.get('status')==='Pending'))&&(!url.searchParams.get('search')||row.employeeName.toLowerCase().includes(url.searchParams.get('search').toLowerCase()))));
   if(endpoint==='/payroll/stats')return send({payPeriod:period,totalEmployees:2,recordedEmployees:records.length,unrecordedEmployees:2-records.length,totalPayroll:records.reduce((n,r)=>n+r.grossPay,0),totalDeductions:records.reduce((n,r)=>n+r.deductions,0),netPayroll:records.reduce((n,r)=>n+r.netPay,0),paidEmployees:records.filter(r=>r.status==='Paid').length});
   if(endpoint==='/system-settings')return send({currencyCode:'PHP',officialShiftStartTime:'23:00',officialShiftEndTime:'08:00',payrollBillingCycle:'Semi-monthly'});
   if(endpoint==='/employees')return send([person,{_id:`second-person-${index}`,employeeCode:second.employeeId,name:second.employeeName,status:'Active',role:'Sales Agent'}]);
   if(endpoint==='/businesses'||endpoint==='/auth/businesses')return send([{id:business,name:'Synthetic Business'}]);
   return send([]);
  });
  const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/admin/payroll');await page.getByRole('combobox',{name:'Payroll cutoff',exact:true}).waitFor();
  await page.getByRole('button',{name:`${gapAction} for Second Synthetic Employee`,exact:true}).waitFor();assert.equal(await page.locator('tbody tr').count(),2);
  assert.equal(await page.getByRole('combobox',{name:'Payroll cutoff',exact:true}).inputValue(),nextPeriod);
  assert.equal(await page.getByRole('columnheader',{name:'Non-billable Off Phone',exact:true}).count(),0);
  const savedRow=page.locator('tbody tr').filter({hasText:person.name});
  assert.equal(await savedRow.locator('td').count(),9);
  if(!olderRosterApi){
   await page.getByRole('button',{name:'Unsaved previews (1)',exact:true}).click();
   const drafts=page.getByRole('dialog',{name:'Unsaved payroll previews',exact:true});
   await drafts.getByText(second.employeeName,{exact:true}).waitFor();
   assert.equal(await drafts.locator('tbody tr').count(),1);assert.equal(await drafts.getByText(person.name,{exact:true}).count(),0);
   assert.equal(await drafts.getByRole('columnheader',{name:'Non-billable Off Phone',exact:true}).count(),0);
   const deductions=drafts.locator('tbody tr td').nth(2);await deductions.getByText('Deduction breakdown',{exact:true}).click();
   await deductions.getByText('Non-billable Off the Phone (11 min)',{exact:true}).waitFor();assert.match(await deductions.innerText(),/29\.89/);
   assert.equal(await drafts.getByRole('button',{name:/Confirm|Mark.*paid|Save/}).count(),0,'automatic previews must never have a saving or payment action');
   await drafts.getByText('Provisional / review',{exact:true}).click();await drafts.getByText('Cutoff in progress: future shift days are not final deductions.',{exact:true}).waitFor();
   await drafts.getByText('Paid hours / day',{exact:true}).waitFor();await drafts.getByText('8h',{exact:true}).waitFor();
   const readsBefore=draftReads;await drafts.getByRole('button',{name:'Refresh unsaved previews',exact:true}).click();
   await page.waitForFunction(()=>!document.querySelector('[aria-label="Refresh unsaved previews"]').disabled);assert.ok(draftReads>readsBefore);
   assert.ok(await drafts.evaluate(element=>element.scrollWidth<=element.clientWidth+1));
   if(index<2){await fs.mkdir('outputs/payroll-auto-preview-browser',{recursive:true});await page.screenshot({path:`outputs/payroll-auto-preview-browser/${index?'mobile':'desktop'}.png`,fullPage:true});}
   await drafts.getByRole('button',{name:'Close unsaved previews',exact:true}).click();
   assert.equal(saves,0);assert.equal(unexpectedWrites,0);
  }
  const gapRow=page.locator('tbody tr').filter({hasText:second.employeeName});assert.match(await gapRow.innerText(),new RegExp(gapLabel));assert.doesNotMatch(await gapRow.innerText(),/15,000|14,948|\b0h\b/);
  assert.equal(await gapRow.getByRole('checkbox').isEnabled(),false);assert.equal(await gapRow.getByRole('button',{name:/paid|payslip|Edit hours/}).count(),0);
  await page.getByRole('combobox',{name:'Payroll cutoff',exact:true}).selectOption(saved.payPeriod);
  await page.getByRole('button',{name:'Mark Second Synthetic Employee paid',exact:true}).waitFor();assert.equal(await page.locator('tbody tr').count(),2);
  await page.reload();await page.getByRole('button',{name:'Mark Second Synthetic Employee paid',exact:true}).waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Payroll cutoff',exact:true}).inputValue(),saved.payPeriod);
  await page.getByRole('combobox',{name:'Payroll cutoff',exact:true}).selectOption(nextPeriod);
  await page.getByRole('button',{name:`${gapAction} for Second Synthetic Employee`,exact:true}).waitFor();assert.equal(new URL(page.url()).searchParams.has('payPeriod'),false);
  await page.reload();await page.getByRole('button',{name:`${gapAction} for Second Synthetic Employee`,exact:true}).waitFor();assert.equal(await page.locator('tbody tr').count(),2);
  await page.getByRole('button',{name:'Generate / Recompute cutoff',exact:true}).click();
  const recompute=page.getByRole('dialog',{name:'Generate / Recompute cutoff',exact:true});
  await recompute.getByRole('button',{name:'Preview differences',exact:true}).click();
  assert.equal(await recompute.getByRole('columnheader',{name:'Non-billable Off the Phone',exact:true}).count(),0);
  if(index!==5){const deductionCell=recompute.locator('tbody tr td').nth(2);await deductionCell.getByText('0 / 11 min',{exact:true}).waitFor();await deductionCell.getByText('Included deduction old / new',{exact:true}).waitFor();}
  else await recompute.getByText('Not available',{exact:true}).waitFor();
  assert.equal(await recompute.getByRole('button',{name:'Confirm cutoff',exact:true}).isEnabled(),false);
  assert.ok(await recompute.evaluate(element=>element.scrollWidth<=element.clientWidth+1));
  if(index<2){await fs.mkdir('outputs/payroll-nonbillable-browser',{recursive:true});await page.screenshot({path:`outputs/payroll-nonbillable-browser/${index?'mobile':'desktop'}-preview.png`,fullPage:true});}
  await recompute.getByRole('button',{name:'Close payroll preview',exact:true}).click();
  await page.getByRole('button',{name:'All statuses',exact:true}).click();await page.getByRole('button',{name:gapLabel,exact:true}).click();
  await page.getByText(/Showing\s+1\s+to\s+1\s+of\s+1\s+entries/).waitFor();assert.equal(await page.locator('tbody tr').count(),1);
  await page.getByRole('button',{name:gapLabel,exact:true}).click();await page.getByRole('button',{name:'All statuses',exact:true}).click();
  await page.getByRole('searchbox',{name:'Search payroll section',exact:true}).fill('Second');await page.getByText(/Showing\s+1\s+to\s+1\s+of\s+1\s+entries/).waitFor();
  await page.getByRole('searchbox',{name:'Search payroll section',exact:true}).fill('');await page.getByText(/Showing\s+1\s+to\s+2\s+of\s+2\s+entries/).waitFor();
  if(index===4){currentSaved=false;await page.reload();await page.getByRole('button',{name:`Generate payroll for ${person.name}`,exact:true}).waitFor();assert.equal(await page.locator('tbody tr').count(),2);assert.equal(await page.getByRole('button',{name:/^Mark .* paid$/}).count(),0);currentSaved=true;}
  const open=async paid=>{
   await page.goto(origin+'/admin/payroll?payPeriod='+encodeURIComponent(saved.payPeriod));const row=page.locator('tbody tr').filter({hasText:person.name});await row.waitFor();
   if(saved.status==='Review'){assert.match(await row.innerText(),/Pending/);assert.doesNotMatch(await row.innerText(),/\bReview\b/);}
   await page.getByRole('button',{name:paid?`Mark ${person.name} paid`:`Set ${person.name} unpaid`,exact:true}).click();
   const dialog=page.getByRole('dialog',{name:paid?'Mark payroll paid':'Set payroll unpaid',exact:true});await dialog.waitFor();await dialog.getByText('Saved attendance review history is retained; this action changes payment status only.',{exact:true}).waitFor();return dialog;
  };
  let dialog=await open(true);assert.equal(saves,0);
  assert.match(await dialog.getByText('Saved net pay',{exact:true}).locator('..').innerText(),/14,948.37/);
  assert.equal(await dialog.getByRole('button',{name:'Mark Paid',exact:true}).isEnabled(),false);
  const approve=async paid=>{
   await dialog.getByLabel('Reason',{exact:true}).fill('Synthetic confirmed saved payment amount');
   await dialog.getByRole('checkbox',{name:'I acknowledge the attendance history and approve the saved amounts without recalculating pay.',exact:true}).check();
   await dialog.getByRole('checkbox',{name:'Confirm payment status only; amounts and attendance stay unchanged.',exact:true}).check();
   await dialog.getByRole('button',{name:paid?'Mark Paid':'Set Unpaid',exact:true}).click();
  };
  assert.ok(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1));
  if(index<2){await fs.mkdir('outputs/payroll-payment-browser',{recursive:true});await page.screenshot({path:`outputs/payroll-payment-browser/${index?'mobile':'desktop'}.png`,fullPage:true});}
  await approve(true);
  if(index===0){
   await dialog.getByRole('alert').filter({hasText:'Payroll changed'}).waitFor();assert.equal(saves,0);
   assert.equal(await dialog.getByLabel('Reason',{exact:true}).inputValue(),'Synthetic confirmed saved payment amount');
   await dialog.getByRole('button',{name:'Refresh payment preview',exact:true}).click();
   await dialog.getByRole('checkbox',{name:'I acknowledge the attendance history and approve the saved amounts without recalculating pay.',exact:true}).waitFor();await approve(true);
  }
  await dialog.waitFor({state:'hidden'});assert.equal(saves,1);assert.equal(saved.status,'Paid');
  dialog=await open(false);await approve(false);await dialog.waitFor({state:'hidden'});assert.equal(saved.status,'Pending');assert.equal(saved.paidOn,'-');assert.equal(saves,2);
  if(index===2){
   dialog=await open(true);await page.evaluate(()=>localStorage.setItem('activeBusinessId','different-business'));
   await dialog.getByRole('button',{name:'Refresh payment preview',exact:true}).click();await dialog.getByRole('alert').filter({hasText:'Business changed'}).waitFor();
   assert.equal(await dialog.getByRole('button',{name:'Mark Paid',exact:true}).isEnabled(),false);
   await page.evaluate(value=>localStorage.setItem('activeBusinessId',value),business);await dialog.getByRole('button',{name:'Close payment confirmation',exact:true}).click();
  }
  if(index===3){
   conflict=true;dialog=await open(true);await dialog.getByRole('alert').filter({hasText:'different payroll amounts'}).waitFor();
   assert.equal(await dialog.getByRole('button',{name:'Mark Paid',exact:true}).isEnabled(),false);assert.equal(saves,2);
   await dialog.getByRole('button',{name:'Close payment confirmation',exact:true}).click();
  }
  assert.equal(JSON.stringify([saved.grossPay,saved.deductions,saved.netPay,saved.workedHours,saved.incompleteShiftDays]),frozen);
  assert.equal(unexpectedWrites,0);results.push({business,currentCutoffAndUnsavedRosterVerified:true,cutoffRosterAndRefreshVerified:true,reviewDisplaysAsPending:true,markPaidAndUnpaidVerified:true,refreshVerified:true,amountsUnchanged:true,saves});await context.close();
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({origin,fixtureOnly:true,productionWrites:0,results,errors}));
}finally{await browser.close();}
