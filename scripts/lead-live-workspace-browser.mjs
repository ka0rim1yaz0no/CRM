import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { preview } from 'vite';
const {chromium}=createRequire(process.env.CRM_TEST_RUNTIME_PACKAGE || import.meta.url)('playwright');
const origin='http://localhost:5173';
const server=await preview({envDir:false,build:{outDir:process.argv[2]},preview:{host:'localhost',port:5173,strictPort:true}});
const browser=await chromium.launch({channel:'msedge',headless:true});
const results=[],errors=[];let lastPage;
try {
  await fs.mkdir('outputs/lead-live-workspace-browser',{recursive:true});
  for(const role of ['employee','admin']) for(let i=0;i<6;i++) {
    const business=`synthetic-${i}`,employee={_id:'synthetic-owner',employeeCode:'synthetic-owner-code',name:'Synthetic Sales',role:'Sales',team:'Sales',status:'Active',availabilityStatus:'OFFLINE',aliases:[]};
    const context=await browser.newContext({viewport:i%2?{width:390,height:844}:{width:1440,height:1000}});
    await context.addInitScript(({role,business,employee})=>{
      localStorage.setItem('activeBusinessId',business);
      localStorage.setItem('authUser',JSON.stringify({userType:role,user:role==='admin'?{_id:'synthetic-admin',name:'Synthetic Admin',role:'Admin'}:employee,
        sessionToken:'synthetic-admin-session',attendanceHubSession:'synthetic-session',business:{id:business,name:'Synthetic Business'},allowedBusinesses:[{id:business,name:'Synthetic Business'}]}));
      const click=HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click=function(){if(this.href.startsWith('tel:'))throw new Error('Real phone launch forbidden');return click.call(this);};
    },{role,business,employee});
    const now=new Date().toISOString(),rows=[1,2,3].map(n=>({_id:`synthetic-${n}`,leadName:`Synthetic Contact ${n}`,businessName:`Synthetic Business ${n}`,status:n===1?'Follow up':'NEW',phone:`+1202555012${n}`,
      assignedAgent:employee,assignedAgentName:employee.name,assignmentRevision:1,comments:[],activity:[],createdAt:now,updatedAt:now,followUpAt:n===1?new Date(Date.now()-60000).toISOString():null}));
    let saves=0,queueReads=0,reserves=0,webSocket;
    await context.routeWebSocket('**/socket.io/**',socket=>{webSocket=socket;socket.send('0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');socket.onMessage(message=>{if(typeof message==='string'&&message.startsWith('40'))socket.send('40{"sid":"synthetic"}');});});
    await context.route('**/socket.io/**',route=>route.fulfill({contentType:'text/plain',body:'0{"sid":"synthetic","upgrades":[],"pingInterval":25000,"pingTimeout":20000}'}));
    await context.route('**/api/**',async route=>{
      const req=route.request(),url=new URL(req.url()),path=url.pathname.slice(4);
      const send=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
      if(path==='/call-bridge/reserve'||path==='/call-bridge/dial-start'){reserves++;return send({message:'Calls forbidden'},409);}
      if(path.endsWith('/status')&&req.method()==='PATCH'){
        saves++;const row=rows.find(row=>path===`/leads/${row._id}/status`);assert.ok(row);
        await new Promise(resolve=>setTimeout(resolve,100));row.status=req.postDataJSON().status;row.updatedAt=new Date(Date.now()+saves*1000).toISOString();return send(row);
      }
      if(path==='/my-leads'||path==='/my-leads/dead'||path==='/admin-leads'){
        queueReads++;const tab=path.endsWith('/dead')?'dead':url.searchParams.get('tab')||'my';
        const visible=rows.filter(row=>tab==='dead'?row.status==='Dead':tab==='all'?true:row.status==='NEW'||row.status==='Follow up');
        const next=rows.find(row=>row.status==='Follow up')||rows.find(row=>row.status==='NEW')||null;
        const entries=rows.filter(row=>row.status==='NEW'||row.status==='Follow up').map(row=>({leadId:row._id,callable:true,reason:row.status==='NEW'?'NEW':'SCHEDULED_DUE',normalizedPhone:row.phone,priority:row.status==='NEW'?1:0}));
        return send({leads:visible,total:visible.length,page:1,limit:50,hasMore:false,nextPage:null,stateOptions:[],tab,
          callingQueue:{scope:{employeeId:employee._id,employeeCode:employee.employeeCode,businessId:business},policyVersion:'2026-10-23-authoritative-queue-v7',version:`synthetic-${saves}`,serverTime:new Date().toISOString(),
            nextLead:next,nextLeadId:next?._id||null,nextReason:next?.status==='Follow up'?'SCHEDULED_DUE':'NEW',nextDecision:entries.find(entry=>entry.leadId===next?._id)||null,entries,callingWindow:{permitted:false},nextEligibilityChangeAt:null}});
      }
      const row=rows.find(row=>path===`/leads/${row._id}`);if(row)return send(row);
      if(path==='/employees')return send([employee]);
      if(path===`/employees/${employee._id}`)return send(employee);
      if(path==='/system-settings')return send({employeeLeadMiniTabsEnabled:true,adminLeadMiniTabsEnabled:true});
      if(path.endsWith('/counts'))return send({ALL:rows.length,NEW:rows.filter(row=>row.status==='NEW').length,'Follow up':rows.filter(row=>row.status==='Follow up').length,Dead:rows.filter(row=>row.status==='Dead').length});
      if(path==='/businesses'||path==='/auth/businesses')return send([{id:business,name:'Synthetic Business'}]);
      if(path==='/leads/workspace-capabilities')return send({employeeBulkArchive:false,phoneDeduplication:true});
      return send([]);
    });
    const page=lastPage=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`${origin}/${role==='admin'?'admin/':''}leads?lead=synthetic-1`);
    const status=page.getByRole('combobox',{name:'Lead status',exact:true});await status.waitFor();
    assert.equal(await page.getByRole('link',{name:'WhatsApp lead'}).count(),0);
    if(role==='employee') {
      const indicator=page.getByRole('status').filter({hasText:'Next auto-call:'});await indicator.getByText('Synthetic Contact 1',{exact:false}).waitFor();
      await status.selectOption('Dead');
      assert.equal(await page.getByRole('button',{name:'View next lead',exact:true}).isEnabled(),false,'an actual unsaved status must pause navigation/calling');
    } else await status.selectOption('Dead');
    const statusSection=page.locator('div').filter({has:status}).filter({has:page.getByRole('button',{name:'Save',exact:true})}).last();
    await statusSection.getByRole('button',{name:'Save',exact:true}).click();
    await page.waitForFunction(()=>!document.body.textContent.includes('Updating status...'));
    await page.waitForTimeout(500);
    assert.equal(saves,1);assert.equal(rows[0].status,'Dead');
    if(role==='employee') {
      const indicator=page.getByRole('status').filter({hasText:'Next auto-call:'});await indicator.getByText('Synthetic Contact 2',{exact:false}).waitFor();
      assert.equal(await status.inputValue(),'Dead','saved detail must not fall back to a stale route payload');
      assert.ok(!(await indicator.innerText()).includes('Unsaved lead changes'),'a confirmed save must release the edit guard');
      await page.getByRole('button',{name:'View next lead',exact:true}).click();assert.equal(await status.inputValue(),'NEW');
    }
    await page.reload();await status.waitFor();
    assert.equal(await page.getByRole('link',{name:'WhatsApp lead'}).count(),0);
    const second=rows[1],stale=structuredClone(second);second.status='Dead';second.updatedAt=new Date(Date.now()+5000).toISOString();
    const reads=queueReads;webSocket.send(`42${JSON.stringify(['lead:changed',{action:'status-updated',lead:second}])}`);
    await page.waitForTimeout(700);assert.ok(queueReads>reads,'socket status changes must refresh the server-backed list');
    if(role==='employee')await page.getByRole('status').filter({hasText:'Next auto-call:'}).getByText('Synthetic Contact 3',{exact:false}).waitFor();
    webSocket.send(`42${JSON.stringify(['lead:changed',{action:'status-updated',lead:stale}])}`);
    await page.waitForTimeout(400);
    await page.reload();await status.waitFor();assert.equal(rows[1].status,'Dead');
    if(i<2)await page.screenshot({path:`outputs/lead-live-workspace-browser/${role}-${i?'mobile':'desktop'}.png`,fullPage:true});
    assert.equal(reserves,0);results.push({role,business,statusSaved:true,liveSocketRefresh:true,refreshVerified:true,whatsAppRemoved:true,viewport:page.viewportSize()});await context.close();
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({origin,fixtureOnly:true,realCalls:0,results,errors}));
} catch(error) {
  if(lastPage&&!lastPage.isClosed()){await lastPage.screenshot({path:'outputs/lead-live-workspace-browser/failure.png',fullPage:true});console.error(JSON.stringify({url:lastPage.url(),errors,body:(await lastPage.locator('body').innerText()).slice(0,5000)}));}throw error;
} finally {await browser.close();await server.httpServer.close();}
