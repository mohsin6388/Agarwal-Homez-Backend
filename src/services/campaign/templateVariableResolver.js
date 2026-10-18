function formatInrBudget(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return '';
  if (amount >= 100000) {
    const lakhs = amount / 100000;
    return `₹${lakhs.toLocaleString('en-IN', { maximumFractionDigits: 2 })} lakh`;
  }
  return `₹${amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function formatBudget(lead = {}) {
  const min = Number(lead.budgetMin);
  const max = Number(lead.budgetMax);
  const hasMin = lead.budgetMin !== null && lead.budgetMin !== undefined && Number.isFinite(min);
  const hasMax = lead.budgetMax !== null && lead.budgetMax !== undefined && Number.isFinite(max);
  if (hasMin && hasMax) {
    const low = formatInrBudget(min);
    const high = formatInrBudget(max);
    return low && high ? `${low} – ${high}` : '';
  }
  if (hasMin) return formatInrBudget(min);
  if (hasMax) return formatInrBudget(max);
  return '';
}

function resolveTemplateVariableValue(lead = {}, variable = {}) {
  const source = String(variable.source || 'name').toLowerCase();
  let value = '';
  if (source === 'name') value = lead.name;
  else if (source === 'phone') value = lead.phone;
  else if (source === 'email') value = lead.email;
  else if (source === 'city') value = lead.city || lead.location;
  else if (source === 'budget') value = formatBudget(lead);
  else if (source === 'static') value = variable.value;
  const resolved = String(value ?? '').trim();
  const fallback = String(variable.fallback ?? '').trim();
  return (resolved || fallback || 'Customer').slice(0, 1024);
}

function buildTemplateComponents({ variables = [], lead = {}, headerType = 'none', headerImageUrl = '', headerDocumentUrl = '' } = {}) {
  const components = [];
  const maxIndex = variables.reduce((max, item) => Math.max(max, Number(item.index) || 0), 0);
  const parameters = [];
  for (let index = 1; index <= maxIndex; index += 1) {
    const variable = variables.find((item) => Number(item.index) === index) || { index, source: 'name' };
    parameters.push({ type: 'text', text: resolveTemplateVariableValue(lead, variable) });
  }
  const normalizedHeaderType = String(headerType || 'none').toLowerCase();
  if (normalizedHeaderType === 'image' && headerImageUrl) {
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerImageUrl } }] });
  } else if (['document', 'pdf', 'brochure'].includes(normalizedHeaderType) && headerDocumentUrl) {
    components.push({ type: 'header', parameters: [{ type: 'document', document: { link: headerDocumentUrl } }] });
  }
  if (parameters.length) components.push({ type: 'body', parameters });
  return components;
}

function getWhatsAppRate(settings, category) {
  const normalized = String(category || '').toUpperCase();
  const key = normalized === 'UTILITY' ? 'utilityInr' : 'marketingInr';
  const configured = settings?.whatsappRates?.[key];
  if (configured !== null && configured !== undefined && Number.isFinite(Number(configured)) && Number(configured) >= 0) {
    return Number(configured);
  }
  const envKey = key === 'utilityInr' ? 'META_WHATSAPP_UTILITY_RATE_INR' : 'META_WHATSAPP_MARKETING_RATE_INR';
  const envValue = process.env[envKey];
  if (envValue !== undefined && envValue !== '' && Number.isFinite(Number(envValue)) && Number(envValue) >= 0) {
    return Number(envValue);
  }
  return null;
}

module.exports = { formatBudget, resolveTemplateVariableValue, buildTemplateComponents, getWhatsAppRate };
