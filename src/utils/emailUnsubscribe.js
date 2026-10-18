const crypto = require("crypto");
const env = require("../config/env");
function secret() { return String(env.jwt?.accessSecret || process.env.JWT_ACCESS_SECRET || process.env.JWT_ACCESS_TOKEN_SECRET || ""); }
function createUnsubscribeToken(lead) {
 const key=secret(); if(!key) throw new Error("JWT access secret is required for unsubscribe links");
 const payload=Buffer.from(JSON.stringify({leadId:String(lead._id),ownerId:String(lead.ownerId),email:String(lead.email||"").toLowerCase(),exp:Date.now()+365*24*60*60*1000})).toString("base64url");
 return `${payload}.${crypto.createHmac("sha256",key).update(payload).digest("base64url")}`;
}
function verifyUnsubscribeToken(token) {
 const [payload,signature]=String(token||"").split("."); if(!payload||!signature)return null; const key=secret(); if(!key)return null;
 const expected=crypto.createHmac("sha256",key).update(payload).digest(); let actual; try{actual=Buffer.from(signature,"base64url")}catch{return null;}
 if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return null;
 try{const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));return data.exp>Date.now()?data:null;}catch{return null;}
}
module.exports={createUnsubscribeToken,verifyUnsubscribeToken};
