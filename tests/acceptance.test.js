/**
 * Acceptance tests for "no unsolicited WhatsApp" fix.
 * Asli backend modules chalte hain; sirf Mongo calls in-memory fakes se replace.
 * Run: node --test acceptance.test.js   (BE env var = backend folder)
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");
const BE = process.env.BE;
const r = (p) => path.join(BE, p);
global.DOMMatrix = class {};
global.ImageData = class {};
global.Path2D = class {};

const mongoose = require(r("node_modules/mongoose"));
const oid = () => new mongoose.Types.ObjectId();

/** chainable fake query: .select().lean().sort()... then await → result */
function q(result) {
  const p = Promise.resolve(typeof result === "function" ? result() : result);
  const o = {
    then: (a, b) => p.then(a, b),
    catch: (b) => p.catch(b),
    distinct: () => q(p.then((rows) => rows.map((x) => x.leadId ?? x._id))),
  };
  for (const m of [
    "select",
    "lean",
    "sort",
    "limit",
    "skip",
    "populate",
    "allowDiskUse",
  ])
    o[m] = () => o;
  return o;
}

const Lead = require(r("src/models/Lead"));
const Conversation = require(r("src/models/Conversation"));
const Message = require(r("src/models/Message"));
const OutboundJob = require(r("src/models/OutboundJob"));

// Har test me OutboundJob par likhne wali calls record karo
let jobWrites;
function spyJobs() {
  jobWrites = [];
  OutboundJob.insertMany = async (docs) => {
    jobWrites.push(...docs);
    return docs.map((d) => ({ ...d, _id: oid() }));
  };
  OutboundJob.create = async (doc) => {
    jobWrites.push(doc);
    return doc;
  };
}

/* ---------------------------------------------------------------- */
test("1. Server restart (CATCHUP_ON_BOOT unset): koi OutboundJob nahi, log me DISABLED", async () => {
  spyJobs();
  delete process.env.CATCHUP_ON_BOOT;
  const logs = [];
  const logger = require(r("src/utils/logger"));
  const origInfo = logger.info;
  logger.info = (msg, ...rest) => {
    logs.push(String(msg));
  };
  const engine = require(r("src/services/ai/conversationEngine"));
  let catchUpCalls = 0;
  const origCatch = engine.catchUpPendingConversations;
  engine.catchUpPendingConversations = async () => {
    catchUpCalls += 1;
  };

  // DB connect, http server, worker, scheduler: fakes
  require.cache[r("src/config/db.js")] = {
    id: r("src/config/db.js"),
    filename: r("src/config/db.js"),
    loaded: true,
    exports: async () => {},
  };
  const bw = require(r("src/services/queue/bulkWorker"));
  bw.startBulkWorker = async () => {};
  bw.stopBulkWorker = () => {};
  const sched = require(r("src/services/scheduler/dailyReportScheduler"));
  sched.startDailyReportScheduler = () => {};
  const meta = require(r("src/services/whatsapp/metaWhatsappClient"));
  meta.getAccountInfo = async () => ({});
  meta.ensureWabaSubscription = async () => {};
  const http = require("http");
  const origCreate = http.createServer;
  http.createServer = () => ({
    listen: (_p, cb) => setImmediate(cb),
    close: (cb) => cb && cb(),
    on() {},
  });
  const sockets = require(r("src/sockets"));
  sockets.initSocket = () => {};

  delete require.cache[r("server.js")];
  require(r("server.js"));
  await new Promise((res) => setTimeout(res, 300));

  http.createServer = origCreate;
  logger.info = origInfo;
  engine.catchUpPendingConversations = origCatch;
  assert.equal(catchUpCalls, 0, "catch-up nahi chalna chahiye");
  assert.equal(jobWrites.length, 0, "koi OutboundJob nahi banna chahiye");
  assert.ok(
    logs.some((l) => l.includes("[server] Boot catch-up sweep is DISABLED")),
    "DISABLED log missing",
  );
  console.log(
    "   log:",
    logs.find((l) => l.includes("DISABLED")),
  );
});

/* ---------------------------------------------------------------- */
test("2. 200 leads import (bina campaign): koi job nahi bana", async () => {
  spyJobs();
  const { importLeadRows } = require(r("src/services/leads/leadImportService"));
  Lead.find = () => q([]);
  Lead.updateMany = async () => ({});
  let insertedLeads = 0,
    convShells = 0;
  Lead.insertMany = async (docs) => {
    insertedLeads += docs.length;
    return docs.map((d) => ({ ...d, _id: oid() }));
  };
  Conversation.insertMany = async (docs) => {
    convShells += docs.length;
    return docs;
  };
  const rows = Array.from({ length: 200 }, (_, i) => ({
    name: `Test ${i}`,
    phone: `9198${String(10000000 + i).padStart(8, "0")}`,
    importFile: "test-200.csv",
    source: "file_import_whatsapp",
  }));
  const ownerId = oid();
  const res = await importLeadRows(ownerId, rows);
  assert.equal(res.inserted.length, 200);
  assert.equal(jobWrites.length, 0, "import par koi OutboundJob nahi");
  assert.ok(
    res.inserted.every(
      (l) =>
        l.importFile === "test-200.csv" && l.importFiles[0] === "test-200.csv",
    ),
    "sheet naam save hona chahiye",
  );
  console.log(
    `   inserted=${insertedLeads}, conversation shells=${convShells}, OutboundJobs=${jobWrites.length}`,
  );
});

/* ---------------------------------------------------------------- */
test("3. Campaign launch: jobs campaignId ke saath + per-day nextRunAt", async () => {
  spyJobs();
  const queue = require(r("src/services/queue/outboundQueue"));
  const campaign = {
    _id: oid(),
    ownerId: oid(),
    dailyLimit: 2,
    startDate: "2030-01-10",
    sendTime: "10:30",
    channels: { whatsapp: true, email: false },
  };
  const leads = Array.from({ length: 5 }, () => ({
    _id: oid(),
    hasPhone: true,
    hasEmail: false,
  }));
  const out = await queue.scheduleCampaignJobs({ campaign, leads });
  assert.equal(out.whatsapp, 5);
  assert.equal(out.totalDays, 3);
  assert.ok(
    jobWrites.every((j) => String(j.campaignId) === String(campaign._id)),
    "sab jobs ka campaignId hona chahiye",
  );
  const days = jobWrites.map((j) => [j.dayNumber, j.nextRunAt.toISOString()]);
  assert.deepEqual(
    days.map((d) => d[0]),
    [1, 1, 2, 2, 3],
  );
  assert.equal(days[0][1], "2030-01-10T05:00:00.000Z"); // 10:30 IST
  assert.equal(days[2][1], "2030-01-11T05:00:00.000Z");
  console.log("   jobs:", days.map((d) => `day${d[0]}@${d[1]}`).join(", "));
});

/* ---------------------------------------------------------------- */
test("4. enqueueLeads (campaignId null): 131026/131049/131050 wale skip", async () => {
  spyJobs();
  const queue = require(r("src/services/queue/outboundQueue"));
  const ok1 = oid(),
    ok2 = oid(),
    invalid = oid(),
    cooldown = oid(),
    optout = oid();
  OutboundJob.find = () => q([]); // koi active job nahi
  Lead.find = () =>
    q([
      { _id: ok1, whatsappHealth: { status: "ok" } },
      { _id: ok2 },
      {
        _id: invalid,
        whatsappHealth: {
          status: "invalid",
          invalidCount: 2,
          invalidAt: new Date(),
        },
      },
      {
        _id: cooldown,
        whatsappHealth: {
          marketingBlockedUntil: new Date(Date.now() + 7 * 864e5),
        },
      },
      { _id: optout, whatsappHealth: { marketingOptOut: true } },
    ]);
  const res = await queue.enqueueLeads({
    ownerId: oid(),
    leadIds: [ok1, ok2, invalid, cooldown, optout],
  });
  assert.equal(res.queued, 2);
  assert.equal(res.healthSkipped, 3);
  assert.deepEqual(
    jobWrites.map((j) => String(j.leadId)).sort(),
    [String(ok1), String(ok2)].sort(),
  );
  assert.ok(jobWrites.every((j) => !j.campaignId));
  console.log(`   queued=${res.queued}, healthSkipped=${res.healthSkipped}`);
});

/* ---------------------------------------------------------------- */
test("5. catchUp (agar CATCHUP_ON_BOOT=true): max 25/run + blocked skip", async () => {
  spyJobs();
  const engine = require(r("src/services/ai/conversationEngine"));
  const N = 60;
  const convs = Array.from({ length: N }, () => ({
    _id: oid(),
    leadId: oid(),
  }));
  Conversation.find = () => q(convs);
  Message.distinct = async () => [];
  OutboundJob.distinct = async () => [];
  const blocked = new Set(convs.slice(0, 5).map((c) => String(c.leadId)));
  Lead.find = (f) =>
    q(
      convs.map((c) => ({
        _id: c.leadId,
        whatsappHealth: blocked.has(String(c.leadId))
          ? { marketingOptOut: true }
          : {},
      })),
    );
  OutboundJob.find = () => q([]);
  delete process.env.CATCHUP_MAX_PER_RUN;
  await engine.catchUpPendingConversations(oid());
  assert.equal(jobWrites.length, 25, "default max 25");
  assert.ok(
    jobWrites.every((j) => !blocked.has(String(j.leadId))),
    "blocked leads queue nahi hone chahiye",
  );
  console.log(`   ${N} pending, 5 opt-out → queued ${jobWrites.length}`);
});

/* ---------------------------------------------------------------- */
test("6. POST /api/leads/start-conversations: 100 se zyada par 400", async () => {
  const ctrl = require(r("src/controllers/leadController"));
  const call = (ids) =>
    new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(c) {
          this.statusCode = c;
          return this;
        },
        json(b) {
          resolve({ code: this.statusCode, body: b });
        },
      };
      ctrl.startConversations(
        { body: { leadIds: ids }, user: { id: String(oid()) } },
        res,
        (err) => resolve({ code: err.statusCode, err: err.message }),
      );
    });
  const many = await call(Array.from({ length: 101 }, () => String(oid())));
  assert.equal(many.code, 400);
  assert.match(many.err, /max 100/);
  // 3 leads: allowed, count wapas aata hai
  spyJobs();
  const ids = [oid(), oid(), oid()];
  Lead.find = () => q(ids.map((_id) => ({ _id, whatsappHealth: {} })));
  Conversation.find = () => q(ids.map((leadId) => ({ leadId })));
  OutboundJob.find = () => q([]);
  const ok = await call(ids.map(String));
  assert.equal(ok.code, 200);
  assert.equal(ok.body.data.count, 3);
  console.log(
    `   101 ids → ${many.code} "${many.err.slice(0, 60)}…"; 3 ids → count=${ok.body.data.count}`,
  );
});

/* ---------------------------------------------------------------- */
test("7. Stop all: sirf campaignId null + pending/processing/paused cancel", async () => {
  const queue = require(r("src/services/queue/outboundQueue"));
  let seen;
  OutboundJob.updateMany = async (filter, update) => {
    seen = { filter, update };
    return { modifiedCount: 7 };
  };
  const out = await queue.stopManualJobs(String(oid()));
  assert.equal(out.modified, 7);
  assert.equal(seen.filter.campaignId, null);
  assert.deepEqual(seen.filter.status.$in, ["pending", "processing", "paused"]);
  assert.equal(seen.update.$set.status, "cancelled");
});

/* ---------------------------------------------------------------- */
test("8. Upload Data sheets: naam wali sheets + purane uploads time-gap se group", async () => {
  const ctrl = require(r("src/controllers/leadController"));
  Lead.aggregate = async () => [
    {
      _id: "kavi nagar.xlsx",
      count: 1571,
      whatsapp: 1571,
      email: 0,
      lastAt: new Date("2026-11-20T07:27:00Z"),
    },
  ];
  const t0 = new Date("2026-11-20T07:27:00Z").getTime();
  Lead.find = () =>
    q([
      ...Array.from({ length: 3 }, (_, i) => ({
        source: "file_import_whatsapp",
        createdAt: new Date(t0 - 86400000 + i * 1000),
        phone: "91",
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        source: "bulk_sheet_upload",
        createdAt: new Date(t0 + i * 2000),
        phone: "91",
      })),
      { source: "whatsapp_inbound", createdAt: new Date(t0), phone: "91" },
    ]);
  const body = await new Promise((resolve, reject) => {
    const res = {
      status() {
        return this;
      },
      json(b) {
        resolve(b);
      },
    };
    ctrl.listImportFiles(
      { query: {}, user: { id: String(oid()), role: "broker" } },
      res,
      reject,
    );
  });
  const files = body.data.files;
  console.log("  ", files.map((f) => `${f.label} (${f.count})`).join(" | "));
  assert.equal(files.length, 4);
  assert.equal(files.filter((f) => f.kind === "legacy").length, 2);
  assert.equal(files.find((f) => f.kind === "manual").count, 1);
  assert.equal(files.find((f) => f.kind === "sheet").count, 1571);
});

/* ================================================================ */
/* Campaign failures (Meta webhook + send-time)                      */
/* ================================================================ */
function failedJobsFixture(campaignId) {
  const L = () => oid();
  const leads = { ok: L(), cool: L(), optout: L(), send: L(), exhausted: L() };
  const jobs = [
    // Meta ne accept kiya, webhook se fail (unknown code → ready)
    {
      _id: oid(),
      campaignId,
      leadId: leads.ok,
      status: "sent",
      deliveryStatus: "failed",
      deliveryErrorCode: "131000",
      deliveryError: "Something went wrong",
    },
    // 131049 cooldown → waiting
    {
      _id: oid(),
      campaignId,
      leadId: leads.cool,
      status: "sent",
      deliveryStatus: "failed",
      deliveryErrorCode: "131049",
    },
    // opt-out → blocked
    {
      _id: oid(),
      campaignId,
      leadId: leads.optout,
      status: "sent",
      deliveryStatus: "failed",
      deliveryErrorCode: "131050",
    },
    // bhejte waqt fail → ready
    {
      _id: oid(),
      campaignId,
      leadId: leads.send,
      status: "failed",
      lastErrorCode: "132000",
      lastError: "Template param mismatch",
    },
    // 2 baar resend ho chuka → blocked
    {
      _id: oid(),
      campaignId,
      leadId: leads.exhausted,
      status: "sent",
      deliveryStatus: "failed",
      deliveryErrorCode: "131000",
      deliveryRetryCount: 2,
    },
  ];
  const leadDocs = [
    { _id: leads.ok, name: "Ok", phone: "911" },
    {
      _id: leads.cool,
      name: "Cool",
      phone: "912",
      whatsappHealth: { marketingBlockedUntil: new Date(Date.now() + 864e5) },
    },
    {
      _id: leads.optout,
      name: "Opt",
      phone: "913",
      whatsappHealth: { marketingOptOut: true },
    },
    { _id: leads.send, name: "Send", phone: "914" },
    { _id: leads.exhausted, name: "Ex", phone: "915" },
  ];
  return { jobs, leadDocs };
}

test("9. Campaign card: Meta + send failures ka summary (ready/waiting/blocked + reasons)", async () => {
  const df = require(r("src/services/queue/deliveryFailures"));
  const cid = oid();
  const { jobs, leadDocs } = failedJobsFixture(cid);
  let seenFilter;
  OutboundJob.find = (f) => {
    seenFilter = f;
    return q(jobs);
  };
  Lead.find = () => q(leadDocs);
  const map = await df.summarizeForCampaigns([cid]);
  const s = map.get(String(cid));
  console.log(
    "   summary:",
    JSON.stringify({
      total: s.total,
      meta: s.meta,
      send: s.send,
      ready: s.ready,
      waiting: s.waiting,
      blocked: s.blocked,
    }),
  );
  console.log(
    "   top reasons:",
    s.reasons.map((x) => `${x.reason} (${x.code}) x${x.count}`).join(" | "),
  );
  assert.deepEqual(
    {
      total: s.total,
      meta: s.meta,
      send: s.send,
      ready: s.ready,
      waiting: s.waiting,
      blocked: s.blocked,
    },
    { total: 5, meta: 4, send: 1, ready: 2, waiting: 1, blocked: 2 },
  );
  assert.ok(s.nextReadyAt, "waiting ka timer hona chahiye");
  // filter me dono type ke failures
  assert.deepEqual(seenFilter.$or, [
    { status: "failed" },
    { status: "sent", deliveryStatus: "failed" },
  ]);
});

test("10. Campaign list: card par deliveryFailure + stats.deliveryFailed aata hai", async () => {
  const queue = require(r("src/services/queue/outboundQueue"));
  const Campaign = require(r("src/models/Campaign"));
  const cid = oid();
  const { jobs, leadDocs } = failedJobsFixture(cid);
  Campaign.find = () =>
    q([{ _id: cid, name: "ivory 1-200", channels: { whatsapp: true } }]);
  OutboundJob.aggregate = async () => [
    {
      _id: {
        campaignId: cid,
        channel: "whatsapp",
        status: "sent",
        future: false,
        delivery: null,
      },
      count: 150,
    },
    {
      _id: {
        campaignId: cid,
        channel: "whatsapp",
        status: "sent",
        future: false,
        delivery: "delivered",
      },
      count: 20,
    },
    {
      _id: {
        campaignId: cid,
        channel: "whatsapp",
        status: "sent",
        future: false,
        delivery: "failed",
      },
      count: 4,
    },
    {
      _id: {
        campaignId: cid,
        channel: "whatsapp",
        status: "failed",
        future: false,
        delivery: null,
      },
      count: 1,
    },
  ];
  OutboundJob.find = () => q(jobs);
  Lead.find = () => q(leadDocs);
  const [c] = await queue.listCampaigns(String(oid()));
  const wa = c.stats.whatsapp;
  console.log(
    `   stats: sent(raw)=${wa.sent} deliveryFailed=${wa.deliveryFailed} delivered=${wa.delivered} failed(send)=${wa.failed} → card: ${wa.sent - wa.deliveryFailed} sent · ${wa.failed + wa.deliveryFailed} failed`,
  );
  assert.equal(wa.sent, 174);
  assert.equal(wa.deliveryFailed, 4);
  assert.equal(wa.delivered, 20);
  assert.equal(c.deliveryFailure.total, 5);
});

test("11. Leads list 'Failed' filter me Meta-failed bhi aate hain; 'Sent' me nahi", async () => {
  const queue = require(r("src/services/queue/outboundQueue"));
  const matches = [];
  OutboundJob.aggregate = (pipeline) => {
    matches.push(pipeline[0].$match);
    const p = Promise.resolve([]);
    p.allowDiskUse = () => p;
    return p;
  };
  OutboundJob.countDocuments = async () => 0;
  await queue.listJobs(String(oid()), {
    channel: "whatsapp",
    status: "failed",
  });
  await queue.listJobs(String(oid()), { channel: "whatsapp", status: "sent" });
  assert.deepEqual(matches[0].$or, [
    { status: "failed" },
    { status: "sent", deliveryStatus: "failed" },
  ]);
  assert.equal(matches[1].status, "sent");
  assert.deepEqual(matches[1].deliveryStatus, { $ne: "failed" });
});

test("12. Resend: sirf 'ready' wale requeue, delivery fields reset, retry count +1", async () => {
  const df = require(r("src/services/queue/deliveryFailures"));
  const Campaign = require(r("src/models/Campaign"));
  const cid = oid();
  const { jobs, leadDocs } = failedJobsFixture(cid);
  Campaign.findOne = async () => ({
    _id: cid,
    status: "completed",
    save: async () => {},
  });
  OutboundJob.find = () => q(jobs);
  Lead.find = () => q(leadDocs);
  let msgUpdate, jobUpdate;
  Message.updateMany = async (f, u) => {
    msgUpdate = { f, u };
    return {};
  };
  OutboundJob.updateMany = async (f, u) => {
    jobUpdate = { f, u };
    return { modifiedCount: f.$or ? f._id.$in.length : 0 };
  };
  const res = await df.retryReadyFailures(String(oid()), String(cid));
  assert.equal(res.requeued, 2);
  assert.equal(res.campaign.status, "active");
  assert.equal(jobUpdate.u.$set.status, "pending");
  assert.equal(jobUpdate.u.$set.deliveryStatus, null);
  assert.deepEqual(jobUpdate.u.$inc, { deliveryRetryCount: 1 });
  assert.equal(msgUpdate.u.$set.outboundJobId, null);
  console.log(
    `   requeued=${res.requeued} (ready), campaign completed → ${res.campaign.status}`,
  );
});
