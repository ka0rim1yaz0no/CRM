import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import {after, before, beforeEach, test, type TestContext} from "node:test";
import mongoose from "mongoose";
import {MongoMemoryReplSet} from "mongodb-memory-server";
import {fixedHalfSalaryVersion} from "../../../shared/payrollEarnings";
import {payrollDeductionDisplayTotal, payrollDeductionRows} from "../../../shared/payrollPresentation";
import type {SessionEvent} from "./attendanceSessionState";

const root=`fixed_half_${crypto.randomUUID().replaceAll("-", "")}`,businesses=Array.from({length:7},(_,index)=>`fixed-${index}`);
Object.assign(process.env,{NODE_ENV:"test",CRM_SECURITY_LEGACY_AUTH:"true",CRM_PAYROLL_ACCURACY:"true",CRM_ATTENDANCE_DURATION_MODEL:"true",
 CRM_ATTENDANCE_INTEGRITY:"true",CRM_ATTENDANCE_ACCURACY_FIXES:"true",CRM_ATTENDANCE_AUTO_TIMEOUT:"false",CRM_ADMIN_ONE_CODE:"90000001",
 CRM_ADMIN_SESSION_SECRET:crypto.randomBytes(48).toString("base64"),CRM_EARNED_PAYROLL_FROM:"2026-10-06",CRM_EARNED_ALL_DEDUCTIONS_FROM:"2026-10-06",
 CRM_EARNED_EXCLUDE_UNDERTIME_ABSENCE_FROM:"2026-10-06",CRM_FIXED_HALF_SALARY_FROM:"2026-10-06",CRM_OFF_PHONE_PAID_LIMIT_FROM:"2026-10-01T00:00:00Z",
 DEFAULT_BUSINESS_ID:businesses[0],DEFAULT_BUSINESS_DATABASE:root+"_0",CONTROL_DATABASE_NAME:root+"_control",
 BUSINESS_DATABASES:JSON.stringify(businesses.map((id,index)=>({id,name:`Synthetic Fixed ${index}`,databaseName:root+"_"+index})))});
const {createApp}=await import("../app"),{runWithBusiness}=await import("../config/tenancy");
const {Employee}=await import("../models/Employee"),{Attendance}=await import("../models/Attendance"),{PayrollRecord}=await import("../models/Payroll");
const {AttendanceLedger,AttendancePolicy}=await import("../models/AttendanceLedger"),{SystemSettings}=await import("../models/SystemSettings");
const {EmployeePaymentHistoryPolicy}=await import("../models/EmployeePaymentHistoryPolicy");
const {setBusinessAccessForEmployeeCode}=await import("../models/BusinessUserAccess"),{createAdminDashboardSession}=await import("../config/adminDashboardSession");
const {assignAttendanceShift}=await import("./attendanceShift"),{calculatePayrollCandidate}=await import("./payrollRecomputeService");
const {employeePayments}=await import("./employeePayments"),{getCallBridgeScheduleModel}=await import("../models/CallBridge");
const {previewPayrollWorkedHours}=await import("./payrollWorkedHoursService");
const code="synthetic-fixed-employee",now=new Date("2026-11-10T02:00:00Z"),period="Oct 21, 2026 - Nov 5, 2026";
let mongo:MongoMemoryReplSet,server:http.Server,base="",admin="",owners:mongoose.Types.ObjectId[]=[];
before(async()=>{
 mongo=await MongoMemoryReplSet.create({replSet:{count:1},instanceOpts:[{args:["--wiredTigerCacheSizeGB","0.25"]}]});
 const uri=mongo.getUri(root);assert.equal(new URL(uri).hostname,"127.0.0.1");await mongoose.connect(uri,{maxPoolSize:2});
 server=http.createServer(createApp());await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api`;admin=createAdminDashboardSession("90000001")!;
});
after(async()=>{server?.closeAllConnections();server?.close();await mongoose.disconnect();await mongo?.stop();});
beforeEach(async()=>{
 owners=[];process.env.CRM_FIXED_HALF_SALARY_FROM="2026-10-06";delete process.env.CRM_EQUAL_HALF_CUTOFF_FROM;
 await AttendanceLedger.deleteMany({});await AttendancePolicy.deleteMany({});
 await AttendancePolicy.create({_id:"global-attendance",revision:1,shiftStart:"23:00",shiftEnd:"08:00",breakMinutes:15,lunchMinutes:60,graceMinutes:5});
 for(const business of businesses)await runWithBusiness(business,async()=>{
  await Employee.deleteMany({});await Attendance.deleteMany({});await PayrollRecord.deleteMany({});await SystemSettings.deleteMany({});await EmployeePaymentHistoryPolicy.deleteMany({});
  await SystemSettings.create({key:"system",payrollBillingCycle:"Semi-monthly",officialShiftStartTime:"23:00",officialShiftEndTime:"08:00",
   payrollFirstCutoffStartDay:6,payrollFirstCutoffEndDay:20,payrollFirstCutoffPayDay:25,payrollSecondCutoffStartDay:21,payrollSecondCutoffEndDay:5,payrollSecondCutoffPayDay:10});
  const employee=await Employee.create({employeeCode:code,name:"Synthetic Fixed Employee",role:"Sales",team:"Synthetic",status:"Active",salary:1000});owners.push(employee._id);
  await EmployeePaymentHistoryPolicy.create({_id:"employee-payment-history",fromDate:"2026-10-06",initialPayPeriod:period,activatedAt:new Date("2026-10-01T00:00:00Z")});
 });await setBusinessAccessForEmployeeCode(code,businesses);
});
async function fixture(options:{start?:string;end?:string;period?:string;mixed?:boolean;absent?:boolean;allAbsent?:boolean;outsideRest?:boolean;future?:boolean;status?:"Pending"|"Paid"|"Completed";overtime?:boolean;earlyIn?:boolean;shortDay?:boolean}={}){
 const label=options.period||period,start=options.start||"2026-10-21",end=options.end||"2026-11-05",events:SessionEvent[]=[];let dayIndex=0;
 for(let at=Date.parse(start+"T00:00:00Z");at<=Date.parse(end+"T00:00:00Z");at+=86400000){
  const date=new Date(at);if([0,6].includes(date.getUTCDay())||options.allAbsent)continue;
  const shift=Date.parse(date.toISOString().slice(0,10)+"T15:00:00Z");if(options.future&&shift+9*3600000>+now)continue;
  if(options.absent&&dayIndex++===0)continue;
  const mixed=options.mixed&&dayIndex===0;
  const pattern:Array<[SessionEvent["source"],number]>=[
   ["Time In",options.earlyIn?-120:mixed?10:0],["Break Out",60],["Break In",mixed?77:75],["Lunch Break Out",240],["Lunch Break In",mixed?303:300],
   ["Off the Phone Out",330],["Off the Phone In",350],["Non-Billable Off the Phone Out",360],["Off the Phone In",mixed?365:360],
   ["Coaching Out",390],["Coaching In",480],["Time Out",mixed?530:545]];
  if(options.outsideRest&&dayIndex===0){pattern.splice(1,2);pattern.splice(pattern.length-1,0,["Break Out",525],["Break In",545]);}
  if(options.shortDay&&dayIndex===0)pattern.splice(0,pattern.length,["Time In",0],["Off the Phone Out",5],["Off the Phone In",10],["Off the Phone Out",15],["Off the Phone In",20],["Time Out",38]);
  for(const[source,minute]of pattern){const sequence=events.length,stamp=new Date(shift+minute*60000);events.push({id:`fixed-${sequence}`,commandId:`fixed-${sequence}`,sequence,
   source,at:stamp.toISOString(),recordedAt:stamp.toISOString(),...(source==="Time In"?{shift:assignAttendanceShift(new Date(shift))}:{})});}dayIndex++;
 }
 await AttendanceLedger.create({_id:"synthetic-fixed-ledger",employeeCode:code,businessIds:businesses,canonicalBusinessId:businesses[0],revision:1,events});
 for(const[index,business]of businesses.entries())await runWithBusiness(business,async()=>{
  await Attendance.insertMany(events.map(event=>({employee:owners[index],source:event.source,timeIn:new Date(event.at),eventId:event.id,sequence:event.sequence,
   ledgerIdentity:"synthetic-fixed-ledger",ledgerRevision:1,isEffective:true})));
  await PayrollRecord.create({employeeId:code,employeeName:"Synthetic Fixed Employee",department:"Synthetic",payType:"Semi-monthly",payPeriod:label,
   basicPay:500,grossPay:490,deductions:1,netPay:489,status:options.status||"Pending",paidOn:"Nov 10, 2026",isArchived:false,
   minuteRate:1000/23/8/60,workingDays:23,scheduledHours:96,workedHours:95,overtimeApproved:!!options.overtime,overtimeHours:options.overtime?1:0,
   calculationVersion:"earned-hours-late-rest-v1",calculationSnapshot:{monthlySalary:1000}});
 });return{period:label,events};
}
async function read(route:string,business=businesses[0],body?:unknown){
 // Each synthetic Date clock needs a matching signed test session; production authentication is unchanged.
 admin=createAdminDashboardSession("90000001")!;
 const response=await fetch(base+route,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json",
 "X-Business-Id":business,"X-CRM-Admin-Session":admin},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,data:await response.json()};}
async function evidence(){return JSON.stringify({businesses:await Promise.all(businesses.map(business=>runWithBusiness(business,async()=>({
 payroll:await PayrollRecord.find().sort({_id:1}).lean(),attendance:await Attendance.find().sort({_id:1}).lean()})))),ledger:await AttendanceLedger.find().lean()});}
async function candidate(label=period){return runWithBusiness(businesses[0],async()=>calculatePayrollCandidate((await Employee.findById(owners[0]).lean())!,label));}

test("the original monthly-hours overage is reproduced with rollout off and corrected across seven live-style reads with rollout on",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  await fixture();const saved=await evidence();delete process.env.CRM_FIXED_HALF_SALARY_FROM;
  assert.ok((await candidate()).value.grossPay>500);process.env.CRM_FIXED_HALF_SALARY_FROM="2026-10-06";
  for(const business of businesses)for(let refresh=0;refresh<2;refresh++){
   const result=await read('/payroll/records?'+new URLSearchParams({payPeriod:period,basis:'estimate'}),business);assert.equal(result.status,200);
   assert.equal(result.data[0].grossPay,500);assert.equal(result.data[0].netPay,500);assert.equal(result.data[0].cutoffEstimate,true);
   assert.equal(result.data[0].earnedToDate,undefined);assert.equal(result.data[0].status,"Pending");assert.equal(result.data[0].paidOn,"Nov 10, 2026");
   assert.equal(result.data[0].calculationVersion,fixedHalfSalaryVersion);
   const payments=await runWithBusiness(business,()=>employeePayments(code,1,'current','estimate'));assert.equal(payments.items[0].grossPay,500);assert.equal(payments.items[0].cutoffEstimate,true);
  }
  assert.equal(await evidence(),saved);assert.equal(await getCallBridgeScheduleModel().countDocuments(),0);
 }finally{context.mock.timers.reset();}
});
test("the shorter half also pays the full half salary, with no early/late checkout or long Coaching additions",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  const label="Oct 6, 2026 - Oct 20, 2026";await fixture({start:"2026-10-06",end:"2026-10-20",period:label,earlyIn:true});
  const value=await candidate(label);assert.equal(value.dtr.summary.workingDays,11);assert.equal(value.value.grossPay,500);assert.equal(value.value.netPay,500);
  assert.match(value.dtr.rows.find(row=>!row.isWeekend)!.timeOut,/0?8:05/);assert.equal(value.value.nonBillableOffPhoneMinutes,0);
 }finally{context.mock.timers.reset();}
});
test("late after grace, undertime and excess rest are charged once and every displayed deduction reconciles",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  await fixture({mixed:true});const saved=await evidence(),result=await candidate(),value=result.value;
  assert.equal(value.grossPay,500);assert.equal(value.lateMinutes,5);assert.equal(value.earlyTimeOutMinutes,10);
  assert.equal(value.excessBreakMinutes,2);assert.equal(value.excessLunchMinutes,3);assert.equal(value.nonBillableOffPhoneMinutes,5);assert.equal(value.deductibleMinutes,25);
  assert.equal(value.deductions,Math.round(25*result.rates.minuteRate*100)/100);assert.equal(value.netPay,Math.round((500-value.deductions)*100)/100);
  assert.equal(Math.round(value.workedHours*60),96*60-25);assert.equal(payrollDeductionDisplayTotal(value),value.deductions);
  assert.equal(Math.round(payrollDeductionRows(value).reduce((sum,row)=>sum+row.amount,0)*100),Math.round(value.deductions*100));
  assert.equal(await evidence(),saved);
 }finally{context.mock.timers.reset();}
});
test("a completed absence reduces the fixed base once, not both earned gross and a deduction",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  await fixture({absent:true});const result=await candidate();assert.equal(result.value.grossPay,500);assert.equal(result.value.absenceMinutes,480);
  assert.equal(result.value.deductions,Math.round(480*result.rates.minuteRate*100)/100);
 }finally{context.mock.timers.reset();}
});
test("08:05 remains the original checkout while rest after shift end is never charged",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  await fixture({outsideRest:true});const before=await evidence(),result=await candidate();assert.equal(result.value.excessBreakMinutes,0);assert.equal(result.value.deductions,0);
  assert.equal(await evidence(),before);
 }finally{context.mock.timers.reset();}
});
test("future shifts are not charged as absences and provisional fixed salary cannot be marked Paid",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  const label="Nov 6, 2026 - Nov 20, 2026";await fixture({start:"2026-11-06",end:"2026-11-20",period:label,future:true});
  const result=await candidate(label);assert.equal(result.value.absenceMinutes,0);assert.equal(result.value.grossPay,500);
  const stored=await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({employeeId:code}).lean());
  const preview=await read(`/payroll/records/${stored!._id}/payment-status/preview`,businesses[0],{paid:true});
  assert.equal(preview.status,200);assert.equal(preview.data.canApply,false);assert.ok(preview.data.blockers.some((text:string)=>/still in progress/.test(text)));
 }finally{context.mock.timers.reset();}
});
test("Paid and Completed records remain byte-identical in all businesses",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  await fixture({status:"Paid"});
  for(const status of ["Paid","Completed"] as const){
   for(const business of businesses)await runWithBusiness(business,()=>PayrollRecord.updateMany({},{$set:{status}}));
   const saved=await evidence();
   for(const business of businesses){const result=await read('/payroll/records?'+new URLSearchParams({payPeriod:period}),business);
    assert.equal(result.status,200);assert.equal(result.data[0].grossPay,490);assert.equal(result.data[0].netPay,489);assert.equal(result.data[0].status,status);assert.equal(result.data[0].cutoffEstimate,undefined);}
   assert.equal(await evidence(),saved);
  }
 }finally{context.mock.timers.reset();}
});
test("nonzero overtime approval is refused rather than silently adding or rewriting pay",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  await fixture({overtime:true});const saved=await evidence();await assert.rejects(candidate(),/overtime/i);assert.equal(await evidence(),saved);
 }finally{context.mock.timers.reset();}
});

test("unchanged paid-hour edits keep the fixed base and do not deduct late, undertime or rest twice",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  await fixture({mixed:true});const calculated=await candidate();
  for(const business of businesses)await runWithBusiness(business,()=>PayrollRecord.updateMany({},{$set:{...calculated.value,
   calculationSnapshot:{...calculated.value.calculationSnapshot,businessIds:businesses}}}));
  const saved=await evidence();const stored=await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({employeeId:code}).lean());
  const plan=await runWithBusiness(businesses[0],()=>previewPayrollWorkedHours(String(stored!._id),Math.round(calculated.value.workedHours*60)));
  assert.equal(plan.after.grossPay,500);assert.equal(plan.after.deductibleMinutes,25);assert.equal(plan.after.netPay,calculated.value.netPay);
  assert.equal(plan.after.deductions,calculated.value.deductions);assert.equal(await evidence(),saved);
 }finally{context.mock.timers.reset();}
});

test("an entirely absent shorter cutoff requires review rather than inferring positive pay from unequal working days",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  const label="Oct 6, 2026 - Oct 20, 2026";await fixture({start:"2026-10-06",end:"2026-10-20",period:label,allAbsent:true});
  const saved=await evidence();await assert.rejects(candidate(label),/No verified paid attendance/);assert.equal(await evidence(),saved);
 }finally{context.mock.timers.reset();}
});

test("a saved paid-hour override cannot charge future shifts as missing hours",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  const label="Nov 6, 2026 - Nov 20, 2026";await fixture({start:"2026-11-06",end:"2026-11-20",period:label,future:true});
  for(const business of businesses)await runWithBusiness(business,()=>PayrollRecord.updateMany({},{$set:{workedMinutesOverride:480}}));
  const saved=await evidence();await assert.rejects(candidate(label),/after the fixed-salary cutoff has completed/);assert.equal(await evidence(),saved);
 }finally{context.mock.timers.reset();}
});

test("explicit cutoff confirmation saves the fixed formula atomically across business copies and rejects stale replay",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  await fixture({mixed:true});const prior=await evidence(),calculated=await candidate();
  const preview=await read('/payroll/recompute/preview',businesses[0],{payPeriod:period});
  assert.equal(preview.status,200);assert.equal(preview.data.canApply,true);assert.equal(preview.data.rows.length,1);assert.equal(await evidence(),prior);
  const confirmed=await read('/payroll/recompute/confirm',businesses[0],{payPeriod:period,token:preview.data.token,confirm:true,reason:'Isolated fixed-half verification'});
  assert.equal(confirmed.status,200);assert.equal(confirmed.data.mirrors,businesses.length);
  for(const business of businesses){const stored=await runWithBusiness(business,()=>PayrollRecord.findOne({employeeId:code}).lean());
   assert.equal(stored!.grossPay,500);assert.equal(stored!.deductions,calculated.value.deductions);assert.equal(stored!.netPay,calculated.value.netPay);
   assert.equal(stored!.calculationVersion,fixedHalfSalaryVersion);assert.equal(stored!.status,'Pending');assert.equal(stored!.paidOn,'Nov 10, 2026');
   assert.equal(stored!.calculationAudit?.length,1);
  }
  const saved=await evidence(),replayed=await read('/payroll/recompute/confirm',businesses[0],{payPeriod:period,token:preview.data.token,confirm:true,reason:'Stale isolated replay'});
  assert.equal(replayed.status,409);assert.equal(await evidence(),saved);
  const after=JSON.parse(saved),before=JSON.parse(prior);assert.deepEqual(after.ledger,before.ledger);
  assert.deepEqual(after.businesses.map((row:{attendance:unknown})=>row.attendance),before.businesses.map((row:{attendance:unknown})=>row.attendance));
  const stored=await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({employeeId:code}).lean());
  const payment=await read(`/payroll/records/${stored!._id}/payment-status/preview`,businesses[0],{paid:true});
  assert.equal(payment.status,200);assert.equal(payment.data.canApply,true);
  const paid=await read(`/payroll/records/${stored!._id}/payment-status/confirm`,businesses[0],{paid:true,token:payment.data.token,confirm:true,acknowledgeAttendance:true,reason:'Isolated approved payment status'});
  assert.equal(paid.status,200);assert.equal(paid.data.applied,true);
  for(const business of businesses){const copy=await runWithBusiness(business,()=>PayrollRecord.findOne({employeeId:code}).lean());
   assert.equal(copy!.status,'Paid');assert.equal(copy!.grossPay,calculated.value.grossPay);assert.equal(copy!.deductions,calculated.value.deductions);assert.equal(copy!.netPay,calculated.value.netPay);
  }
  const settled=JSON.parse(await evidence());assert.deepEqual(settled.ledger,before.ledger);
  assert.deepEqual(settled.businesses.map((row:{attendance:unknown})=>row.attendance),before.businesses.map((row:{attendance:unknown})=>row.attendance));
 }finally{context.mock.timers.reset();}
});

test("saved payment status can be confirmed without recomputing a completed cutoff across all seven businesses",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  await fixture({mixed:true});const before=JSON.parse(await evidence());
  const stored=await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({employeeId:code}).lean());
  const preview=await read('/payroll/records/'+stored!._id+'/payment-status/preview',businesses[0],{paid:true});
  assert.equal(preview.status,200);assert.equal(preview.data.canApply,true);
  assert.equal(preview.data.rows.length,businesses.length);assert.equal(preview.data.blockers.length,0);
  assert.equal(preview.data.warnings.length,0);
  const unconfirmed=await read('/payroll/records/'+stored!._id+'/payment-status/confirm',businesses[0],
   {paid:true,token:preview.data.token,confirm:false,reason:'Synthetic saved payment only',acknowledgeAttendance:false});
  assert.equal(unconfirmed.status,400);assert.deepEqual(JSON.parse(await evidence()),before);
  const confirmed=await read('/payroll/records/'+stored!._id+'/payment-status/confirm',businesses[0],
   {paid:true,token:preview.data.token,confirm:true,reason:'Synthetic saved payment only',acknowledgeAttendance:true});
  assert.equal(confirmed.status,200);assert.equal(confirmed.data.applied,true);
  const after=JSON.parse(await evidence());assert.deepEqual(after.ledger,before.ledger);
  for(const[index,entry]of after.businesses.entries()){
   assert.deepEqual(entry.attendance,before.businesses[index].attendance);
   const prior=before.businesses[index].payroll[0],saved=entry.payroll[0];
   for(const key of Object.keys(prior).filter(key=>!['status','paidOn','updatedAt','calculationAudit'].includes(key)))assert.deepEqual(saved[key],prior[key],key);
   assert.equal(saved.status,'Paid');assert.equal(saved.calculationVersion,'earned-hours-late-rest-v1');assert.equal(saved.calculationAudit.length,1);
  }
  const repeated=await read('/payroll/records/'+stored!._id+'/payment-status/preview',businesses[0],{paid:true});
  assert.equal(repeated.data.canApply,false);assert.ok(repeated.data.blockers.some((message:string)=>/already marked Paid/.test(message)));
  assert.equal(await getCallBridgeScheduleModel().countDocuments(),0);
 }finally{context.mock.timers.reset();}
});

test("saved payment confirmation keeps authorization and fresh-record checks without a recompute dependency",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  await fixture();const stored=await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({employeeId:code}).lean());
  const route='/payroll/records/'+stored!._id+'/payment-status';
  const preview=await read(route+'/preview',businesses[0],{paid:true});assert.equal(preview.data.canApply,true);
  const noAuth=await fetch(base+route+'/confirm',{method:'POST',headers:{'Content-Type':'application/json','X-Business-Id':businesses[0]},
   body:JSON.stringify({paid:true,token:preview.data.token,confirm:true,reason:'Synthetic unauthorized',acknowledgeAttendance:true})});
  assert.ok([401,403].includes(noAuth.status));
  const missingReason=await read(route+'/confirm',businesses[0],{paid:true,token:preview.data.token,confirm:true,reason:'',acknowledgeAttendance:true});
  assert.equal(missingReason.status,400);
  await runWithBusiness(businesses[0],()=>PayrollRecord.updateOne({_id:stored!._id},{$set:{grossPay:491,deductions:1,netPay:490}}));
  const before=await evidence(),stale=await read(route+'/confirm',businesses[0],{paid:true,token:preview.data.token,confirm:true,reason:'Synthetic stale',acknowledgeAttendance:true});
  assert.equal(stale.status,409);assert.equal(await evidence(),before);
 }finally{context.mock.timers.reset();}
});

test("saved amounts that conflict or are invalid still block payment, as does completed payment history",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  await fixture();const stored=await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({employeeId:code}).lean()),route='/payroll/records/'+stored!._id+'/payment-status/preview';
  await runWithBusiness(businesses[1],()=>PayrollRecord.updateOne({employeeId:code},{$set:{grossPay:491,deductions:1,netPay:490}}));
  let preview=await read(route,businesses[0],{paid:true});assert.equal(preview.data.canApply,false);assert.ok(preview.data.blockers.some((message:string)=>/amounts differ/.test(message)));
  await runWithBusiness(businesses[1],()=>PayrollRecord.updateOne({employeeId:code},{$set:{grossPay:490,deductions:1,netPay:480}}));
  preview=await read(route,businesses[0],{paid:true});assert.equal(preview.data.canApply,false);
  for(const business of businesses)await runWithBusiness(business,()=>PayrollRecord.updateOne({employeeId:code},{$set:{grossPay:490,deductions:1,netPay:489,status:'Completed'}}));
  const before=await evidence();preview=await read(route,businesses[0],{paid:true});assert.equal(preview.data.canApply,false);
  assert.ok(preview.data.blockers.some((message:string)=>/Completed payroll is locked/.test(message)));assert.equal(await evidence(),before);
 }finally{context.mock.timers.reset();}
});

test("an unavailable new estimate does not warn or prevent confirmation of consistent saved amounts",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  await fixture();for(const business of businesses)await runWithBusiness(business,()=>PayrollRecord.updateOne({employeeId:code},{$set:{'calculationSnapshot.monthlySalary':-1}}));
  const before=await evidence(),stored=await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({employeeId:code}).lean());
  const shown=await read('/payroll/records?'+new URLSearchParams({payPeriod:period,basis:'estimate'}),businesses[0]);assert.equal(shown.data[0].earningsUnavailable,true);
  const preview=await read('/payroll/records/'+stored!._id+'/payment-status/preview',businesses[0],{paid:true});
  assert.equal(preview.status,200);assert.equal(preview.data.canApply,true);assert.equal(preview.data.warnings.length,0);
  assert.equal(await evidence(),before);
 }finally{context.mock.timers.reset();}
});

test("genuine saved attendance history warnings still require acknowledgement without changing money or attendance",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  await fixture();for(const business of businesses)await runWithBusiness(business,()=>PayrollRecord.updateOne({employeeId:code},{$set:{incompleteShiftDays:1}}));
  const before=await evidence(),stored=await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({employeeId:code}).lean());
  const route='/payroll/records/'+stored!._id+'/payment-status',preview=await read(route+'/preview',businesses[0],{paid:true});
  assert.equal(preview.data.canApply,true);assert.ok(preview.data.warnings.some((message:string)=>/Saved attendance review history/.test(message)));
  assert.ok(!preview.data.warnings.some((message:string)=>/estimate|Recompute cutoff/.test(message)));
  const response=await read(route+'/confirm',businesses[0],{paid:true,token:preview.data.token,confirm:true,reason:'Synthetic history approval missing',acknowledgeAttendance:false});
  assert.equal(response.status,400);assert.equal(await evidence(),before);
 }finally{context.mock.timers.reset();}
});

test("saved payment preview tokens remain confirmable as the real clock advances",async()=>{
 const month=new Date();month.setUTCDate(1);month.setUTCMonth(month.getUTCMonth()-1);
 const prefix=month.toISOString().slice(0,7),label=month.toLocaleDateString('en-US',{timeZone:'UTC',month:'short'})+' 6, '+month.getUTCFullYear()+' - '+
  month.toLocaleDateString('en-US',{timeZone:'UTC',month:'short'})+' 20, '+month.getUTCFullYear();
 await fixture({start:prefix+'-06',end:prefix+'-20',period:label});
 const before=JSON.parse(await evidence()),stored=await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({employeeId:code}).lean()),route='/payroll/records/'+stored!._id+'/payment-status';
 const first=await read(route+'/preview',businesses[0],{paid:true});assert.equal(first.data.canApply,true);
 await new Promise(resolve=>setTimeout(resolve,25));
 const next=await read(route+'/preview',businesses[0],{paid:true});assert.equal(next.data.token,first.data.token);
 const confirmed=await read(route+'/confirm',businesses[0],{paid:true,token:first.data.token,confirm:true,reason:'Synthetic real-clock saved payment',acknowledgeAttendance:true});
 assert.equal(confirmed.status,200);assert.equal(confirmed.data.applied,true);
 const after=JSON.parse(await evidence());assert.deepEqual(after.ledger,before.ledger);
 for(const[index,entry]of after.businesses.entries()){assert.deepEqual(entry.attendance,before.businesses[index].attendance);
  for(const key of ['basicPay','grossPay','deductions','netPay','calculationVersion','calculationSnapshot'])assert.deepEqual(entry.payroll[0][key],before.businesses[index].payroll[0][key]);}
});

test("targeted saved payment reads stay fast and available without projecting an invalid current calculation",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  await fixture({overtime:true});const saved=await evidence();
  for(const business of businesses){
   const result=await read('/payroll/records?'+new URLSearchParams({payPeriod:period,employeeId:code,savedForPayment:'true'}),business);
   assert.equal(result.status,200);assert.equal(result.data.length,1);assert.equal(result.data[0].grossPay,490);assert.equal(result.data[0].netPay,489);
   assert.equal(result.data[0].cutoffEstimate,undefined);assert.equal(result.data[0].earningsUnavailable,undefined);
  }
  const normal=await read('/payroll/records?'+new URLSearchParams({payPeriod:period,basis:'estimate'}));assert.equal(normal.status,200);assert.equal(normal.data[0].earningsUnavailable,true);
  for(const query of [new URLSearchParams({payPeriod:period,savedForPayment:'true'}),new URLSearchParams({employeeId:code,savedForPayment:'true'}),
   new URLSearchParams({payPeriod:period,employeeId:code,savedForPayment:'false'}),new URLSearchParams({payPeriod:period,employeeId:code,savedForPayment:'true',archived:'true'})]){
   assert.equal((await read('/payroll/records?'+query)).status,400);
  }
  assert.equal(await evidence(),saved);
 }finally{context.mock.timers.reset();}
});

test("a completed short day retains the approved scheduled-time deduction calculation instead of becoming unavailable",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  await fixture({shortDay:true});const saved=await evidence(),calculated=await candidate();
  assert.equal(calculated.dtr.summary.incompleteShiftDays,0);assert.equal(calculated.value.earlyTimeOutMinutes,502);
  assert.equal(calculated.value.deductibleMinutes,502);assert.equal(calculated.value.grossPay,500);
  assert.equal(calculated.value.deductions,Math.round(502*calculated.rates.minuteRate*100)/100);
  for(const business of businesses){const result=await read('/payroll/records?'+new URLSearchParams({payPeriod:period,basis:'estimate'}),business);
   assert.equal(result.status,200);assert.equal(result.data[0].earningsUnavailable,undefined);assert.equal(result.data[0].netPay,calculated.value.netPay);}
  assert.equal(await evidence(),saved);
 }finally{context.mock.timers.reset();}
});

test("saved payment views keep the same amount through Pending Paid and Pending without recomputing",async context=>{
 context.mock.timers.enable({apis:["Date"],now});try{
  await fixture();assert.equal((await candidate()).value.netPay,500);
  const before=JSON.parse(await evidence());
  const assertSavedViews=async(status:string)=>{
   for(const business of businesses){
    const list=await read('/payroll/records?'+new URLSearchParams({payPeriod:period}),business);assert.equal(list.status,200);
    assert.equal(list.data[0].netPay,489);assert.equal(list.data[0].grossPay,490);assert.equal(list.data[0].status,status);assert.equal(list.data[0].cutoffEstimate,undefined);
    const stats=await read('/payroll/stats?'+new URLSearchParams({payPeriod:period}),business);assert.equal(stats.status,200);assert.equal(stats.data.netPayroll,489);
    const payments=await runWithBusiness(business,()=>employeePayments(code));assert.equal(payments.items[0].netPay,489);assert.equal(payments.items[0].status,status);assert.equal(payments.items[0].cutoffEstimate,undefined);
    const payslip=await read('/payroll/dtr/'+code+'?'+new URLSearchParams({payPeriod:period,basis:'saved'}),business);assert.equal(payslip.status,200);assert.equal(payslip.data.summary.netPay,489);assert.equal(payslip.data.summary.cutoffEstimate,undefined);
   }
  };
  await assertSavedViews('Pending');
  const stored=await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({employeeId:code}).lean()),route='/payroll/records/'+stored!._id+'/payment-status';
  for(const paid of [true,false]){
   const preview=await read(route+'/preview',businesses[0],{paid});assert.equal(preview.status,200);assert.equal(preview.data.canApply,true);
   const confirmed=await read(route+'/confirm',businesses[0],{paid,token:preview.data.token,confirm:true,acknowledgeAttendance:true,reason:'Synthetic stable saved payment amount'});assert.equal(confirmed.status,200);
   await assertSavedViews(paid?'Paid':'Pending');
  }
  const after=JSON.parse(await evidence());assert.deepEqual(after.ledger,before.ledger);
  for(const[index,entry]of after.businesses.entries()){
   assert.deepEqual(entry.attendance,before.businesses[index].attendance);
   for(const key of Object.keys(before.businesses[index].payroll[0]).filter(key=>!['status','paidOn','updatedAt','calculationAudit'].includes(key)))assert.deepEqual(entry.payroll[0][key],before.businesses[index].payroll[0][key],key);
  }
  const estimate=await read('/payroll/dtr/'+code+'?'+new URLSearchParams({payPeriod:period,basis:'estimate'}));assert.equal(estimate.data.summary.netPay,500);
 }finally{context.mock.timers.reset();}
});

test("only the new current cutoff shows live hours and deductions while restored history remains byte-identical in seven businesses",async context=>{
 const beforeFlag=process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;process.env.CRM_CURRENT_CUTOFF_LIVE_FROM="2026-11-06";
 context.mock.timers.enable({apis:["Date"],now});try{
  const active="Nov 6, 2026 - Nov 20, 2026";await fixture({start:"2026-11-06",end:"2026-11-20",period:active,future:true,mixed:true});
  for(const business of businesses)await runWithBusiness(business,async()=>{
   const saved=(await PayrollRecord.findOne({employeeId:code}).lean())!;const{_id,...restored}=saved;void _id;
   await PayrollRecord.create({...restored,payPeriod:period,status:"Pending",paidOn:"Nov 10, 2026"});
  });
  const before=await evidence(),calculated=(await candidate(active)).value;assert.notEqual(calculated.netPay,489);assert.ok(calculated.deductions>0);
  for(const business of businesses)for(let refresh=0;refresh<2;refresh++){
   const list=await read('/payroll/records',business);assert.equal(list.status,200);assert.equal(list.data.length,1);assert.equal(list.data[0].payPeriod,active);
   for(const key of ['grossPay','deductions','netPay','workedHours','deductibleMinutes'])assert.equal(list.data[0][key],calculated[key as keyof typeof calculated]);
   assert.equal(list.data[0].currentCutoffDraft,true);assert.equal(list.data[0].savedAmounts.netPay,489);
   const payments=await runWithBusiness(business,()=>employeePayments(code));assert.equal(payments.currentPayPeriod,active);assert.equal(payments.items[0].netPay,calculated.netPay);assert.equal(payments.items[0].workedHours,calculated.workedHours);
   const stats=await read('/payroll/stats',business);assert.equal(stats.data.netPayroll,calculated.netPay);assert.equal(stats.data.totalDeductions,calculated.deductions);
   const restored=await read('/payroll/records?'+new URLSearchParams({payPeriod:period}),business);assert.equal(restored.data[0].netPay,489);assert.equal(restored.data[0].deductions,1);assert.equal(restored.data[0].workedHours,95);assert.equal(restored.data[0].currentCutoffDraft,undefined);
  }
  const restored=(await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({payPeriod:period}).lean()))!;
  const pastPreview=await read('/payroll/records/'+restored._id+'/payment-status/preview',businesses[0],{paid:true});assert.equal(pastPreview.status,200);assert.equal(pastPreview.data.currentCutoffDraft,false);assert.ok(pastPreview.data.rows.every((row:{netPay:number})=>row.netPay===489));
  assert.equal(await evidence(),before);
 }finally{context.mock.timers.reset();if(beforeFlag===undefined)delete process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;else process.env.CRM_CURRENT_CUTOFF_LIVE_FROM=beforeFlag;}
});

test("Paid freezes the exact approved new cutoff calculation in every business without rewriting restored payroll or attendance",async context=>{
 const beforeFlag=process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;process.env.CRM_CURRENT_CUTOFF_LIVE_FROM="2026-11-06";
 context.mock.timers.enable({apis:["Date"],now:new Date("2026-11-21T02:00:00Z")});const beforeAdmin=admin;admin=createAdminDashboardSession("90000001")!;try{
  const active="Nov 6, 2026 - Nov 20, 2026";await fixture({start:"2026-11-06",end:"2026-11-20",period:active,mixed:true});
  const restoredIds:mongoose.Types.ObjectId[]=[];
  for(const business of businesses)await runWithBusiness(business,async()=>{const saved=(await PayrollRecord.findOne({employeeId:code}).lean())!;const{_id,...restored}=saved;void _id;
   restoredIds.push((await PayrollRecord.create({...restored,payPeriod:period,status:"Paid"}))._id);});
  const before=JSON.parse(await evidence()),value=(await candidate(active)).value,record=(await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({payPeriod:active}).lean()))!;
  const route='/payroll/records/'+record._id+'/payment-status',preview=await read(route+'/preview',businesses[0],{paid:true});
  assert.equal(preview.status,200);assert.equal(preview.data.canApply,true,JSON.stringify(preview.data.blockers));assert.equal(preview.data.currentCutoffDraft,true);assert.notEqual(value.netPay,record.netPay);
  assert.ok(preview.data.rows.every((row:{netPay:number})=>row.netPay===value.netPay));
  const confirmed=await read(route+'/confirm',businesses[0],{paid:true,token:preview.data.token,confirm:true,acknowledgeAttendance:true,reason:'Synthetic approval of the exact current cutoff amount'});assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));
  for(const[index,business]of businesses.entries())await runWithBusiness(business,async()=>{
   const paid=(await PayrollRecord.findOne({payPeriod:active}).lean())!;assert.equal(paid.status,'Paid');
   for(const key of ['grossPay','deductions','netPay','workedHours','deductibleMinutes'] as const)assert.equal(paid[key],value[key]);
   const list=await read('/payroll/records?'+new URLSearchParams({payPeriod:active}),business);assert.equal(list.data[0].netPay,preview.data.rows[index].netPay);assert.equal(list.data[0].currentCutoffDraft,undefined);
   const history=await employeePayments(code,1,'history');const item=history.items.find(row=>row.payPeriod===active)!;assert.equal(item.netPay,value.netPay);assert.equal(item.status,'Paid');assert.equal(item.currentCutoffDraft,undefined);
   const restored=await PayrollRecord.findById(restoredIds[index]).lean();assert.equal(JSON.stringify(restored),JSON.stringify(before.businesses[index].payroll.find((row:{payPeriod:string})=>row.payPeriod===period)));
  });
  const after=JSON.parse(await evidence());assert.deepEqual(after.ledger,before.ledger);for(const[index,entry]of after.businesses.entries())assert.deepEqual(entry.attendance,before.businesses[index].attendance);
  assert.equal((await read(route+'/confirm',businesses[0],{paid:true,token:preview.data.token,confirm:true,acknowledgeAttendance:true,reason:'Synthetic replay'})).status,409);
 }finally{context.mock.timers.reset();admin=beforeAdmin;if(beforeFlag===undefined)delete process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;else process.env.CRM_CURRENT_CUTOFF_LIVE_FROM=beforeFlag;}
});

test("an attendance revision rejects a stale current payment preview without writing any payroll",async context=>{
 const beforeFlag=process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;process.env.CRM_CURRENT_CUTOFF_LIVE_FROM="2026-11-06";
 context.mock.timers.enable({apis:["Date"],now:new Date("2026-11-21T02:00:00Z")});const beforeAdmin=admin;admin=createAdminDashboardSession("90000001")!;try{
  const active="Nov 6, 2026 - Nov 20, 2026";await fixture({start:"2026-11-06",end:"2026-11-20",period:active,mixed:true});
  const record=(await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({payPeriod:active}).lean()))!,route='/payroll/records/'+record._id+'/payment-status';
  const preview=await read(route+'/preview',businesses[0],{paid:true});assert.equal(preview.data.canApply,true);
  await AttendanceLedger.updateOne({_id:'synthetic-fixed-ledger'},{$inc:{revision:1}});const before=await evidence();
  assert.equal((await read(route+'/confirm',businesses[0],{paid:true,token:preview.data.token,confirm:true,acknowledgeAttendance:true,reason:'Synthetic stale approval'})).status,409);
  assert.equal(await evidence(),before);
 }finally{context.mock.timers.reset();admin=beforeAdmin;if(beforeFlag===undefined)delete process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;else process.env.CRM_CURRENT_CUTOFF_LIVE_FROM=beforeFlag;}
});

test("automatic generation creates only the missing calendar-current cutoff once and preserves the restored cutoff",async context=>{
 const beforeFlag=process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;process.env.CRM_CURRENT_CUTOFF_LIVE_FROM="2026-11-06";
 context.mock.timers.enable({apis:["Date"],now});try{
  const active="Nov 6, 2026 - Nov 20, 2026";await fixture({start:"2026-11-06",end:"2026-11-20",period:active,future:true,mixed:true});
  for(const business of businesses)await runWithBusiness(business,()=>PayrollRecord.updateMany({},{$set:{payPeriod:period,status:'Paid'}}));
  const {PayrollGenerationPolicy}=await import('../models/PayrollGenerationPolicy'),{previewMissingPayroll,generateFutureMissingPayroll}=await import('./payrollMissingGeneration');
  await runWithBusiness(businesses[0],()=>PayrollGenerationPolicy.create({_id:'missing-current-payroll',enabled:true,startsAfter:'2026-11-05',actor:'90000001',enabledAt:new Date()}));
  const before=JSON.parse(await evidence()),preview=await runWithBusiness(businesses[0],()=>previewMissingPayroll());assert.equal(preview.payPeriod,active);assert.equal(preview.rows.length,1);assert.equal(preview.held.length,0);assert.equal(preview.canApply,true);
  const generated=await runWithBusiness(businesses[0],()=>generateFutureMissingPayroll());assert.equal(generated?.created,1);assert.equal(generated?.mirrors,7);
  assert.equal(await runWithBusiness(businesses[0],()=>generateFutureMissingPayroll()),null);
  const after=JSON.parse(await evidence());assert.deepEqual(after.ledger,before.ledger);
  for(const[index,entry]of after.businesses.entries()){assert.deepEqual(entry.attendance,before.businesses[index].attendance);assert.equal(entry.payroll.length,2);assert.deepEqual(entry.payroll.find((row:{payPeriod:string})=>row.payPeriod===period),before.businesses[index].payroll[0]);}
 }finally{context.mock.timers.reset();if(beforeFlag===undefined)delete process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;else process.env.CRM_CURRENT_CUTOFF_LIVE_FROM=beforeFlag;}
});

test("current payment calculation rollback and concurrent replay cannot leave partial money or statuses across businesses",async context=>{
 const beforeFlag=process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;process.env.CRM_CURRENT_CUTOFF_LIVE_FROM="2026-11-06";
 context.mock.timers.enable({apis:["Date"],now:new Date("2026-11-21T02:00:00Z")});const beforeAdmin=admin;admin=createAdminDashboardSession("90000001")!;try{
  const active="Nov 6, 2026 - Nov 20, 2026";await fixture({start:"2026-11-06",end:"2026-11-20",period:active,mixed:true});
  const record=(await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({payPeriod:active}).lean()))!,route='/payroll/records/'+record._id+'/payment-status';
  let preview=await read(route+'/preview',businesses[0],{paid:true});assert.equal(preview.data.canApply,true);
  const before=await evidence(),{getBusinessConnection}=await import('../config/tenancy');
  const stub=context.mock.method(getBusinessConnection(businesses[1]).model('PayrollRecord'),'updateOne',()=>{throw Error('Synthetic current payment mirror failure');});
  const confirm=()=>read(route+'/confirm',businesses[0],{paid:true,token:preview.data.token,confirm:true,acknowledgeAttendance:true,reason:'Synthetic atomic current payment approval'});
  try{assert.equal((await confirm()).status,500);}finally{stub.mock.restore();}
  assert.equal(await evidence(),before,'Failed current settlement must roll back amounts, details, statuses and audits.');
  preview=await read(route+'/preview',businesses[0],{paid:true});const results=await Promise.all([confirm(),confirm()]);assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  for(const business of businesses)await runWithBusiness(business,async()=>{const saved=(await PayrollRecord.findOne({payPeriod:active}).lean())!;assert.equal(saved.status,'Paid');assert.equal(saved.netPay,preview.data.rows[0].netPay);assert.equal(saved.calculationAudit?.length,1);});
 }finally{context.mock.timers.reset();admin=beforeAdmin;if(beforeFlag===undefined)delete process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;else process.env.CRM_CURRENT_CUTOFF_LIVE_FROM=beforeFlag;}
});

test("a newly connected business inherits only its verified owner's new current payroll without configuring past or local shift settings",async context=>{
 const beforeFlag=process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;process.env.CRM_CURRENT_CUTOFF_LIVE_FROM="2026-11-06";
 context.mock.timers.enable({apis:["Date"],now});const beforeAdmin=admin;try{
  const active="Nov 6, 2026 - Nov 20, 2026",added=businesses[6];await fixture({start:"2026-11-06",end:"2026-11-20",period:active,future:true,mixed:true});
  for(const business of businesses.slice(0,6))await runWithBusiness(business,()=>PayrollRecord.updateMany({},{$set:{payPeriod:period,status:'Paid'}}));
  await runWithBusiness(added,async()=>{await PayrollRecord.deleteMany({});await SystemSettings.updateOne({key:'system'},{$set:{officialShiftStartTime:'',officialShiftEndTime:''}});});
  await AttendanceLedger.updateOne({_id:'synthetic-fixed-ledger'},{$set:{businessIds:businesses.slice(0,6)}});
  const {PayrollGenerationPolicy}=await import('../models/PayrollGenerationPolicy'),{previewMissingPayroll,generateFutureMissingPayroll}=await import('./payrollMissingGeneration');
  await runWithBusiness(businesses[0],()=>PayrollGenerationPolicy.updateOne({_id:'missing-current-payroll'},{$set:{enabled:true,startsAfter:'2026-11-05',actor:'90000001',enabledAt:new Date()}},{upsert:true}));
  const settingsBefore=await Promise.all(businesses.map(business=>runWithBusiness(business,()=>SystemSettings.findOne({key:'system'}).lean()))),before=JSON.parse(await evidence());
  const plan=await runWithBusiness(businesses[0],()=>previewMissingPayroll());assert.equal(plan.held.length,0,JSON.stringify(plan.held));assert.equal(plan.rows.length,1);
  assert.equal((await runWithBusiness(businesses[0],()=>generateFutureMissingPayroll()))?.mirrors,7);
  const owner=(await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({payPeriod:active}).lean()))!,inherited=(await runWithBusiness(added,()=>PayrollRecord.findOne({payPeriod:active}).lean()))!;
  assert.equal(inherited.calculationSnapshot?.inheritedPayrollInputs,true);assert.equal(inherited.calculationSnapshot?.payrollInputsBusinessId,businesses[0]);assert.equal(inherited.payrollOwnerBusinessId,businesses[0]);
  const shown=await read('/payroll/records',added);assert.equal(shown.status,200);assert.equal(shown.data[0].earningsUnavailable,undefined);assert.equal(shown.data[0].netPay,owner.netPay);assert.equal(shown.data[0].workedHours,owner.workedHours);
  const current=(await runWithBusiness(added,()=>employeePayments(code))).items[0];assert.equal(current.netPay,owner.netPay);assert.equal(current.workedHours,owner.workedHours);
  const {inheritedCurrentPayrollInputs}=await import('./payrollCanonicalInputs');
  await setBusinessAccessForEmployeeCode(code,businesses.slice(0,6));await assert.rejects(runWithBusiness(added,()=>inheritedCurrentPayrollInputs(inherited)),/access changed/);await setBusinessAccessForEmployeeCode(code,businesses);
  context.mock.timers.reset();context.mock.timers.enable({apis:["Date"],now:new Date("2026-11-21T02:00:00Z")});admin=createAdminDashboardSession("90000001")!;
  const route='/payroll/records/'+owner._id+'/payment-status',preview=await read(route+'/preview',businesses[0],{paid:true});assert.equal(preview.status,200);assert.equal(preview.data.canApply,true,JSON.stringify(preview.data.blockers));
  const paid=await read(route+'/confirm',businesses[0],{paid:true,token:preview.data.token,confirm:true,acknowledgeAttendance:true,reason:'Synthetic approval of verified owner current payroll'});assert.equal(paid.status,200,JSON.stringify(paid.data));
  const after=JSON.parse(await evidence());assert.deepEqual(after.ledger,before.ledger);for(const[index,entry]of after.businesses.entries()){
   assert.deepEqual(entry.attendance,before.businesses[index].attendance);assert.deepEqual(entry.payroll.filter((row:{payPeriod:string})=>row.payPeriod===period),before.businesses[index].payroll);
   const current=entry.payroll.find((row:{payPeriod:string})=>row.payPeriod===active);assert.equal(current.netPay,preview.data.rows[index].netPay);assert.equal(current.status,'Paid');
  }
  assert.deepEqual(await Promise.all(businesses.map(business=>runWithBusiness(business,()=>SystemSettings.findOne({key:'system'}).lean()))),settingsBefore);
  assert.equal((await runWithBusiness(added,()=>PayrollRecord.findOne({payPeriod:active}).lean()))?.calculationSnapshot?.inheritedPayrollInputs,true);
 }finally{context.mock.timers.reset();admin=beforeAdmin;if(beforeFlag===undefined)delete process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;else process.env.CRM_CURRENT_CUTOFF_LIVE_FROM=beforeFlag;}
});

async function currentGenerationClockFixture(clock:Date){
 const active="Nov 6, 2026 - Nov 20, 2026";await fixture({start:"2026-11-06",end:"2026-11-20",period:active,future:true,mixed:true});
 const ledger=(await AttendanceLedger.findById('synthetic-fixed-ledger').lean())!;await AttendanceLedger.updateOne({_id:ledger._id},{$set:{events:ledger.events.filter(event=>Date.parse(event.at)<=+clock)}});
 for(const business of businesses)await runWithBusiness(business,async()=>{await Attendance.deleteMany({timeIn:{$gt:clock}});await PayrollRecord.updateMany({},{$set:{payPeriod:period,status:'Paid'}});});
 return active;
}

test("clock-sensitive current generation keeps the reviewed server snapshot while an active shift advances",async context=>{
 const beforeFlag=process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;process.env.CRM_CURRENT_CUTOFF_LIVE_FROM="2026-11-06";
 const clock=new Date("2026-11-09T22:00:00Z");context.mock.timers.enable({apis:["Date"],now:clock});const beforeAdmin=admin;admin=createAdminDashboardSession("90000001")!;try{
  const active=await currentGenerationClockFixture(clock),value=(await candidate(active)).value,before=JSON.parse(await evidence());
  const preview=await read('/payroll/missing/preview',businesses[0],{payPeriod:active});assert.equal(preview.status,200);assert.equal(preview.data.canApply,true);
  context.mock.timers.tick(2500);
  const generated=await read('/payroll/missing/confirm',businesses[0],{payPeriod:active,token:preview.data.token,enableFuture:false,confirm:true,reason:'Synthetic reviewed in-progress current generation'});
  assert.equal(generated.status,200,JSON.stringify(generated.data));assert.equal(generated.data.mirrors,7);
  for(const[index,business]of businesses.entries())await runWithBusiness(business,async()=>{
   const stored=(await PayrollRecord.findOne({payPeriod:active}).lean())!;assert.equal(stored.workedHours,value.workedHours);assert.equal(stored.calculationSnapshot?.generatedAsOf,clock.toISOString());
   assert.deepEqual(JSON.parse(JSON.stringify(await PayrollRecord.findOne({payPeriod:period}).lean())),before.businesses[index].payroll[0]);
  });
 }finally{context.mock.timers.reset();admin=beforeAdmin;if(beforeFlag===undefined)delete process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;else process.env.CRM_CURRENT_CUTOFF_LIVE_FROM=beforeFlag;}
});

test("current generation rejects expired forged cross-business and changed-attendance previews without editing restored payroll",async context=>{
 const beforeFlag=process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;process.env.CRM_CURRENT_CUTOFF_LIVE_FROM="2026-11-06";
 const clock=new Date("2026-11-09T22:00:00Z");context.mock.timers.enable({apis:["Date"],now:clock});const beforeAdmin=admin;admin=createAdminDashboardSession("90000001")!;try{
  const active=await currentGenerationClockFixture(clock);let preview=await read('/payroll/missing/preview',businesses[0],{payPeriod:active});assert.equal(preview.data.canApply,true);
  const confirm=(token:string,business=businesses[0])=>read('/payroll/missing/confirm',business,{payPeriod:active,token,enableFuture:false,confirm:true,reason:'Synthetic snapshot guard verification'});
  let before=await evidence();assert.equal((await confirm('forged')).status,409);assert.equal((await confirm(preview.data.token,businesses[1])).status,409);assert.equal(await evidence(),before);
  context.mock.timers.tick(5*60_000+1);assert.equal((await confirm(preview.data.token)).status,409);assert.equal(await evidence(),before);
  preview=await read('/payroll/missing/preview',businesses[0],{payPeriod:active});await AttendanceLedger.updateOne({_id:'synthetic-fixed-ledger'},{$inc:{revision:1}});before=await evidence();assert.equal((await confirm(preview.data.token)).status,409);assert.equal(await evidence(),before);
 }finally{context.mock.timers.reset();admin=beforeAdmin;if(beforeFlag===undefined)delete process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;else process.env.CRM_CURRENT_CUTOFF_LIVE_FROM=beforeFlag;}
});

test("automatic current generation uses one trusted preview clock even when session setup advances an active shift",async context=>{
 const beforeFlag=process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;process.env.CRM_CURRENT_CUTOFF_LIVE_FROM="2026-11-06";
 const clock=new Date("2026-11-09T22:00:00Z");context.mock.timers.enable({apis:["Date"],now:clock});try{
  const active=await currentGenerationClockFixture(clock),value=(await candidate(active)).value,before=JSON.parse(await evidence());
  const {PayrollGenerationPolicy}=await import('../models/PayrollGenerationPolicy'),{generateFutureMissingPayroll}=await import('./payrollMissingGeneration');
  await runWithBusiness(businesses[0],()=>PayrollGenerationPolicy.updateOne({_id:'missing-current-payroll'},{$set:{enabled:true,startsAfter:'2026-11-05',actor:'90000001',enabledAt:clock}},{upsert:true}));
  const start=mongoose.startSession.bind(mongoose),stub=context.mock.method(mongoose,'startSession',async(...args:Parameters<typeof mongoose.startSession>)=>{context.mock.timers.tick(1700);return start(...args);});
  let generated;try{generated=await runWithBusiness(businesses[0],()=>generateFutureMissingPayroll());}finally{stub.mock.restore();}
  assert.equal(generated?.created,1);assert.equal(generated?.mirrors,7);
  for(const[index,business]of businesses.entries())await runWithBusiness(business,async()=>{const saved=(await PayrollRecord.findOne({payPeriod:active}).lean())!;assert.equal(saved.workedHours,value.workedHours);assert.equal(saved.calculationSnapshot?.generatedAsOf,clock.toISOString());assert.deepEqual(JSON.parse(JSON.stringify(await PayrollRecord.findOne({payPeriod:period}).lean())),before.businesses[index].payroll[0]);});
 }finally{context.mock.timers.reset();if(beforeFlag===undefined)delete process.env.CRM_CURRENT_CUTOFF_LIVE_FROM;else process.env.CRM_CURRENT_CUTOFF_LIVE_FROM=beforeFlag;}
});

function configureMinutePolicy(context: TestContext, clock = now) {
 const keys=['CRM_MINUTE_ACCRUAL_FROM','CRM_CURRENT_CUTOFF_LIVE_FROM'],previous=keys.map(key=>process.env[key]),previousAdmin=admin;
 process.env.CRM_MINUTE_ACCRUAL_FROM='2026-11-06';process.env.CRM_CURRENT_CUTOFF_LIVE_FROM='2026-11-06';
 context.mock.timers.enable({apis:['Date'],now:clock});admin=createAdminDashboardSession('90000001')!;
 context.after(()=>{context.mock.timers.reset();admin=previousAdmin;keys.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];});});
}

async function freezeHistoricalInputs(){
 for(const business of businesses)await runWithBusiness(business,()=>PayrollRecord.updateMany({payPeriod:period},{$set:{
  'calculationSnapshot.settings':{officialShiftStartTime:'23:00',officialShiftEndTime:'08:00'},
  'calculationSnapshot.policy':{breakMinutes:15,lunchMinutes:60,graceMinutes:5,revision:1},
 }}));
}

test("current earned-minute pay grows after a minute in all seven businesses without writing saved payroll or attendance",async context=>{
 const clock=new Date('2026-11-09T22:00:00Z');configureMinutePolicy(context,clock);const active=await currentGenerationClockFixture(clock);
 const {PayrollGenerationPolicy}=await import('../models/PayrollGenerationPolicy'),{generateFutureMissingPayroll}=await import('./payrollMissingGeneration');
 await runWithBusiness(businesses[0],()=>PayrollGenerationPolicy.updateOne({_id:'missing-current-payroll'},{$set:{enabled:true,startsAfter:'2026-11-05',actor:'90000001',enabledAt:clock}},{upsert:true}));
 assert.equal((await runWithBusiness(businesses[0],()=>generateFutureMissingPayroll()))?.mirrors,7);
 const before=await evidence(),first=(await read('/payroll/records?'+new URLSearchParams({payPeriod:active}))).data[0];
 assert.equal(first.calculationVersion,'earned-minute-capped-v1');assert.equal(first.earnedToDate,true);assert.equal(first.currentCutoffDraft,true);assert.ok(first.grossPay<first.basicPay);
 context.mock.timers.tick(60_000);
 for(const business of businesses){const result=await read('/payroll/records?'+new URLSearchParams({payPeriod:active}),business);assert.equal(result.status,200);const row=result.data[0];
  assert.ok(row.netPay>first.netPay);assert.equal(row.deductions,first.deductions);assert.ok(row.netPay<=row.basicPay);assert.equal(row.earnedToDate,true);
  const payments=(await runWithBusiness(business,()=>employeePayments(code))).items[0];assert.equal(payments.netPay,row.netPay);assert.equal(payments.calculationVersion,'earned-minute-capped-v1');
 }
 assert.equal(await evidence(),before);
});

test("minute accrual omits unworked time and subtracts only verified rest once, retaining paid Coaching and original overnight checkout",async context=>{
 configureMinutePolicy(context);const active='Nov 6, 2026 - Nov 20, 2026';await fixture({start:'2026-11-06',end:'2026-11-20',period:active,future:true,mixed:true});
 const before=await evidence(),computed=await candidate(active),value=computed.value,rest=value.excessBreakMinutes+value.excessLunchMinutes+(value.nonBillableOffPhoneMinutes||0);
 assert.equal(value.calculationVersion,'earned-minute-capped-v1');assert.equal(value.deductibleMinutes,rest);assert.ok(value.lateMinutes>0&&value.earlyTimeOutMinutes>0);
 assert.equal(value.grossPay,Math.min(value.basicPay,Math.round(computed.dtr.summary.earnedGrossHours!*60*value.minuteRate*100)/100));
 assert.equal(value.deductions,Math.round(rest*value.minuteRate*100)/100);assert.equal(value.netPay,Math.round((value.grossPay-value.deductions)*100)/100);
 assert.equal(payrollDeductionDisplayTotal(value),value.deductions);assert.equal(value.overtimeHours,0);
 assert.ok(computed.dtr.rows.some(row=>/0?8:05/.test(row.timeOut)));assert.ok(computed.dtr.rows.filter(row=>row.status==='Scheduled').every(row=>row.absenceMinutes===0));
 assert.equal(await evidence(),before);
});

test("restored Pending, Paid and Completed summaries stay saved while a separate attendance comparison uses their saved salary",async context=>{
 configureMinutePolicy(context);await fixture({mixed:true});await freezeHistoricalInputs();
 await runWithBusiness(businesses[0],()=>Employee.updateOne({employeeCode:code},{$set:{salary:2000}}));
 for(const status of ['Pending','Paid','Completed']){
  for(const business of businesses)await runWithBusiness(business,()=>PayrollRecord.updateMany({},{$set:{status}}));
  const before=await evidence(),result=await read('/payroll/dtr/'+code+'?'+new URLSearchParams({payPeriod:period,basis:'payment'}));assert.equal(result.status,200);
  assert.equal(result.data.summary.netPay,489);assert.equal(result.data.summary.deductions,1);assert.equal(result.data.summary.status,status);
  assert.ok(result.data.attendanceComparison,result.data.attendanceComparisonWarning);assert.equal(result.data.attendanceComparison.summary.calculationSnapshot.monthlySalary,1000);
  const reference=result.data.attendanceComparison.summary,rest=reference.excessBreakMinutes+reference.excessLunchMinutes+(reference.nonBillableOffPhoneMinutes||0);assert.equal(reference.deductions,Math.min(reference.grossPay,Math.round(rest*reference.minuteRate*100)/100));
  assert.equal(result.data.attendanceComparison.summary.calculationVersion,'earned-minute-capped-v1');assert.equal(result.data.attendanceComparison.referenceOnly,true);assert.equal(await evidence(),before);
 }
});

test("a restored cutoff without a saved salary returns a comparison warning instead of borrowing today's salary or rewriting amounts",async context=>{
 configureMinutePolicy(context);await fixture();for(const business of businesses)await runWithBusiness(business,()=>PayrollRecord.updateMany({},{$unset:{'calculationSnapshot.monthlySalary':''}}));
 const before=await evidence(),result=await read('/payroll/dtr/'+code+'?'+new URLSearchParams({payPeriod:period,basis:'payment'}));assert.equal(result.status,200);
 assert.equal(result.data.summary.netPay,489);assert.equal(result.data.attendanceComparison,undefined);assert.match(result.data.attendanceComparisonWarning,/saved monthly salary/i);assert.equal(await evidence(),before);
});

async function inheritedFutureFixture() {
 const active='Nov 6, 2026 - Nov 20, 2026',added=businesses[6];await fixture({start:'2026-11-06',end:'2026-11-20',period:active,future:true,mixed:true});
 for(const business of businesses.slice(0,6))await runWithBusiness(business,()=>PayrollRecord.updateMany({},{$set:{payPeriod:period,status:'Paid'}}));
 await runWithBusiness(added,async()=>{await PayrollRecord.deleteMany({});await SystemSettings.updateOne({key:'system'},{$set:{officialShiftStartTime:'',officialShiftEndTime:''}});});
 await AttendanceLedger.updateOne({_id:'synthetic-fixed-ledger'},{$set:{businessIds:businesses.slice(0,6)}});
 const {PayrollGenerationPolicy}=await import('../models/PayrollGenerationPolicy'),{generateFutureMissingPayroll}=await import('./payrollMissingGeneration');
 for(const business of businesses)await runWithBusiness(business,()=>PayrollGenerationPolicy.updateOne({_id:'missing-current-payroll'},{$set:{enabled:business===businesses[0],startsAfter:'2026-11-05',actor:'90000001',enabledAt:new Date()}},{upsert:true}));
 assert.equal((await runWithBusiness(businesses[0],()=>generateFutureMissingPayroll()))?.mirrors,7);
 return {active,added};
}

test("the independent worker generates consecutive future cutoffs once, including established inherited copies, without changing restored or Paid payroll",async context=>{
 configureMinutePolicy(context);const {active,added}=await inheritedFutureFixture();
 for(const business of businesses)await runWithBusiness(business,()=>PayrollRecord.updateMany({payPeriod:active},{$set:{status:'Paid',paidOn:'Nov 21, 2026'}}));
 const settings=JSON.stringify(await Promise.all(businesses.map(business=>runWithBusiness(business,()=>SystemSettings.find().lean())))),before=JSON.parse(await evidence());
 const {runPayrollGeneration}=await import('./payrollGenerationWorker');
 for(const[date,label]of [['2026-11-21T00:00:00Z','Nov 21, 2026 - Dec 5, 2026'],['2026-12-06T00:00:00Z','Dec 6, 2026 - Dec 20, 2026']]){
  context.mock.timers.setTime(Date.parse(date));await Promise.all([runPayrollGeneration(),runPayrollGeneration()]);
  for(const business of businesses)await runWithBusiness(business,async()=>{const rows=await PayrollRecord.find({payPeriod:label}).lean();assert.equal(rows.length,1);assert.equal(rows[0].calculationVersion,'earned-minute-capped-v1');assert.equal(rows[0].status,'Pending');assert.equal(rows[0].grossPay,0);assert.equal(rows[0].absenceMinutes,0);});
  const inherited=(await runWithBusiness(added,()=>PayrollRecord.findOne({payPeriod:label}).lean()))!;assert.equal(inherited.calculationSnapshot?.inheritedPayrollInputs,true);assert.equal(inherited.payrollOwnerBusinessId,businesses[0]);
  const once=await evidence();await runPayrollGeneration();assert.equal(await evidence(),once);
 }
 const after=JSON.parse(await evidence());assert.deepEqual(after.ledger,before.ledger);for(const[index,business]of after.businesses.entries()){assert.deepEqual(business.attendance,before.businesses[index].attendance);assert.deepEqual(business.payroll.filter((row:{payPeriod:string})=>[period,active].includes(row.payPeriod)),before.businesses[index].payroll);}
 assert.equal(JSON.stringify(await Promise.all(businesses.map(business=>runWithBusiness(business,()=>SystemSettings.find().lean())))),settings);
});

test("future generation refuses unverified inheritance history and never rewrites an earlier business copy",async context=>{
 configureMinutePolicy(context);const {active,added}=await inheritedFutureFixture();
 await runWithBusiness(added,()=>PayrollRecord.updateOne({payPeriod:active},{$unset:{'calculationSnapshot.inheritedPayrollInputs':''}}));
 await runWithBusiness(added,()=>Attendance.create({employee:owners[6],source:'Time In',timeIn:new Date('2026-11-21T15:00:00Z')}));
 const before=await evidence();context.mock.timers.setTime(Date.parse('2026-11-21T16:00:00Z'));
 const {previewMissingPayroll,generateFutureMissingPayroll}=await import('./payrollMissingGeneration'),plan=await runWithBusiness(businesses[0],()=>previewMissingPayroll());
 assert.equal(plan.rows.length,0);assert.equal(plan.held.length,1);assert.equal(await runWithBusiness(businesses[0],()=>generateFutureMissingPayroll()),null);assert.equal(await evidence(),before);
});

test("only explicit approval freezes the reviewed minute-accrual amount, while restored payroll and attendance remain untouched",async context=>{
 configureMinutePolicy(context,new Date('2026-11-21T02:00:00Z'));const active='Nov 6, 2026 - Nov 20, 2026';await fixture({start:'2026-11-06',end:'2026-11-20',period:active,mixed:true});
 for(const business of businesses)await runWithBusiness(business,()=>PayrollRecord.create({employeeId:code,employeeName:'Synthetic Restored Payroll',department:'Synthetic',payType:'Semi-monthly',payPeriod:period,
  basicPay:500,grossPay:490,deductions:1,netPay:489,status:'Paid',paidOn:'Nov 10, 2026',calculationSnapshot:{monthlySalary:1000},isArchived:false}));
 const owner=(await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({payPeriod:active}).lean()))!,route='/payroll/records/'+owner._id+'/payment-status',before=JSON.parse(await evidence());
 const preview=await read(route+'/preview',businesses[0],{paid:true});assert.equal(preview.status,200);assert.equal(preview.data.canApply,true,JSON.stringify(preview.data.blockers));assert.equal(preview.data.currentCutoffDraft,true);
 assert.equal(await evidence(),JSON.stringify(before));
 const approved=await read(route+'/confirm',businesses[0],{paid:true,token:preview.data.token,confirm:true,acknowledgeAttendance:true,reason:'Synthetic explicit approval of minute-accrual payroll'});assert.equal(approved.status,200,JSON.stringify(approved.data));
 for(const[index,business]of businesses.entries())await runWithBusiness(business,async()=>{const saved=(await PayrollRecord.findOne({payPeriod:active}).lean())!;assert.equal(saved.status,'Paid');assert.equal(saved.calculationVersion,'earned-minute-capped-v1');assert.equal(saved.netPay,preview.data.rows[index].netPay);assert.equal(saved.deductions,preview.data.rows[index].deductions);assert.deepEqual(JSON.parse(JSON.stringify(await PayrollRecord.find({payPeriod:period}).lean())),before.businesses[index].payroll.filter((row:{payPeriod:string})=>row.payPeriod===period));});
 const after=JSON.parse(await evidence());assert.deepEqual(after.ledger,before.ledger);for(const[index,entry]of after.businesses.entries())assert.deepEqual(entry.attendance,before.businesses[index].attendance);
 const frozen=await evidence();assert.equal((await read(route+'/confirm',businesses[0],{paid:true,token:preview.data.token,confirm:true,acknowledgeAttendance:true,reason:'Synthetic rejected replay'})).status,409);assert.equal(await evidence(),frozen);
});

test("unpaid minute accrual uses the configured monthly salary in seven businesses without overwriting an older generated snapshot",async context=>{
 const clock=new Date('2026-11-09T22:00:00Z');configureMinutePolicy(context,clock);const active=await currentGenerationClockFixture(clock);
 const {PayrollGenerationPolicy}=await import('../models/PayrollGenerationPolicy'),{generateFutureMissingPayroll}=await import('./payrollMissingGeneration');
 await runWithBusiness(businesses[0],()=>PayrollGenerationPolicy.updateOne({_id:'missing-current-payroll'},{$set:{enabled:true,startsAfter:'2026-11-05',actor:'90000001',enabledAt:clock}},{upsert:true}));
 await runWithBusiness(businesses[0],()=>generateFutureMissingPayroll());
 for(const business of businesses)await runWithBusiness(business,()=>Employee.updateOne({employeeCode:code},{$set:{salary:30000}}));
 const before=await evidence(),expected=(await candidate(active)).value;
 assert.equal(expected.basicPay,15000);assert.ok(expected.grossPay<15000);
 for(const business of businesses){const list=await read('/payroll/records?'+new URLSearchParams({payPeriod:active}),business);assert.equal(list.status,200);const shown=list.data[0];
  assert.equal(shown.calculationSnapshot.monthlySalary,30000);assert.equal(shown.basicPay,15000);assert.equal(shown.netPay,expected.netPay);assert.equal(shown.minuteRate,expected.minuteRate);
  const dtr=await read('/payroll/dtr/'+code+'?'+new URLSearchParams({payPeriod:active,basis:'payment'}),business);assert.equal(dtr.data.summary.netPay,expected.netPay);
  const payments=(await runWithBusiness(business,()=>employeePayments(code))).items[0];assert.equal(payments.netPay,expected.netPay);assert.equal(payments.basicPay,15000);
 }
 context.mock.timers.tick(60000);const later=(await read('/payroll/records?'+new URLSearchParams({payPeriod:active}))).data[0];assert.ok(later.netPay>expected.netPay);assert.equal(later.basicPay,15000);assert.equal(await evidence(),before);
 for(const business of businesses)await runWithBusiness(business,async()=>{assert.equal((await PayrollRecord.findOne({payPeriod:active}).lean())?.calculationSnapshot?.monthlySalary,1000);});
});

test("a configured salary change invalidates a pending minute payment approval and a fresh explicit approval freezes the matching calculation",async context=>{
 configureMinutePolicy(context,new Date('2026-11-21T02:00:00Z'));const active='Nov 6, 2026 - Nov 20, 2026';await fixture({start:'2026-11-06',end:'2026-11-20',period:active,mixed:true});
 for(const business of businesses)await runWithBusiness(business,()=>Employee.updateOne({employeeCode:code},{$set:{salary:2000}}));
 const owner=(await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({payPeriod:active}).lean()))!,route='/payroll/records/'+owner._id+'/payment-status';
 const first=await read(route+'/preview',businesses[0],{paid:true});assert.equal(first.data.canApply,true,JSON.stringify(first.data.blockers));
 for(const business of businesses)await runWithBusiness(business,()=>Employee.updateOne({employeeCode:code},{$set:{salary:3000}}));
 const before=await evidence(),confirm=(token:string)=>read(route+'/confirm',businesses[0],{paid:true,token,confirm:true,acknowledgeAttendance:true,reason:'Synthetic approved current salary basis'});
 assert.equal((await confirm(first.data.token)).status,409);assert.equal(await evidence(),before);
 const fresh=await read(route+'/preview',businesses[0],{paid:true});assert.equal(fresh.data.canApply,true,JSON.stringify(fresh.data.blockers));assert.notEqual(fresh.data.rows[0].netPay,first.data.rows[0].netPay);
 assert.equal((await confirm(fresh.data.token)).status,200);
 for(const[index,business]of businesses.entries())await runWithBusiness(business,async()=>{const record=(await PayrollRecord.findOne({payPeriod:active}).lean())!;assert.equal(record.status,'Paid');assert.equal(record.calculationSnapshot?.monthlySalary,3000);assert.equal(record.netPay,fresh.data.rows[index].netPay);});
 const frozen=await evidence();for(const business of businesses)await runWithBusiness(business,()=>Employee.updateOne({employeeCode:code},{$set:{salary:4000}}));
 for(const business of businesses){const rows=await read('/payroll/records?'+new URLSearchParams({payPeriod:active}),business);assert.equal(rows.data[0].netPay,fresh.data.rows[0].netPay);assert.equal(rows.data[0].status,'Paid');}
 assert.equal(await evidence(),frozen);
});

test("inherited current copies use the owner's configured minute salary while saved snapshots remain unchanged",async context=>{
 configureMinutePolicy(context);const {active,added}=await inheritedFutureFixture();
 for(const business of businesses)await runWithBusiness(business,()=>Employee.updateOne({employeeCode:code},{$set:{salary:30000}}));
 context.mock.timers.setTime(Date.parse('2026-11-21T02:00:00Z'));
 const before=await evidence(),owner=(await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({payPeriod:active}).lean()))!;
 const payments=(await runWithBusiness(added,()=>employeePayments(code,1,'history'))).items.find(row=>row.payPeriod===active)!;assert.ok(payments);assert.equal(payments.basicPay,15000);assert.equal(payments.monthlySalary,30000);
 const preview=await read('/payroll/records/'+owner._id+'/payment-status/preview',businesses[0],{paid:true});assert.equal(preview.status,200);assert.equal(preview.data.canApply,true,JSON.stringify(preview.data.blockers));
 assert.ok(preview.data.rows.every((row:{netPay:number})=>row.netPay===payments.netPay));assert.equal(await evidence(),before);
});

test("dated historical comparison uses actual recorded paid minutes, not fixed salary shortfall hours",async context=>{
 configureMinutePolicy(context);await fixture({mixed:true});await freezeHistoricalInputs();const before=await evidence();
 const result=await read('/payroll/dtr/'+code+'?'+new URLSearchParams({payPeriod:period,basis:'payment'}));assert.equal(result.status,200);
 const comparison=result.data.attendanceComparison;assert.ok(comparison,result.data.attendanceComparisonWarning);assert.equal(comparison.referenceOnly,true);assert.equal(comparison.basis,'dated-earned-minutes');
 assert.equal(comparison.summary.workedHours,comparison.rows.reduce((sum:number,row:{regularHours:number})=>sum+row.regularHours,0));
 const rest=comparison.summary.excessBreakMinutes+comparison.summary.excessLunchMinutes+(comparison.summary.nonBillableOffPhoneMinutes||0);assert.equal(comparison.summary.deductibleMinutes,rest);
 assert.equal(comparison.summary.deductions,Math.min(comparison.summary.grossPay,Math.round(rest*comparison.summary.minuteRate*100)/100));
 assert.equal(comparison.summary.grossPay,Math.min(comparison.summary.basicPay,Math.round(comparison.summary.earnedGrossHours*60*comparison.summary.minuteRate*100)/100));
 assert.equal(result.data.summary.netPay,489);assert.equal(result.data.summary.workedHours,95);assert.equal(result.data.summary.deductions,1);
 assert.deepEqual(result.data.rows,comparison.rows);assert.equal(comparison.summary.overtimeHours,0);assert.equal(await evidence(),before);
});

test("historical shift, allowances and salary stay frozen when today's configuration changes",async context=>{
 configureMinutePolicy(context);await fixture({mixed:true});await freezeHistoricalInputs();
 const route='/payroll/dtr/'+code+'?'+new URLSearchParams({payPeriod:period,basis:'payment'}),first=await read(route);assert.ok(first.data.attendanceComparison);
 await AttendancePolicy.updateOne({_id:'global-attendance'},{$set:{shiftStart:'09:00',shiftEnd:'18:00',breakMinutes:10,lunchMinutes:30,graceMinutes:0},$inc:{revision:1}});
 for(const business of businesses)await runWithBusiness(business,async()=>{await Employee.updateOne({employeeCode:code},{$set:{salary:2000}});await SystemSettings.updateOne({key:'system'},{$set:{officialShiftStartTime:'09:00',officialShiftEndTime:'18:00'}});});
 const before=await evidence(),second=await read(route);assert.ok(second.data.attendanceComparison,second.data.attendanceComparisonWarning);
 assert.deepEqual(second.data.attendanceComparison.summary,first.data.attendanceComparison.summary);assert.deepEqual(second.data.rows,first.data.rows);
 assert.equal(second.data.attendanceComparison.summary.calculationSnapshot.monthlySalary,1000);assert.equal(second.data.summary.netPay,489);assert.equal(await evidence(),before);
});

test("a short completed historical day retains its actual paid minutes without double-charging unworked time",async context=>{
 configureMinutePolicy(context);await fixture({shortDay:true});await freezeHistoricalInputs();
 const ledger=(await AttendanceLedger.findById('synthetic-fixed-ledger').lean())!,firstDay=ledger.events[0].shift!.dayKey,last=Date.parse(firstDay+'T15:38:00Z');
 await AttendanceLedger.updateOne({_id:ledger._id},{$set:{events:ledger.events.filter(event=>Date.parse(event.at)<=last)}});
 for(const business of businesses)await runWithBusiness(business,()=>Attendance.deleteMany({timeIn:{$gt:new Date(last)}}));
 const before=await evidence(),result=await read('/payroll/dtr/'+code+'?'+new URLSearchParams({payPeriod:period,basis:'payment'}));const comparison=result.data.attendanceComparison;assert.ok(comparison,result.data.attendanceComparisonWarning);
 assert.equal(comparison.summary.workedHours,38/60);assert.equal(comparison.summary.earnedGrossHours,38/60);assert.equal(comparison.summary.deductions,0);assert.ok(comparison.summary.absenceMinutes>0);assert.ok(comparison.summary.netPay>0&&comparison.summary.netPay<500);
 assert.equal(comparison.rows.find((row:{dateKey:string})=>row.dateKey===firstDay).regularHours,38/60);assert.equal(result.data.summary.netPay,489);assert.equal(await evidence(),before);
});

test("missing historical inputs and contradictory assigned shifts are not guessed or repaired",async context=>{
 configureMinutePolicy(context);await fixture();const route='/payroll/dtr/'+code+'?'+new URLSearchParams({payPeriod:period,basis:'payment'});
 let before=await evidence(),result=await read(route);assert.equal(result.data.attendanceComparison,undefined);assert.match(result.data.attendanceComparisonWarning,/saved cutoff shift/);assert.equal(await evidence(),before);
 await freezeHistoricalInputs();await AttendanceLedger.updateOne({_id:'synthetic-fixed-ledger'},{$set:{'events.0.shift.start':'2026-10-21T14:00:00.000Z'}});before=await evidence();result=await read(route);
 assert.equal(result.data.attendanceComparison,undefined);assert.match(result.data.attendanceComparisonWarning,/needs review/);assert.equal(result.data.summary.netPay,489);assert.equal(await evidence(),before);
});

test("historical comparison rejects another employee and any other cutoff without authorizing writes",async context=>{
 configureMinutePolicy(context);await fixture();await freezeHistoricalInputs();const {historicalPayrollComparison}=await import('./historicalPayrollComparison');
 const employee=(await runWithBusiness(businesses[0],()=>Employee.findOne({employeeCode:code}).lean()))!,record=(await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({payPeriod:period}).lean()))!,before=await evidence();
 await assert.rejects(runWithBusiness(businesses[0],()=>historicalPayrollComparison({...employee,employeeCode:'other-synthetic'},record)),/limited to its saved cutoff and employee/);
 await assert.rejects(runWithBusiness(businesses[0],()=>historicalPayrollComparison(employee,{...record,payPeriod:'Nov 6, 2026 - Nov 20, 2026'})),/limited to its saved cutoff and employee/);
 assert.equal(await evidence(),before);
});

test("events outside the historical cutoff are excluded and the original overnight 08:05 checkout keeps its shift day",async context=>{
 configureMinutePolicy(context);await fixture({mixed:true});await freezeHistoricalInputs();
 const route='/payroll/dtr/'+code+'?'+new URLSearchParams({payPeriod:period,basis:'payment'}),first=await read(route);assert.ok(first.data.attendanceComparison);
 const ledger=(await AttendanceLedger.findById('synthetic-fixed-ledger').lean())!,extra:SessionEvent[]=[];
 for(const day of ['2026-10-20','2026-11-06']){const start=new Date(day+'T15:00:00Z'),end=new Date(+start+545*60000);
  for(const[source,at]of [['Time In',start],['Time Out',end]] as const){const id=`outside-${day}-${source}`;extra.push({id,commandId:id,sequence:0,source,at:at.toISOString(),recordedAt:at.toISOString(),...(source==='Time In'?{shift:assignAttendanceShift(start)}:{})});}
 }
 const events=[...ledger.events,...extra].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.sequence-b.sequence).map((event,sequence)=>({...event,sequence}));
 await AttendanceLedger.updateOne({_id:ledger._id},{$set:{events}});
 for(const[index,business]of businesses.entries())await runWithBusiness(business,async()=>{await Attendance.deleteMany({employee:owners[index]});await Attendance.insertMany(events.map(event=>({employee:owners[index],source:event.source,timeIn:new Date(event.at),eventId:event.id,sequence:event.sequence,ledgerIdentity:ledger._id,ledgerRevision:1,isEffective:true})));});
 const before=await evidence(),second=await read(route);assert.ok(second.data.attendanceComparison,second.data.attendanceComparisonWarning);
 assert.deepEqual(second.data.attendanceComparison.summary,first.data.attendanceComparison.summary);assert.deepEqual(second.data.rows,first.data.rows);
 assert.ok(second.data.rows.every((row:{dateKey:string})=>row.dateKey>='2026-10-21'&&row.dateKey<='2026-11-05'));
 assert.match(second.data.rows.find((row:{dateKey:string})=>row.dateKey==='2026-11-05').timeOut,/0?8:05/);assert.equal(second.data.attendanceComparison.summary.overtimeHours,0);assert.equal(await evidence(),before);
});

function configureEqualHalfPolicy(context:TestContext,clock=new Date('2026-12-06T02:00:00Z')){
 configureMinutePolicy(context,clock);const before=process.env.CRM_EQUAL_HALF_CUTOFF_FROM;process.env.CRM_EQUAL_HALF_CUTOFF_FROM='2026-11-21';context.after(()=>{if(before===undefined)delete process.env.CRM_EQUAL_HALF_CUTOFF_FROM;else process.env.CRM_EQUAL_HALF_CUTOFF_FROM=before;});
}

test("future linked preview uses verified owner inputs across seven businesses without generating or changing payroll",async context=>{
 configureEqualHalfPolicy(context,now);await inheritedFutureFixture();await AttendancePolicy.deleteMany({});const before=await evidence(),settings=JSON.stringify(await Promise.all(businesses.map(business=>runWithBusiness(business,()=>SystemSettings.find().lean()))));
 for(const label of ['Nov 21, 2026 - Dec 5, 2026','Dec 6, 2026 - Dec 20, 2026']){
  const original=await read('/payroll/dtr/'+code+'?'+new URLSearchParams({payPeriod:label,basis:'payment'}));assert.equal(original.status,200);
  for(const [index,business]of businesses.entries())for(let refresh=0;refresh<2;refresh++){
   const response=await read('/payroll/dtr/'+code+'?'+new URLSearchParams({payPeriod:label,basis:'payment'}),business);assert.equal(response.status,200,'Linked future DTR must not require local shift settings');
   assert.equal(response.data.employee._id,String(owners[index]));assert.equal(response.data.employee.employeeCode,code);assert.equal(response.data.storedCutoff,false);
   assert.equal(response.data.summary.basicPay,500);assert.equal(response.data.summary.grossPay,0);assert.equal(response.data.summary.deductions,0);assert.equal(response.data.summary.netPay,0);assert.equal(response.data.summary.absenceMinutes,0);assert.equal(response.data.summary.overtimeHours,0);
   assert.equal(response.data.summary.minuteRate,original.data.summary.minuteRate);assert.equal(response.data.summary.hourlyRate,original.data.summary.hourlyRate);assert.equal(response.data.summary.calculationSnapshot.rateBasis,'equal-half-cutoff-v1');assert.deepEqual(response.data.rows,original.data.rows);
  }
 }
 assert.equal(await evidence(),before);assert.equal(JSON.stringify(await Promise.all(businesses.map(business=>runWithBusiness(business,()=>SystemSettings.find().lean())))),settings);assert.equal(await getCallBridgeScheduleModel().countDocuments(),0);
});

const linkedFuturePeriod='Nov 21, 2026 - Dec 5, 2026';
async function linkedPreviewFixture(context:TestContext){configureEqualHalfPolicy(context,now);const result=await inheritedFutureFixture();await AttendancePolicy.deleteMany({});return result;}
async function linkedPreviewEvidence(){const {getBusinessAccessForEmployeeCode}=await import('../models/BusinessUserAccess');return JSON.stringify({records:JSON.parse(await evidence()),access:await getBusinessAccessForEmployeeCode(code),policy:await AttendancePolicy.find().lean(),businesses:await Promise.all(businesses.map(business=>runWithBusiness(business,async()=>({settings:await SystemSettings.find().lean(),people:await Employee.find().lean()}))))});}
const linkedPreviewRoute=(period=linkedFuturePeriod,basis='payment')=>'/payroll/dtr/'+code+'?'+new URLSearchParams({payPeriod:period,basis});

test("future linked preview keeps saved current and historical reads and saved-only future rejection unchanged",async context=>{
 const {active,added}=await linkedPreviewFixture(context),current=await read(linkedPreviewRoute(active),added),history=await read(linkedPreviewRoute(period,'saved')),before=await linkedPreviewEvidence();assert.equal(current.status,200);assert.equal(history.status,200);
 assert.equal((await read(linkedPreviewRoute(),added)).status,200);assert.deepEqual(await read(linkedPreviewRoute(active),added),current);assert.deepEqual(await read(linkedPreviewRoute(period,'saved')),history);assert.equal((await read(linkedPreviewRoute(linkedFuturePeriod,'saved'),added)).status,422);assert.equal(await linkedPreviewEvidence(),before);
});

test("future linked preview never applies to current historical or incomplete cutoff ranges",async context=>{
 const {active,added}=await linkedPreviewFixture(context),{inheritedFuturePayrollPreviewInputs}=await import('./payrollCanonicalInputs'),person=(await runWithBusiness(added,()=>Employee.findOne({employeeCode:code}).lean()))!;
 for(const label of [period,active])assert.equal(await runWithBusiness(added,()=>inheritedFuturePayrollPreviewInputs(person,label)),null);
 const before=await linkedPreviewEvidence();assert.equal((await read(linkedPreviewRoute('Nov 22, 2026 - Nov 30, 2026'),added)).status,422);context.mock.timers.setTime(Date.parse('2026-11-21T02:00:00Z'));assert.equal((await read(linkedPreviewRoute(),added)).status,422);assert.equal(await linkedPreviewEvidence(),before);
});

test("future linked preview requires the established inherited current-copy proof",async context=>{
 const {active,added}=await linkedPreviewFixture(context),record=(await runWithBusiness(added,()=>PayrollRecord.findOne({payPeriod:active}).lean()))!;
 for(const change of [{'calculationSnapshot.inheritedPayrollInputs':false},{'calculationSnapshot.payrollInputsBusinessId':businesses[1]},{'calculationSnapshot.businessIds':[businesses[0]]}]){
  await runWithBusiness(added,()=>PayrollRecord.updateOne({_id:record._id},{$set:change}));const before=await linkedPreviewEvidence();assert.equal((await read(linkedPreviewRoute(),added)).status,422);assert.equal(await linkedPreviewEvidence(),before);await runWithBusiness(added,()=>PayrollRecord.updateOne({_id:record._id},{$set:{calculationSnapshot:record.calculationSnapshot}}));
 }
});

test("future linked preview refuses revoked owner or requesting-business membership",async context=>{
 const {added}=await linkedPreviewFixture(context);for(const removed of [businesses[0],added]){await setBusinessAccessForEmployeeCode(code,businesses.filter(business=>business!==removed));const before=await linkedPreviewEvidence();assert.equal((await read(linkedPreviewRoute(),added)).status,422);assert.equal(await linkedPreviewEvidence(),before);}await setBusinessAccessForEmployeeCode(code,businesses);
});

test("future linked preview refuses migrated or contradictory canonical attendance ownership",async context=>{
 const {added}=await linkedPreviewFixture(context);for(const change of [{migrationRequired:true},{canonicalBusinessId:businesses[1]}]){await AttendanceLedger.updateOne({_id:'synthetic-fixed-ledger'},{$set:change},{strict:false});const before=await linkedPreviewEvidence();assert.equal((await read(linkedPreviewRoute(),added)).status,422);assert.equal(await linkedPreviewEvidence(),before);await AttendanceLedger.updateOne({_id:'synthetic-fixed-ledger'},{$set:{migrationRequired:false,canonicalBusinessId:businesses[0]}},{strict:false});}
 const ledger=(await AttendanceLedger.findById('synthetic-fixed-ledger').lean())!;await AttendanceLedger.create({...ledger,_id:'synthetic-second-owner-ledger'});const before=await linkedPreviewEvidence();assert.equal((await read(linkedPreviewRoute(),added)).status,422);assert.equal(await linkedPreviewEvidence(),before);
});

test("future linked preview refuses salary mismatch and unavailable owner employees",async context=>{
 const {added}=await linkedPreviewFixture(context);await runWithBusiness(added,()=>Employee.updateOne({employeeCode:code},{$set:{salary:1001}}));let before=await linkedPreviewEvidence();assert.equal((await read(linkedPreviewRoute(),added)).status,422);assert.equal(await linkedPreviewEvidence(),before);await runWithBusiness(added,()=>Employee.updateOne({employeeCode:code},{$set:{salary:1000}}));await runWithBusiness(businesses[0],()=>Employee.updateOne({employeeCode:code},{$set:{status:'Archived'}}));before=await linkedPreviewEvidence();assert.equal((await read(linkedPreviewRoute(),added)).status,422);assert.equal(await linkedPreviewEvidence(),before);
});

test("future linked preview cannot replace an archived or aliased local future cutoff",async context=>{
 const {active,added}=await linkedPreviewFixture(context),record=(await runWithBusiness(added,()=>PayrollRecord.findOne({payPeriod:active}).lean()))!;await runWithBusiness(added,()=>PayrollRecord.create({...record,_id:new mongoose.Types.ObjectId(),payPeriod:'2026-11-21 - 2026-12-05',isArchived:true,status:'Paid'}));const before=await linkedPreviewEvidence();assert.equal((await read(linkedPreviewRoute(),added)).status,422);assert.equal(await linkedPreviewEvidence(),before);
});

test("future linked preview refuses a saved owner cutoff or missing current owner proof",async context=>{
 const {active,added}=await linkedPreviewFixture(context),record=(await runWithBusiness(businesses[0],()=>PayrollRecord.findOne({payPeriod:active}).lean()))!,future=await runWithBusiness(businesses[0],()=>PayrollRecord.create({...record,_id:new mongoose.Types.ObjectId(),payPeriod:linkedFuturePeriod,status:'Paid'}));let before=await linkedPreviewEvidence();assert.equal((await read(linkedPreviewRoute(),added)).status,422);assert.equal(await linkedPreviewEvidence(),before);await runWithBusiness(businesses[0],()=>PayrollRecord.deleteOne({_id:future._id}));await runWithBusiness(businesses[0],()=>PayrollRecord.updateOne({_id:record._id},{$set:{isArchived:true}}));before=await linkedPreviewEvidence();assert.equal((await read(linkedPreviewRoute(),added)).status,422);assert.equal(await linkedPreviewEvidence(),before);
});

test("future linked preview never ignores local future attendance or invents owner shift settings",async context=>{
 const {added}=await linkedPreviewFixture(context),punch=await runWithBusiness(added,()=>Attendance.create({employee:owners[6],source:'Time In',timeIn:new Date('2026-11-23T15:00:00Z')}));let before=await linkedPreviewEvidence();assert.equal((await read(linkedPreviewRoute(),added)).status,422);assert.equal(await linkedPreviewEvidence(),before);await runWithBusiness(added,()=>Attendance.deleteOne({_id:punch._id}));await runWithBusiness(businesses[0],()=>SystemSettings.updateOne({key:'system'},{$set:{officialShiftStartTime:'',officialShiftEndTime:''}}));before=await linkedPreviewEvidence();assert.equal((await read(linkedPreviewRoute(),added)).status,422);assert.equal(await linkedPreviewEvidence(),before);
});

test("future linked preview leaves independent attendance review errors blocked",async context=>{
 await linkedPreviewFixture(context);const ledger=(await AttendanceLedger.findById('synthetic-fixed-ledger').lean())!,at=new Date('2026-11-23T15:00:00Z'),event={id:'synthetic-future-review',commandId:'synthetic-future-review',sequence:ledger.events.length,source:'Time In' as const,at:at.toISOString(),recordedAt:at.toISOString(),shift:assignAttendanceShift(at)};await AttendanceLedger.updateOne({_id:ledger._id},{$push:{events:event}});const before=await linkedPreviewEvidence(),response=await read(linkedPreviewRoute(),businesses[1]);assert.equal(response.status,422);assert.match(response.data.message,/attendance.*review/i);assert.equal(await linkedPreviewEvidence(),before);
});
test("new shorter cutoffs earn exactly half salary across seven business reads and Profile Payments without writing saved amounts",async context=>{
 configureEqualHalfPolicy(context);const label='Nov 21, 2026 - Dec 5, 2026';await fixture({start:'2026-11-21',end:'2026-12-05',period:label,earlyIn:true});
 const before=await evidence(),computed=await candidate(label);assert.equal(computed.value.basicPay,500);assert.equal(computed.value.grossPay,500);assert.equal(computed.value.netPay,500);assert.equal(computed.rates.cutoffWorkingDays,10);assert.equal(computed.rates.cutoffEquivalentWorkingDays,10.5);assert.equal(computed.value.workedHours,80);assert.equal(computed.value.overtimeHours,0);assert.equal(computed.value.nonBillableOffPhoneMinutes,0);
 for(const business of businesses)for(let refresh=0;refresh<2;refresh++){const response=await read('/payroll/records?'+new URLSearchParams({payPeriod:label}),business);assert.equal(response.status,200);const value=response.data[0];assert.equal(value.netPay,500);assert.equal(value.hourlyRate,500/80);assert.equal(value.calculationSnapshot.rateBasis,'equal-half-cutoff-v1');const history=await runWithBusiness(business,()=>employeePayments(code,1,'history'));const item=history.items.find(row=>row.cutoffStart==='2026-11-21')!;assert.equal(item.netPay,500);assert.equal(item.hourlyRate,value.hourlyRate);}
 assert.equal(await evidence(),before);assert.equal(await getCallBridgeScheduleModel().countDocuments(),0);
});
test("new 11-day and 12-day cutoffs in a 23-workday cycle each earn half salary with real recorded hours",async context=>{
 configureEqualHalfPolicy(context,new Date('2027-08-06T02:00:00Z'));const {payrollRatesForCutoff}=await import('../controllers/payrollController');
 const cases:Array<{start:string;end:string;label:string;days:number}>=[];for(let month=0;month<12&&!cases.length;month++){const first=new Date(Date.UTC(2027,month,6)),middle=new Date(Date.UTC(2027,month,21)),next=new Date(Date.UTC(2027,month+1,6)),key=(value:Date)=>value.toISOString().slice(0,10),labels=[{start:key(first),end:key(new Date(+middle-86400000))},{start:key(middle),end:key(new Date(+next-86400000))}];const rates=payrollRatesForCutoff(1000,labels[0].start+' - '+labels[0].end,{officialShiftStartTime:'23:00',officialShiftEndTime:'08:00'},{lunchMinutes:60});if(rates.monthlyWorkingDays===23)for(const row of labels){const label=row.start+' - '+row.end,r=payrollRatesForCutoff(1000,label,{officialShiftStartTime:'23:00',officialShiftEndTime:'08:00'},{lunchMinutes:60});cases.push({...row,label,days:r.cutoffWorkingDays!});}}
 assert.equal(cases.length,2);assert.equal(cases.reduce((sum,row)=>sum+row.days,0),23);
 for(const [index,row]of cases.entries()){if(index){await AttendanceLedger.deleteMany({});for(const business of businesses)await runWithBusiness(business,async()=>{await Attendance.deleteMany({});await PayrollRecord.deleteMany({});});}context.mock.timers.setTime(Date.parse(row.end+'T02:00:00Z')+86400000);await fixture({start:row.start,end:row.end,period:row.label});const before=await evidence(),value=await candidate(row.label);assert.equal(value.rates.cutoffEquivalentWorkingDays,11.5);assert.equal(value.value.workedHours,row.days*8);assert.equal(value.value.netPay,500);assert.equal(await evidence(),before);}
});
test("new cutoff absence remains unearned time and is never charged again",async context=>{
 configureEqualHalfPolicy(context);const label='Nov 21, 2026 - Dec 5, 2026';await fixture({start:'2026-11-21',end:'2026-12-05',period:label,absent:true});const before=await evidence(),value=(await candidate(label)).value;
 assert.equal(value.absenceMinutes,480);assert.equal(value.deductibleMinutes,0);assert.equal(value.grossPay,450);assert.equal(value.deductions,0);assert.equal(value.netPay,450);assert.equal(value.overtimeHours,0);assert.equal(await evidence(),before);
});
test("new cutoff excess break/lunch and non-billable minutes are charged once while Coaching stays paid",async context=>{
 configureEqualHalfPolicy(context);const label='Nov 21, 2026 - Dec 5, 2026';await fixture({start:'2026-11-21',end:'2026-12-05',period:label,mixed:true});const before=await evidence(),computed=await candidate(label),value=computed.value,rest=value.excessBreakMinutes+value.excessLunchMinutes+(value.nonBillableOffPhoneMinutes||0);
 assert.equal(value.lateMinutes,5);assert.equal(value.earlyTimeOutMinutes,10);assert.equal(value.excessBreakMinutes,2);assert.equal(value.excessLunchMinutes,3);assert.equal(value.nonBillableOffPhoneMinutes,5);assert.equal(rest,10);assert.equal(value.deductibleMinutes,rest);assert.equal(value.grossPay,Math.min(500,Math.round(computed.dtr.summary.earnedGrossHours!*60*value.minuteRate*100)/100));assert.equal(value.deductions,Math.round(rest*value.minuteRate*100)/100);assert.equal(Math.round((value.grossPay-value.deductions)*100),Math.round(value.netPay*100));assert.equal(value.overtimeHours,0);assert.equal(await evidence(),before);
});
test("new cutoff earnings still grow minute by minute and do not grant a fixed half salary at shift start",async context=>{
 const clock=new Date('2026-11-23T15:30:00Z');configureEqualHalfPolicy(context,clock);const label='Nov 21, 2026 - Dec 5, 2026';await fixture({start:'2026-11-21',end:'2026-12-05',period:label});const ledger=(await AttendanceLedger.findById('synthetic-fixed-ledger').lean())!;await AttendanceLedger.updateOne({_id:ledger._id},{$set:{events:ledger.events.filter(event=>Date.parse(event.at)<=+clock)}});for(const business of businesses)await runWithBusiness(business,()=>Attendance.deleteMany({timeIn:{$gt:clock}}));const before=await evidence(),first=(await candidate(label)).value;assert.ok(first.netPay>0&&first.netPay<500);context.mock.timers.tick(60000);assert.ok((await candidate(label)).value.netPay>first.netPay);assert.equal(await evidence(),before);
});
test("future missing-only generation snapshots equal-half rates and never changes earlier payroll or attendance",async context=>{
 configureEqualHalfPolicy(context,new Date('2026-11-21T02:00:00Z'));await fixture({start:'2026-11-06',end:'2026-11-20',period:'Nov 6, 2026 - Nov 20, 2026',status:'Paid'});const {PayrollGenerationPolicy}=await import('../models/PayrollGenerationPolicy'),{generateFutureMissingPayroll}=await import('./payrollMissingGeneration');for(const business of businesses)await runWithBusiness(business,()=>PayrollGenerationPolicy.updateOne({_id:'missing-current-payroll'},{$set:{enabled:business===businesses[0],startsAfter:'2026-11-20',actor:'90000001',enabledAt:new Date()}},{upsert:true}));const before=JSON.parse(await evidence()),result=await runWithBusiness(businesses[0],()=>generateFutureMissingPayroll());assert.equal(result?.mirrors,7);
 for(const business of businesses)await runWithBusiness(business,async()=>{const record=(await PayrollRecord.findOne({payPeriod:'Nov 21, 2026 - Dec 5, 2026'}).lean())!;assert.equal(record.grossPay,0);assert.equal(record.netPay,0);assert.equal(record.calculationSnapshot?.rateBasis,'equal-half-cutoff-v1');assert.equal(record.calculationSnapshot?.cutoffEquivalentWorkingDays,10.5);assert.equal(record.calculationSnapshot?.cutoffScheduledPaidMinutes,4800);});const once=await evidence();await runWithBusiness(businesses[0],()=>generateFutureMissingPayroll());assert.equal(await evidence(),once);const after=JSON.parse(await evidence());assert.deepEqual(after.ledger,before.ledger);for(const [index,row]of after.businesses.entries()){assert.deepEqual(row.attendance,before.businesses[index].attendance);assert.deepEqual(row.payroll.filter((record:{payPeriod:string})=>record.payPeriod==='Nov 6, 2026 - Nov 20, 2026'),before.businesses[index].payroll);}
});
test("paid equal-half records keep the approved amount and rate after configured salaries or rollout flags change",async context=>{
 configureEqualHalfPolicy(context);const label='Nov 21, 2026 - Dec 5, 2026';await fixture({start:'2026-11-21',end:'2026-12-05',period:label});const computed=(await candidate(label)).value;for(const business of businesses)await runWithBusiness(business,async()=>{await PayrollRecord.updateMany({payPeriod:label},{$set:{...computed,status:'Paid',paidOn:'Dec 6, 2026'}});await Employee.updateOne({employeeCode:code},{$set:{salary:2000}});});delete process.env.CRM_EQUAL_HALF_CUTOFF_FROM;const before=await evidence();for(const business of businesses){const response=await read('/payroll/records?'+new URLSearchParams({payPeriod:label}),business);assert.equal(response.data[0].netPay,500);assert.equal(response.data[0].hourlyRate,computed.hourlyRate);assert.equal(response.data[0].status,'Paid');const history=await runWithBusiness(business,()=>employeePayments(code,1,'history'));assert.equal(history.items.find(row=>row.cutoffStart==='2026-11-21')?.netPay,500);}assert.equal(await evidence(),before);
});
