require("dotenv").config(); const mongoose=require("mongoose");
(async()=>{if(!process.env.MONGO_URI)throw new Error("MONGO_URI is required");await mongoose.connect(process.env.MONGO_URI);const db=mongoose.connection.db;
const property=await db.collection("properties").updateMany({status:{$exists:false}},{$set:{status:"available"}});
await db.collection("properties").createIndex({ownerId:1,status:1,projectName:1},{name:"owner_property_availability"});
await db.collection("meetings").createIndex({ownerId:1,preferredDate:1,status:1},{name:"owner_visit_date_status"});
await db.collection("leads").createIndex({ownerId:1,emailOptOut:1},{name:"owner_email_optout"});
console.log(JSON.stringify({propertyAvailabilityBackfilled:property.modifiedCount,indexesCreated:true}));await mongoose.disconnect();})().catch(e=>{console.error(e);process.exit(1)});
