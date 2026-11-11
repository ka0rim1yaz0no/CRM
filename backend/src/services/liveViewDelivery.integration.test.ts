import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import crypto from "node:crypto";
import http from "node:http";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { io, type Socket } from "socket.io-client";

const root = `liveview_delivery_${crypto.randomUUID().replaceAll("-", "")}`;
const businesses = Array.from({length:6},(_,index)=>({id:`view-${index}`,databaseName:`${root}_${index}`}));
Object.assign(process.env,{NODE_ENV:"test",CRM_SECURITY_LEGACY_AUTH:"true",CRM_ADMIN_ONE_CODE:"synthetic-view-admin",
    CRM_ADMIN_SESSION_SECRET:crypto.randomBytes(48).toString("base64"),DEFAULT_BUSINESS_ID:businesses[0].id,
    DEFAULT_BUSINESS_DATABASE:businesses[0].databaseName,CONTROL_DATABASE_NAME:`${root}_control`,BUSINESS_DATABASES:JSON.stringify(businesses)});
const {createSocketServer} = await import("../socket");
const {runWithBusiness} = await import("../config/tenancy");
const {Employee} = await import("../models/Employee");
const {LiveViewAudit} = await import("../models/LiveViewAudit");
const {setBusinessAccessForEmployeeCode} = await import("../models/BusinessUserAccess");
const {createAttendanceHubSession} = await import("../config/attendanceHubSession");
const {createAdminDashboardSession} = await import("../config/adminDashboardSession");
const {liveViewRequestLifetimeMs} = await import("./liveViewDelivery");
let mongo: MongoMemoryReplSet, server: http.Server, sockets: ReturnType<typeof createSocketServer>, origin="";
const ids = new Map<string,{owner:string;other:string}>(), connections = new Set<Socket>();
before(async()=>{
    mongo=await MongoMemoryReplSet.create({replSet:{count:1}});await mongoose.connect(mongo.getUri(root));
    for(const business of businesses)await runWithBusiness(business.id,async()=>{
        const owner=await Employee.create({employeeCode:"synthetic-view-owner",name:"Synthetic owner",status:"Active",role:"Human Resources",team:"Internal"});
        const other=await Employee.create({employeeCode:"synthetic-view-other",name:"Synthetic other",status:"Active",role:"Sales"});
        ids.set(business.id,{owner:String(owner._id),other:String(other._id)});
        await LiveViewAudit.createIndexes();
        await mongoose.connection.getClient().db(business.databaseName).collection("attendances").insertOne({source:"Time In",employee:owner._id,timeIn:new Date("2026-11-02T15:00:00Z")});
        await mongoose.connection.getClient().db(business.databaseName).collection("payrollrecords").insertOne({employee:owner._id,netPay:123,paid:true,paidAt:"synthetic-fixture-only"});
    });
    for(const code of ["synthetic-view-owner","synthetic-view-other"])await setBusinessAccessForEmployeeCode(code,businesses.map(b=>b.id));
    server=http.createServer();sockets=createSocketServer(server);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
});
after(async()=>{for(const socket of connections)socket.disconnect();sockets?.close();server?.closeAllConnections();await mongoose.disconnect();await mongo?.stop();});
function connection(business:string,type:"admin"|"owner"|"other") {
    const auth=type==="admin"?{businessId:business,adminSession:createAdminDashboardSession("synthetic-view-admin")}:
        {businessId:business,attendanceSession:createAttendanceHubSession(`synthetic-view-${type}`)};
    const socket=io(origin,{auth,autoConnect:false,transports:["websocket"],reconnection:false,forceNew:true});connections.add(socket);return socket;
}
function event<T=Record<string,unknown>>(socket:Socket,name:string,timeout=1500):Promise<T> {
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.off(name,receive);reject(Error(`Missing ${name}`));},timeout);
        const receive=(value:T)=>{clearTimeout(timer);resolve(value);};socket.once(name,receive);});
}
async function connect(socket:Socket){const ready=event(socket,"connect");socket.connect();await ready;}
async function reply(socket:Socket,name:string,payload:Record<string,unknown>={}) {
    return socket.timeout(1500).emitWithAck(name,payload) as Promise<{ok:boolean}>;
}
async function request(business:string,name:string) {
    const admin=connection(business,"admin"),owner=connection(business,"owner"),requestId=`${name}-${business}`;
    await connect(admin);await connect(owner);
    const delivered=event(owner,"live-share:requested");
    assert.equal((await reply(admin,"live-share:request",{requestId,employeeId:ids.get(business)!.owner})).ok,true);
    await delivered;
    return {admin,owner,requestId};
}
async function audit(business:string,requestId:string){
    for(let attempt=0;attempt<100;attempt++){
        const row=await runWithBusiness(business,()=>LiveViewAudit.findOne({requestId}).lean());if(row)return row;
        await new Promise(resolve=>setTimeout(resolve,10));
    }throw Error("Missing synthetic audit");
}
async function evidence(){return JSON.stringify(await Promise.all(businesses.map(async business=>{
    const db=mongoose.connection.getClient().db(business.databaseName);
    return {attendance:await db.collection("attendances").find({}).sort({_id:1}).toArray(),payroll:await db.collection("payrollrecords").find({}).sort({_id:1}).toArray()};
})));}

test("same-business reconnect recovers an unexpired approval request for every employee role in all six businesses",async()=>{
    const before=await evidence();
    for(const business of businesses){
        const admin=connection(business.id,"admin"),employee=connection(business.id,"owner"),requestId=`reconnect-${business.id}`;
        try{
            await connect(admin);
            admin.emit("live-share:request",{requestId,employeeId:ids.get(business.id)!.owner,employeeName:"Synthetic owner"});
            assert.equal((await audit(business.id,requestId)).status,"requested");
            const delivered=event(employee,"live-share:requested");await connect(employee);employee.emit("live-share:pending");
            const payload=await delivered;assert.equal(payload.requestId,requestId);assert.equal(payload.employeeId,ids.get(business.id)!.owner);
            assert.equal((await audit(business.id,requestId)).status,"requested","delivery must never accept screen capture for the employee");
        }finally{admin.disconnect();employee.disconnect();}
    }
    assert.equal(await evidence(),before,"Live View delivery never changes original attendance or saved payroll");
});

test("delivery acknowledgement is scoped and never accepts on behalf of the employee",async()=>{
    for(const business of businesses){
        const {admin,owner,requestId}=await request(business.id,"delivered"),other=connection(business.id,"other");
        try {
            await connect(other);
            assert.equal((await reply(other,"live-share:received",{requestId})).ok,false);
            const delivered=event(admin,"live-share:delivery");
            assert.equal((await reply(owner,"live-share:received",{requestId})).ok,true);
            assert.equal((await delivered).state,"received");
            assert.equal((await audit(business.id,requestId)).status,"requested");
            const accepted=event(admin,"live-share:accepted");
            assert.equal((await reply(owner,"live-share:accept",{requestId})).ok,true);await accepted;
            assert.equal((await audit(business.id,requestId)).status,"active");
            assert.equal((await reply(owner,"live-share:accept",{requestId})).ok,true,"same socket can retry its acknowledgement");
        } finally {admin.disconnect();owner.disconnect();other.disconnect();}
    }
});

test("foreign employees and businesses cannot accept, stop or receive another employee request",async()=>{
    const before=await evidence(),business=businesses[0].id;
    const {admin,owner,requestId}=await request(business,"isolation"),other=connection(business,"other"),foreign=connection(businesses[1].id,"owner");
    try {
        await connect(other);await connect(foreign);
        for(const socket of [other,foreign])for(const name of ["live-share:accept","live-share:decline","live-share:stop"])
            assert.equal((await reply(socket,name,{requestId})).ok,false);
        assert.equal((await audit(business,requestId)).status,"requested");
        assert.equal(await evidence(),before);
    } finally {admin.disconnect();owner.disconnect();other.disconnect();foreign.disconnect();}
});

test("request replay retains the original expiry and ended requests cannot be reopened",async()=>{
    const business=businesses[0].id,{admin,owner,requestId}=await request(business,"replay");
    try {
        const initial=await audit(business,requestId),again=event(owner,"live-share:requested");
        assert.equal((await reply(admin,"live-share:request",{requestId,employeeId:ids.get(business)!.owner})).ok,true);await again;
        assert.equal(+(await audit(business,requestId)).requestedAt,+initial.requestedAt);
        const stopped=event(owner,"live-share:stopped");
        assert.equal((await reply(admin,"live-share:stop",{requestId,employeeId:ids.get(business)!.other})).ok,true);await stopped;
        assert.equal((await reply(admin,"live-share:request",{requestId,employeeId:ids.get(business)!.owner})).ok,false);
        assert.equal((await reply(owner,"live-share:accept",{requestId})).ok,false);
        assert.equal((await audit(business,requestId)).status,"ended");
    } finally {admin.disconnect();owner.disconnect();}
});

test("expired or abandoned requests never authorize screen sharing",async()=>{
    for(const expired of [true,false]){
        const business=businesses[0].id,{admin,owner,requestId}=await request(business,expired?"expired":"abandoned");
        try {
            if(expired)await runWithBusiness(business,()=>LiveViewAudit.updateOne({requestId},{$set:{requestedAt:new Date(Date.now()-liveViewRequestLifetimeMs-1)}}));
            else {admin.disconnect();await new Promise(resolve=>setTimeout(resolve,30));}
            assert.equal((await reply(owner,"live-share:accept",{requestId})).ok,false);
            assert.equal((await audit(business,requestId)).status,"requested");
        } finally {admin.disconnect();owner.disconnect();}
    }
});

test("identity acknowledgements always use the signed employee in the selected business",async()=>{
    for(const business of businesses){
        const owner=connection(business.id,"owner");
        try {
            const first=event(owner,"presence:identity");await connect(owner);
            assert.equal((await first).employeeId,ids.get(business.id)!.owner);
            const again=event(owner,"presence:identity");owner.emit("presence:register",{employeeId:ids.get(business.id)!.other});
            const identity=await again;assert.equal(identity.employeeId,ids.get(business.id)!.owner);assert.equal(identity.businessId,business.id);
        } finally {owner.disconnect();}
    }
});

test("signals require participant room membership and only one employee tab can accept",async()=>{
    const business=businesses[0].id,{admin,owner,requestId}=await request(business,"signals"),second=connection(business,"owner"),other=connection(business,"other");
    try {
        await connect(second);await connect(other);
        assert.equal((await reply(owner,"live-share:accept",{requestId})).ok,true);
        assert.equal((await reply(second,"live-share:accept",{requestId})).ok,false);
        let leaked=false;admin.on("live-share:signal",()=>{leaked=true;});
        other.emit("live-share:signal",{requestId,candidate:{candidate:"synthetic-invalid"}});
        await new Promise(resolve=>setTimeout(resolve,75));assert.equal(leaked,false);
        const valid=event(admin,"live-share:signal");owner.emit("live-share:signal",{requestId,description:{type:"offer",sdp:"synthetic-only"}});
        assert.equal((await valid).requestId,requestId);
    } finally {admin.disconnect();owner.disconnect();second.disconnect();other.disconnect();}
});
