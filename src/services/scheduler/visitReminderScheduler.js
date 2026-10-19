const Meeting = require('../../models/Meeting');
const Lead = require('../../models/Lead');
const Property = require('../../models/Property');
const Conversation = require('../../models/Conversation');
const meta = require('../whatsapp/metaWhatsappClient');
const logger = require('../../utils/logger');

let timer = null;
function meetingAt(meeting) {
  // preferredDate/preferredTime are stored as Asia/Kolkata local values.
  return new Date(`${meeting.preferredDate}T${meeting.preferredTime}:00+05:30`);
}
async function sendReminder(meeting, lead, property, kind) {
  const conversation = await Conversation.findOne({ ownerId: meeting.ownerId, leadId: meeting.leadId }).select('lastInboundAt').lean();
  const lastInbound = conversation?.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() : 0;
  const text = `Namaste ${lead.name || 'Customer'}, aapki site visit ${meeting.preferredDate} ko ${meeting.preferredTime} par${property?.projectName ? ` (${property.projectName})` : ''} scheduled hai. Kya aap aa paayenge?`;
  if (lastInbound > 0 && Date.now() - lastInbound < 24 * 60 * 60 * 1000) {
    await meta.sendTextMessage({ phone: lead.phone, text });
  } else {
    const templateName = String(process.env.SITE_VISIT_REMINDER_TEMPLATE_NAME || '').trim();
    if (!templateName) {
      logger.warn('[visit-reminder] Approved Utility template missing; reminder left pending');
      return false;
    }
    const languageCode = String(process.env.SITE_VISIT_REMINDER_TEMPLATE_LANGUAGE || 'en_US').trim();
    const values = [lead.name || 'Customer', meeting.preferredDate, meeting.preferredTime, property?.projectName || 'property'];
    await meta.sendTemplateMessage({ phone: lead.phone, templateName, languageCode, components: [{ type: 'body', parameters: values.map(value => ({ type: 'text', text: String(value) })) }] });
  }
  await Meeting.updateOne({ _id: meeting._id, [`reminders.${kind}`]: null }, { $set: { [`reminders.${kind}`]: new Date() } });
  return true;
}
async function tick() {
  const now = Date.now();
  const minDate = new Date(now - 86400000).toISOString().slice(0, 10);
  const meetings = await Meeting.find({ status: { $in: ['scheduled', 'rescheduled'] }, preferredDate: { $gte: minDate }, confirmed: true }).limit(500).lean();
  for (const meeting of meetings) {
    try {
      const at = meetingAt(meeting);
      if (at.getTime() <= now) continue;
      const lead = await Lead.findOne({ _id: meeting.leadId, ownerId: meeting.ownerId }).lean();
      if (!lead?.phone) continue;
      const property = meeting.propertyId ? await Property.findById(meeting.propertyId).select('projectName').lean() : null;
      for (const [kind, delta] of [['dayBeforeSentAt', 86400000], ['twoHourSentAt', 7200000]]) {
        if (meeting.reminders?.[kind] || at.getTime() - delta > now) continue;
        // Atomic claim prevents two workers from sending the same reminder.
        const claim = await Meeting.updateOne({ _id: meeting._id, status: { $in: ['scheduled', 'rescheduled'] }, [`reminders.${kind}`]: null }, { $set: { [`reminders.${kind}`]: new Date() } });
        if (!claim.modifiedCount) continue;
        try {
          const sent = await sendReminder(meeting, lead, property, kind);
          if (!sent) await Meeting.updateOne({ _id: meeting._id }, { $set: { [`reminders.${kind}`]: null } });
        } catch (error) {
          await Meeting.updateOne({ _id: meeting._id }, { $set: { [`reminders.${kind}`]: null } });
          logger.warn('[visit-reminder] Send failed', { meetingId: String(meeting._id), error: error.message });
        }
      }
    } catch (error) {
      logger.warn('[visit-reminder] Candidate failed', { meetingId: String(meeting._id), error: error.message });
    }
  }
}
function startVisitReminderScheduler() {
  if (timer) return;
  timer = setInterval(() => tick().catch(error => logger.error('[visit-reminder] Tick failed', { error: error.message })), 5 * 60 * 1000);
  timer.unref?.();
  tick().catch(error => logger.warn('[visit-reminder] Initial tick failed', { error: error.message }));
  logger.info('[visit-reminder] Scheduler started (5 minute interval, Asia/Kolkata)');
}
function stopVisitReminderScheduler() { if (timer) clearInterval(timer); timer = null; }
module.exports = { startVisitReminderScheduler, stopVisitReminderScheduler, tick };
