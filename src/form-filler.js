import { faker } from '@faker-js/faker/locale/en_GB';

// UK-specific data generators
const ukData = {
  niNumber() {
    const prefixes = ['AB', 'CD', 'EF', 'GH', 'JK', 'LM', 'NP', 'RS', 'TW'];
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
    const nums = Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join('');
    const suffix = ['A', 'B', 'C', 'D'][Math.floor(Math.random() * 4)];
    return `${prefix}${nums}${suffix}`;
  },

  postcode() {
    const areas = ['SW1A 1AA', 'EC1A 1BB', 'W1A 0AX', 'M1 1AE', 'B1 1BB', 'LS1 1BA',
      'S1 1WB', 'DE1 1HG', 'NG1 1AB', 'CB2 1TN', 'OX1 1PT', 'EH1 1YZ'];
    return areas[Math.floor(Math.random() * areas.length)];
  },

  ukPhone() {
    return `07${Math.floor(Math.random() * 900000000 + 100000000)}`;
  },

  sortCode() {
    return Array.from({ length: 3 }, () =>
      String(Math.floor(Math.random() * 90 + 10))
    ).join('-');
  },

  accountNumber() {
    return String(Math.floor(Math.random() * 90000000 + 10000000));
  },

  utr() {
    return String(Math.floor(Math.random() * 9000000000 + 1000000000));
  },

  passportNumber() {
    return String(Math.floor(Math.random() * 900000000 + 100000000));
  },

  drivingLicence() {
    const surname = 'SMITH';
    const decade = '9';
    const monthDay = '0612';
    const year = '73';
    const initials = 'JA';
    return `${surname}${decade}${monthDay}${year}${initials}9AA 01`;
  }
};

// Pattern matchers: [regex pattern for name/label/id, generator function]
const fieldPatterns = [
  // Names
  [/first.?name|given.?name|forename/i, () => faker.person.firstName()],
  [/last.?name|sur.?name|family.?name/i, () => faker.person.lastName()],
  [/middle.?name/i, () => faker.person.firstName()],
  [/full.?name|your.?name/i, () => faker.person.fullName()],
  [/title|prefix|salutation/i, () => 'Mr'],

  // Contact
  [/email/i, () => faker.internet.email({ provider: 'example.com' })],
  [/phone|mobile|tel|contact.?number/i, () => ukData.ukPhone()],

  // Address
  [/address.?line.?1|street|house/i, () => faker.location.streetAddress()],
  [/address.?line.?2/i, () => ''],
  [/city|town/i, () => faker.location.city()],
  [/county/i, () => 'Derbyshire'],
  [/post.?code|zip/i, () => ukData.postcode()],
  [/country/i, () => 'United Kingdom'],

  // Dates — IMPORTANT: day/month/year component patterns must come BEFORE
  // full date patterns, because GOV.UK date inputs use three separate fields
  // inside a fieldset labelled "Date of birth" etc. Without this ordering,
  // the label "Date of birth" matches /dob/ first and fills "1985-06-15"
  // into a field that only expects "15".
  // These patterns match field names/IDs like "dob-day", "passport-issued-month",
  // "year-of-birth" etc. The lookbehind ensures we match "-day" or "_day" as a
  // suffix/component, not just the word "day" in a label like "What day works best".
  [/[-_]day\b/i, () => DATE_STRATEGIES[currentDateStrategyIndex].day()],
  [/[-_]month\b/i, () => DATE_STRATEGIES[currentDateStrategyIndex].month()],
  [/[-_]year\b/i, () => DATE_STRATEGIES[currentDateStrategyIndex].year()],
  [/date.?of.?birth|dob|birth.?date/i, () => DOB_DATE.full()],
  [/date/i, () => DATE_STRATEGIES[currentDateStrategyIndex].full()],

  // UK Government specific
  [/national.?insurance|ni.?number|nino/i, () => ukData.niNumber()],
  [/passport/i, () => ukData.passportNumber()],
  [/driv(ing|er).?licen/i, () => ukData.drivingLicence()],
  [/sort.?code/i, () => ukData.sortCode()],
  [/account.?number/i, () => ukData.accountNumber()],
  [/utr|unique.?tax/i, () => ukData.utr()],
  [/crn|company.?(registration|number)/i, () => 'SC' + Math.floor(Math.random() * 900000 + 100000)],

  // Common fields
  [/reference|ref.?number|case/i, () => 'REF-' + Math.floor(Math.random() * 900000 + 100000)],
  [/description|details|comments|notes|reason|explain|more.?info/i, () => 'This is test data for journey mapping purposes.'],
  [/amount|salary|income|price|cost|value/i, () => '25000'],
  [/number|quantity|count|how.?many/i, () => '3'],
  [/url|website|link/i, () => 'https://www.example.com'],
  [/company|organi[sz]ation|employer|business/i, () => faker.company.name()],
  [/job|role|occupation|position/i, () => 'Software Developer'],
  [/password/i, () => 'TestPassword123!'],
  [/username/i, () => 'testuser' + Math.floor(Math.random() * 1000)],
];

/**
 * Date generation strategies.
 * When a form rejects one set of dates (e.g. "must be within the last year"),
 * the crawler can retry with a different strategy.
 */
const DATE_STRATEGIES = [
  {
    name: 'recent_past',      // Default: 2 weeks ago — passes most "recent date" validations
    day: () => { const d = new Date(); d.setDate(d.getDate() - 14); return String(d.getDate()); },
    month: () => { const d = new Date(); d.setDate(d.getDate() - 14); return String(d.getMonth() + 1); },
    year: () => { const d = new Date(); d.setDate(d.getDate() - 14); return String(d.getFullYear()); },
    full: () => { const d = new Date(); d.setDate(d.getDate() - 14); return d.toISOString().split('T')[0]; }
  },
  {
    name: 'near_future',      // 2 weeks from now — for booking/appointment forms
    day: () => { const d = new Date(); d.setDate(d.getDate() + 14); return String(d.getDate()); },
    month: () => { const d = new Date(); d.setDate(d.getDate() + 14); return String(d.getMonth() + 1); },
    year: () => { const d = new Date(); d.setDate(d.getDate() + 14); return String(d.getFullYear()); },
    full: () => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString().split('T')[0]; }
  },
  {
    name: 'today',            // Today's date
    day: () => String(new Date().getDate()),
    month: () => String(new Date().getMonth() + 1),
    year: () => String(new Date().getFullYear()),
    full: () => new Date().toISOString().split('T')[0]
  },
  {
    name: 'months_ago',       // 3 months ago — passes "within the last 6/12 months" validations
    day: () => { const d = new Date(); d.setMonth(d.getMonth() - 3); return String(d.getDate()); },
    month: () => { const d = new Date(); d.setMonth(d.getMonth() - 3); return String(d.getMonth() + 1); },
    year: () => { const d = new Date(); d.setMonth(d.getMonth() - 3); return String(d.getFullYear()); },
    full: () => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d.toISOString().split('T')[0]; }
  },
  {
    name: 'far_past',         // Last resort: fixed historical date
    day: () => '15',
    month: () => '6',
    year: () => '1985',
    full: () => '1985-06-15'
  }
];

// DOB is always a separate concern — use an age of ~30
const DOB_DATE = {
  day: () => '15',
  month: () => '6',
  year: () => String(new Date().getFullYear() - 30),
  full: () => `${new Date().getFullYear() - 30}-06-15`
};

// Current date strategy index — can be advanced by the crawler on retry
let currentDateStrategyIndex = 0;

export function setDateStrategy(index) {
  currentDateStrategyIndex = Math.min(index, DATE_STRATEGIES.length - 1);
}

export function getDateStrategyCount() {
  return DATE_STRATEGIES.length;
}

export function getCurrentDateStrategyName() {
  return DATE_STRATEGIES[currentDateStrategyIndex].name;
}

function getDateValues(nameId, searchText) {
  // Check if this is a DOB field — always use the DOB date regardless of strategy
  const isDob = /date.?of.?birth|dob|birth.?date/.test(searchText) || /dob/.test(nameId);

  const source = isDob ? DOB_DATE : DATE_STRATEGIES[currentDateStrategyIndex];

  if (/[-_]day\b/.test(nameId)) return source.day();
  if (/[-_]month\b/.test(nameId)) return source.month();
  if (/[-_]year\b/.test(nameId)) return source.year();

  return null; // Not a date component field
}

export function generateValueForField(field) {
  const searchText = `${field.label || ''} ${field.name || ''} ${field.id || ''} ${field.placeholder || ''}`.toLowerCase();
  const nameId = `${field.name || ''} ${field.id || ''}`.toLowerCase();

  // GOV.UK date input detection: check name/id for day/month/year components
  const dateValue = getDateValues(nameId, searchText);
  if (dateValue !== null) return dateValue;

  // Try pattern matching
  for (const [pattern, generator] of fieldPatterns) {
    if (pattern.test(searchText)) {
      return generator();
    }
  }

  // Fallback based on input type
  switch (field.type) {
    case 'email':
      return faker.internet.email({ provider: 'example.com' });
    case 'tel':
      return ukData.ukPhone();
    case 'number':
      return '5';
    case 'date':
      return DATE_STRATEGIES[currentDateStrategyIndex].full();
    case 'url':
      return 'https://www.example.com';
    case 'password':
      return 'TestPassword123!';
    default:
      return 'Test data';
  }
}

/**
 * Fill all form fields on a page using Playwright
 */
export async function fillFormFields(page, fields, choiceOverrides = {}) {
  const filledFields = [];
  const FILL_TIMEOUT = 3000; // 3s per field, not 30s

  for (const field of fields) {
    const fieldKey = field.name || field.id || field.label;
    if (!fieldKey) continue;

    try {
      // Check if this field has a choice override (for branching exploration)
      const overrideValue = choiceOverrides[fieldKey];

      // Helper to get a locator and verify it's visible before interacting
      async function getVisibleLocator(selector) {
        const loc = page.locator(selector).first();
        if (await loc.count() === 0) return null;
        try {
          // Quick visibility check - if not visible in 1s, skip entirely
          const isVisible = await loc.isVisible();
          if (!isVisible) return null;
          return loc;
        } catch {
          return null; // not visible, skip
        }
      }

      if (field.type === 'radio') {
        const valueToSelect = overrideValue || field.options?.[0]?.value;
        if (valueToSelect) {
          const selector = `input[type="radio"][name="${field.name}"][value="${valueToSelect}"]`;
          const radio = await getVisibleLocator(selector);
          if (radio) {
            await radio.click({ timeout: FILL_TIMEOUT });
            filledFields.push({ ...field, filledValue: valueToSelect });
          }
        }
      } else if (field.type === 'checkbox') {
        const valueToCheck = overrideValue !== undefined ? overrideValue : true;
        if (valueToCheck) {
          const selector = field.id ? `#${CSS.escape(field.id)}` : `input[type="checkbox"][name="${field.name}"]`;
          const checkbox = await getVisibleLocator(selector);
          if (checkbox && !(await checkbox.isChecked())) {
            await checkbox.click({ timeout: FILL_TIMEOUT });
            filledFields.push({ ...field, filledValue: 'checked' });
          }
        }
      } else if (field.type === 'select') {
        const valueToSelect = overrideValue || field.options?.[1]?.value || field.options?.[0]?.value;
        if (valueToSelect) {
          const selector = field.id ? `#${CSS.escape(field.id)}` : `select[name="${field.name}"]`;
          const select = await getVisibleLocator(selector);
          if (select) {
            await select.selectOption(valueToSelect, { timeout: FILL_TIMEOUT });
            filledFields.push({ ...field, filledValue: valueToSelect });
          }
        }
      } else if (field.type === 'textarea') {
        const value = overrideValue || generateValueForField(field);
        const selector = field.id ? `#${CSS.escape(field.id)}` : `textarea[name="${field.name}"]`;
        const textarea = await getVisibleLocator(selector);
        if (textarea) {
          await textarea.fill(value, { timeout: FILL_TIMEOUT });
          filledFields.push({ ...field, filledValue: value });
        }
      } else {
        // Text-like inputs
        const value = overrideValue || generateValueForField(field);
        const selector = field.id ? `#${CSS.escape(field.id)}` : `input[name="${field.name}"]`;
        const input = await getVisibleLocator(selector);
        if (input) {
          await input.fill(value, { timeout: FILL_TIMEOUT });
          filledFields.push({ ...field, filledValue: value });
        }
      }
    } catch (err) {
      // Skip fields that can't be interacted with
      console.warn(`  ⚠ Could not fill field "${fieldKey}": ${err.message}`);
    }
  }

  return filledFields;
}

/**
 * CSS.escape polyfill for Node
 */
if (typeof CSS === 'undefined') {
  globalThis.CSS = {
    escape(str) {
      return str.replace(/([^\w-])/g, '\\$1');
    }
  };
}
