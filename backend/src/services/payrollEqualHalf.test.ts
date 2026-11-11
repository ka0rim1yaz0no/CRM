import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { equalHalfCutoffRates } from "../../../shared/payrollEqualHalf";
import { fixedHalfSalaryBase } from "../../../shared/payrollFixedHalf";
import { minuteAccrualAmounts } from "../../../shared/payrollMinuteAccrual";
import { equalHalfCutoffAccrualEnabled } from "../config/payrollEarnings";
import { payrollRatesForCutoff } from "../controllers/payrollController";

const settings={officialShiftStartTime:"23:00",officialShiftEndTime:"08:00"},policy={lunchMinutes:60};
function rollout(context:TestContext){const values={CRM_PAYROLL_ACCURACY:"true",CRM_EARNED_PAYROLL_FROM:"2026-10-06",CRM_MINUTE_ACCRUAL_FROM:"2026-11-06",CRM_EQUAL_HALF_CUTOFF_FROM:"2026-11-21"},before=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);context.after(()=>{for(const [key,value]of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});}
const key=(date:Date)=>date.toISOString().slice(0,10),weekdays=(start:Date,end:Date)=>{let total=0;for(let at=+start;at<+end;at+=86400000)if(![0,6].includes(new Date(at).getUTCDay()))total++;return total;};
function cycleFor(days:number){for(let month=0;month<24;month++){const start=new Date(Date.UTC(2027,month,6)),next=new Date(Date.UTC(2027,month+1,6));if(weekdays(start,next)===days){const middle=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth(),21));return [{label:key(start)+" - "+key(new Date(+middle-86400000)),days:weekdays(start,middle)},{label:key(middle)+" - "+key(new Date(+next-86400000)),days:weekdays(middle,next)}];}}throw Error("Synthetic calendar case missing");}

for(const days of [21,22,23])test(`${days} workdays keep exact fractional half-days and both actual cutoffs earn half salary`,context=>{
 rollout(context);const periods=cycleFor(days);assert.equal(periods.reduce((sum,row)=>sum+row.days,0),days);
 for(const row of periods){const rates=payrollRatesForCutoff(30000,row.label,settings,policy);assert.equal(rates.monthlyWorkingDays,days);assert.equal(rates.cutoffEquivalentWorkingDays,days/2);assert.equal(rates.cutoffEquivalentPaidHours,days/2*8);assert.equal(rates.cutoffWorkingDays,row.days);assert.equal(rates.cutoffScheduledPaidMinutes,row.days*480);assert.equal(rates.cutoffBasePay,15000);assert.equal(minuteAccrualAmounts(rates.cutoffBasePay,rates.minuteRate,row.days*8,0).netPay,15000);}
});
test("partial attendance starts at zero and accrues per minute rather than receiving the fixed base",()=>{
 const rates=equalHalfCutoffRates({cutoffBasePay:15000,monthlyWorkingDays:21,cutoffWorkingDays:10,paidHoursPerDay:8,monthlyMinuteRate:30000/21/8/60});
 assert.equal(minuteAccrualAmounts(15000,rates.minuteRate,0,0).netPay,0);assert.equal(minuteAccrualAmounts(15000,rates.minuteRate,40,0).netPay,7500);assert.ok(minuteAccrualAmounts(15000,rates.minuteRate,61/60,0).netPay>minuteAccrualAmounts(15000,rates.minuteRate,1,0).netPay);
});
test("rest and non-billable deductions use the same cutoff rate once; extra hours cannot exceed the cap",()=>{
 const rates=equalHalfCutoffRates({cutoffBasePay:15000,monthlyWorkingDays:23,cutoffWorkingDays:12,paidHoursPerDay:8,monthlyMinuteRate:30000/23/8/60}),amounts=minuteAccrualAmounts(15000,rates.minuteRate,96,6);
 assert.equal(amounts.grossPay,15000);assert.equal(amounts.deductions,Math.round(6*rates.minuteRate*100)/100);assert.equal(Math.round((amounts.grossPay-amounts.deductions)*100),Math.round(amounts.netPay*100));assert.equal(minuteAccrualAmounts(15000,rates.minuteRate,100,0).netPay,15000);assert.throws(()=>minuteAccrualAmounts(15000,rates.minuteRate,96,0,1),/Overtime/);
});
test("odd salary cents are allocated once and still sum to the exact monthly salary",()=>{
 const salary=30000.01,values=[10,11].map((days,index)=>{const cap=fixedHalfSalaryBase(salary,index===0),rates=equalHalfCutoffRates({cutoffBasePay:cap,monthlyWorkingDays:21,cutoffWorkingDays:days,paidHoursPerDay:8,monthlyMinuteRate:salary/21/8/60});return minuteAccrualAmounts(cap,rates.minuteRate,days*8,0).netPay;});assert.equal(Math.round(values[0]*100)+Math.round(values[1]*100),Math.round(salary*100));
});
test("non-eight-hour verified shifts preserve exact paid minutes and fractional budgets",()=>{
 for(const minutes of [450,500]){const rates=equalHalfCutoffRates({cutoffBasePay:15000,monthlyWorkingDays:21,cutoffWorkingDays:10,paidHoursPerDay:minutes/60,monthlyMinuteRate:30000/21/minutes});assert.equal(rates.cutoffScheduledPaidMinutes,10*minutes);assert.equal(rates.cutoffEquivalentWorkingDays,10.5);assert.equal(minuteAccrualAmounts(15000,rates.minuteRate,10*minutes/60,0).netPay,15000);}
});
test("current and restored cutoffs retain byte-identical rate values with future rollout enabled",context=>{
 rollout(context);for(const period of ["Oct 21, 2026 - Nov 5, 2026","Nov 6, 2026 - Nov 20, 2026"]){delete process.env.CRM_EQUAL_HALF_CUTOFF_FROM;const before=payrollRatesForCutoff(30000,period,settings,policy);process.env.CRM_EQUAL_HALF_CUTOFF_FROM="2026-11-21";assert.deepEqual(payrollRatesForCutoff(30000,period,settings,policy),before);assert.equal(equalHalfCutoffAccrualEnabled(period),false);}
});
test("activation refuses invalid dates, backdating and a missing minute-accrual dependency",context=>{
 rollout(context);for(const from of ["2026-11-06","2026-11-31","invalid"]){process.env.CRM_EQUAL_HALF_CUTOFF_FROM=from;assert.throws(()=>equalHalfCutoffAccrualEnabled("Nov 21, 2026 - Dec 5, 2026"));}process.env.CRM_EQUAL_HALF_CUTOFF_FROM="2026-11-21";delete process.env.CRM_MINUTE_ACCRUAL_FROM;assert.throws(()=>equalHalfCutoffAccrualEnabled("Nov 21, 2026 - Dec 5, 2026"),/requires verified minute/);
});
test("invalid workday, salary and paid-minute inputs are refused rather than producing guessed pay",()=>{
 const source={cutoffBasePay:15000,monthlyWorkingDays:21,cutoffWorkingDays:10,paidHoursPerDay:8,monthlyMinuteRate:30000/21/8/60};for(const changes of [{cutoffWorkingDays:0},{cutoffWorkingDays:22},{cutoffWorkingDays:10.5},{monthlyWorkingDays:0},{paidHoursPerDay:0},{paidHoursPerDay:8.001},{cutoffBasePay:-1},{cutoffBasePay:Infinity},{monthlyMinuteRate:NaN}])assert.throws(()=>equalHalfCutoffRates({...source,...changes}));
});
