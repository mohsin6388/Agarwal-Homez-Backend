const mongoose = require('mongoose');
const { Schema } = mongoose;

const meetingSchema = new Schema(
  {
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    propertyId: { type: Schema.Types.ObjectId, ref: 'Property', default: null },

    preferredDate: { type: String, required: true }, // ISO date (YYYY-MM-DD)
    preferredTime: { type: String, required: true }, // "HH:mm" 24hr

    bookedBy: { type: String, enum: ["whatsapp_ai", "email_reply", "manual"], default: "manual", index: true },
    agentName: { type: String, trim: true, default: "" },
    agentPhone: { type: String, trim: true, default: "" },
    confirmed: { type: Boolean, default: true },
    reminders: { dayBeforeSentAt: { type: Date, default: null }, twoHourSentAt: { type: Date, default: null } },
    status: {
      type: String,
      enum: ['scheduled', 'visited', 'not_visited', 'rescheduled', 'cancelled'],
      default: 'scheduled',
    },
    notes: { type: String, default: '' },

    // Google Calendar sync — set once the event is booked (see
    // services/calendar/googleCalendarService.js). Null if Calendar isn't
    // configured or the booking call failed.
    googleEventId: { type: String, default: null },
    googleEventLink: { type: String, default: null },
  },
  { timestamps: true }
);

meetingSchema.index({ ownerId: 1, preferredDate: 1, status: 1 }, { name: 'owner_visit_date_status' });
module.exports = mongoose.model('Meeting', meetingSchema);
