import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const {chromium}=createRequire(process.env.CRM_TEST_RUNTIME_PACKAGE||import.meta.url)('playwright');
const directory=path.resolve(process.argv[2]),origin='https://missing-payroll-fixture.invalid',period='Oct 21, 2026 - Nov 5, 2026';
const browser=await chromium.launch({channel:'msedge',headless:true}),results=[];
try{
 for(let index=0;index<6;index++){
  const business=`missing-fixture-${index}`,saved={_id:'synthetic-paid',employeeId:'saved',employeeName:'Synthetic Paid Employee',payPeriod:period,payType:'Semi-monthly',
   grossPay:15000,deductions:25,netPay:14975,status:'Paid',paidOn:'Oct 26, 2026',department:'Synthetic',workedHours:80};
  const original=JSON.stringify(saved),errors=[];let generation=0,previews=0,unexpectedWrites=0,stale=false;
  const context=await browser.newContext({viewport:index%2?{width:390,height:844}:{width:1440,height:1000}});
  await context.addInitScript(({business})=>{
   localStorage.setItem('activeBusinessId',business);localStorage.setItem('authUser',JSON.stringify({userType:'admin',sessionToken:'synthetic-admin',
    user:{_id:'admin',employeeCode:'admin',name:'Synthetic Admin',role:'Admin'},business:{id:business,name:'Synthetic Business'},allowedBusinesses:[{id:business,name:'Synthetic Business'}]}));
  },{business});
  await context.route('**/*',route=>{errors.push('External request blocked');return route.abort();});
  await context.route(`${origin}/**`,async route=>{
   const url=new URL(route.request().url()),file=path.extname(url.pathname)?path.resolve(directory,'.'+url.pathname):path.join(directory,'index.html');
   assert.ok(file.startsWith(directory+path.sep));return route.fulfill({contentType:{'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml'}[path.extname(file)]||'application/octet-stream',body:await fs.readFile(file)});
  });
  await context.routeWebSocket('**/socket.io/**',socket=>{socket.send('0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');socket.onMessage(message=>{if(typeof message==='string'&&message.startsWith('40'))socket.send('40{"sid":"synthetic"}');});});
  const row={employeeCode:'missing',employeeName:'Synthetic Missing Employee',businessIds:[business],grossPay:15000,deductions:29.89,netPay:14970.11,
   nonBillableOffPhoneMinutes:11,nonBillableOffPhoneDeduction:29.89,incompleteShiftDays:1,scheduledDays:8};
  await context.route('**/api/**',async route=>{
   const request=route.request(),url=new URL(request.url()),endpoint=url.pathname.slice(4),send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   assert.equal(request.headers()['x-business-id'],business);
   if(endpoint==='/payroll/missing/preview'){assert.equal(request.postDataJSON().payPeriod,period);previews++;return send({businessId:business,payPeriod:period,token:`preview-${previews}`,canApply:true,automaticEnabled:false,rows:[row],held:[{employeeCode:'held',employeeName:'Synthetic Held Employee',reason:'An overlapping saved payroll needs review.'}]});}
   if(endpoint==='/payroll/missing/confirm'){
    const input=request.postDataJSON();assert.equal(input.token,`preview-${previews}`);assert.equal(input.confirm,true);assert.equal(input.enableFuture,true);assert.ok(input.reason.trim());
    if(index===0&&!stale){stale=true;return send({message:'Payroll or attendance changed. Preview missing payroll again.'},409);}
    generation++;return send({created:1,mirrors:1,automaticEnabled:true});
   }
   if(request.method()!=='GET'){unexpectedWrites++;return send({message:'Unexpected write'},500);}
   if(endpoint==='/payroll/accuracy-config')return send({enabled:true,cutoffSelectionEnabled:true,employeeRosterEnabled:true,missingGenerationEnabled:true});
   if(endpoint==='/payroll/cutoffs')return send({currentPayPeriod:period,defaultPayPeriod:period,historyFrom:'2026-10-06',items:[{payPeriod:period,start:'2026-10-21',end:'2026-11-05',recordedEmployees:generation?2:1,visibleEmployees:3}]});
   if(endpoint==='/payroll/records')return send(generation?[saved,{...saved,_id:'new',...row,employeeId:row.employeeCode,status:'Review'}]:[saved]);
   if(endpoint==='/payroll/roster-gaps')return send(generation?[]:[{employeeId:'missing',employeeName:row.employeeName,email:'',department:'Synthetic',payPeriod:period,state:'not-generated'}]);
   if(endpoint==='/payroll/stats')return send({totalEmployees:3,recordedEmployees:generation?2:1,unrecordedEmployees:generation?1:2,grossPayroll:15000,totalDeductions:25,netPayroll:14975,paidEmployees:1});
   if(endpoint==='/system-settings')return send({currencyCode:'PHP',payrollBillingCycle:'Semi-monthly'});
   if(endpoint==='/businesses')return send([{id:business,name:'Synthetic Business'}]);
   if(endpoint==='/branding')return send({});
   if(endpoint.startsWith('/employees'))return send([]);
   return send([]);
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${origin}/admin/payroll`);await page.getByRole('button',{name:'Generate missing',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Generate missing payroll'});await dialog.getByText(row.employeeName,{exact:true}).waitFor();
  assert.equal(await dialog.getByRole('columnheader',{name:'Non-billable Off Phone',exact:true}).count(),0);
  assert.ok(await dialog.getByText('11 min / ₱29.89',{exact:true}).isVisible());
  assert.ok(await dialog.locator('tbody tr td').nth(1).getByText('11 min / ₱29.89',{exact:true}).isVisible());
  assert.ok(await dialog.getByText(/overlapping saved payroll/).isVisible());
  const save=dialog.getByRole('button',{name:'Generate missing payroll',exact:true});assert.equal(await save.isEnabled(),false);
  await dialog.getByRole('checkbox',{name:/Automatically generate/}).check();await dialog.getByRole('textbox',{name:'Audit reason'}).fill('Synthetic reviewed missing-only generation');
  await dialog.getByRole('checkbox',{name:/I confirm/}).check();await save.click();
  if(index===0){await dialog.getByRole('alert').waitFor();assert.equal(await save.isEnabled(),false);await dialog.getByRole('button',{name:'Refresh missing payroll preview'}).click();await dialog.getByText(row.employeeName,{exact:true}).waitFor();await dialog.getByRole('checkbox',{name:/I confirm/}).check();await save.click();}
  await dialog.waitFor({state:'hidden'});assert.equal(generation,1);assert.equal(JSON.stringify(saved),original);
  await page.reload();assert.equal(JSON.stringify(saved),original);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  assert.equal(unexpectedWrites,0);assert.deepEqual(errors,[]);
  await fs.mkdir('outputs/payroll-missing-generation-browser',{recursive:true});
  await page.screenshot({path:`outputs/payroll-missing-generation-browser/business-${index}.png`});
  results.push({business,refreshed:true,savedPayrollUnchanged:true,duplicateWrites:0,stalePreviewRejected:index===0?stale:null});await context.close();
 }
 console.log(JSON.stringify({businesses:results.length,results,productionWrites:0}));
}finally{await browser.close();}
