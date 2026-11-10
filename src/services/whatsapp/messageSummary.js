const Message = require("../../models/Message");

async function summarizeWhatsappMessages(leadIds) {
  const outboundLeadIds = new Set();
  const byLead = new Map();
  if (!leadIds || !leadIds.length) return { outboundLeadIds, byLead };

  const at = { $ifNull: ["$timestamp", "$createdAt"] };

  const [inbound, outbound] = await Promise.all([
    Message.aggregate([
      {
        $match: {
          leadId: { $in: leadIds },
          direction: "inbound",
          sender: "customer",
        },
      },
      {
        $group: {
          _id: "$leadId",
          replyCount: { $sum: 1 },
          replyAt: { $max: at },
        },
      },
    ]).allowDiskUse(true),
    Message.aggregate([
      { $match: { leadId: { $in: leadIds }, direction: "outbound" } },
      { $project: { leadId: 1, status: 1, at } }, // chhota karo, phir sort
      { $sort: { at: -1 } },
      {
        $group: {
          _id: "$leadId",
          sentAt: { $first: "$at" },
          sentStatus: { $first: "$status" },
        },
      },
    ]).allowDiskUse(true),
  ]);

  const stateFor = (id) => {
    if (!byLead.has(id)) {
      byLead.set(id, {
        sentAt: null,
        sentStatus: "not_sent",
        replyAt: null,
        replyCount: 0,
      });
    }
    return byLead.get(id);
  };

  for (const row of outbound) {
    const id = String(row._id);
    outboundLeadIds.add(id);
    const state = stateFor(id);
    state.sentAt = row.sentAt || null;
    state.sentStatus = row.sentStatus || "sent";
  }
  for (const row of inbound) {
    const state = stateFor(String(row._id));
    state.replyCount = row.replyCount || 0;
    state.replyAt = row.replyAt || null;
  }

  return { outboundLeadIds, byLead };
}

module.exports = { summarizeWhatsappMessages };
