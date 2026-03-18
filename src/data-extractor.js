/**
 * Extract all form field metadata and page information from a Playwright page
 */

/**
 * Extract page-level metadata
 */
export async function extractPageMetadata(page) {
  return await page.evaluate(() => {
    const title = document.title || '';
    const h1 = document.querySelector('h1')?.textContent?.trim() || '';
    const caption = document.querySelector('.govuk-caption-l, .govuk-caption-xl')?.textContent?.trim() || '';
    const legend = document.querySelector('fieldset legend')?.textContent?.trim() || '';

    // Determine page name: prefer h1, fallback to title
    const pageName = h1 || title;

    // Find continue/submit buttons
    const buttons = [];
    document.querySelectorAll('button, input[type="submit"], a.govuk-button, .govuk-button').forEach(btn => {
      buttons.push({
        text: btn.textContent?.trim() || btn.value || '',
        type: btn.tagName.toLowerCase() === 'a' ? 'link' : 'button',
        href: btn.href || null
      });
    });

    // Find all links on the page
    const links = [];
    document.querySelectorAll('a[href]').forEach(a => {
      links.push({
        text: a.textContent?.trim() || '',
        href: a.href
      });
    });

    return {
      title,
      h1,
      caption,
      legend,
      pageName,
      url: window.location.href,
      buttons,
      links
    };
  });
}

/**
 * Extract all form fields from the page
 */
export async function extractFormFields(page) {
  return await page.evaluate(() => {
    const fields = [];

    // Helper to find label for an input
    function findLabel(el) {
      // Check for explicit label via 'for' attribute
      if (el.id) {
        const label = document.querySelector(`label[for="${el.id}"]`);
        if (label) return label.textContent.trim();
      }

      // Check for GOV.UK style label (within fieldset legend)
      const fieldset = el.closest('fieldset');
      if (fieldset) {
        const legend = fieldset.querySelector('legend');
        if (legend) return legend.textContent.trim();
      }

      // Check for wrapping label
      const parentLabel = el.closest('label');
      if (parentLabel) return parentLabel.textContent.trim();

      // Check for aria-label or aria-labelledby
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
      if (el.getAttribute('aria-labelledby')) {
        const labelEl = document.getElementById(el.getAttribute('aria-labelledby'));
        if (labelEl) return labelEl.textContent.trim();
      }

      // GOV.UK: check for .govuk-label within the same form-group
      const formGroup = el.closest('.govuk-form-group');
      if (formGroup) {
        const label = formGroup.querySelector('.govuk-label, .govuk-fieldset__legend');
        if (label) return label.textContent.trim();
      }

      return '';
    }

    // Helper to find hint text
    function findHint(el) {
      const describedBy = el.getAttribute('aria-describedby');
      if (describedBy) {
        const hintEl = document.getElementById(describedBy);
        if (hintEl && hintEl.classList.contains('govuk-hint')) {
          return hintEl.textContent.trim();
        }
      }
      const formGroup = el.closest('.govuk-form-group');
      if (formGroup) {
        const hint = formGroup.querySelector('.govuk-hint');
        if (hint) return hint.textContent.trim();
      }
      return '';
    }

    // Helper to check if element is part of site-wide chrome (not the main form)
    function isSiteChrome(el) {
      // Check if inside a search landmark, GOV.UK search component, or site header/footer nav
      if (el.closest('[role="search"]') || el.closest('.gem-c-search') || el.closest('.gem-c-search-with-autocomplete')) return true;
      if (el.closest('header nav') || el.closest('footer') || el.closest('.govuk-footer')) return true;
      return false;
    }

    // Helper to check if an element or its form-group container is hidden
    function isHidden(el) {
      if (!el) return true;
      // Walk up the DOM checking for display:none or hidden containers
      let current = el;
      while (current && current !== document.body) {
        const style = window.getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden') return true;
        current = current.parentElement;
      }
      return false;
    }

    // Process text-type inputs (visibility matters - skip hidden ones)
    document.querySelectorAll('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"]):not([type="search"]):not([type="image"]):not([type="reset"])').forEach(input => {
      if (isSiteChrome(input) || isHidden(input)) return;
      fields.push({
        type: input.type || 'text',
        name: input.name || '',
        id: input.id || '',
        label: findLabel(input),
        hint: findHint(input),
        placeholder: input.placeholder || '',
        required: input.required || input.getAttribute('aria-required') === 'true',
        pattern: input.pattern || '',
        maxLength: input.maxLength > 0 ? input.maxLength : null,
        minLength: input.minLength > 0 ? input.minLength : null,
        autocomplete: input.autocomplete || '',
        isChoicePoint: false
      });
    });

    // Process textareas
    document.querySelectorAll('textarea').forEach(textarea => {
      if (isSiteChrome(textarea) || isHidden(textarea)) return;
      fields.push({
        type: 'textarea',
        name: textarea.name || '',
        id: textarea.id || '',
        label: findLabel(textarea),
        hint: findHint(textarea),
        placeholder: textarea.placeholder || '',
        required: textarea.required || textarea.getAttribute('aria-required') === 'true',
        maxLength: textarea.maxLength > 0 ? textarea.maxLength : null,
        isChoicePoint: false
      });
    });

    // Process selects (may be hidden if replaced by accessible autocomplete, but still capture them)
    document.querySelectorAll('select').forEach(select => {
      if (isSiteChrome(select)) return;
      const options = Array.from(select.options).map(opt => ({
        value: opt.value,
        text: opt.textContent.trim(),
        selected: opt.selected
      }));

      // A select with more than 2 non-empty options is a potential branching point
      const meaningfulOptions = options.filter(o => o.value && o.value !== '');

      fields.push({
        type: 'select',
        name: select.name || '',
        id: select.id || '',
        label: findLabel(select),
        hint: findHint(select),
        required: select.required,
        options: options,
        isChoicePoint: meaningfulOptions.length > 1
      });
    });

    // Process radio button groups
    // NOTE: GOV.UK visually hides radio inputs and styles labels instead,
    // so we do NOT check visibility here — only filter site chrome
    const radioGroups = {};
    document.querySelectorAll('input[type="radio"]').forEach(radio => {
      if (isSiteChrome(radio)) return;
      const groupName = radio.name;
      if (!radioGroups[groupName]) {
        radioGroups[groupName] = {
          type: 'radio',
          name: groupName,
          id: radio.id || '',
          label: findLabel(radio),
          hint: findHint(radio),
          required: radio.required,
          options: [],
          isChoicePoint: true
        };
      }

      // Get the specific label for this radio option
      let optionLabel = '';
      const specificLabel = document.querySelector(`label[for="${radio.id}"]`);
      if (specificLabel) {
        optionLabel = specificLabel.textContent.trim();
      }

      radioGroups[groupName].options.push({
        value: radio.value,
        text: optionLabel || radio.value,
        id: radio.id
      });
    });
    fields.push(...Object.values(radioGroups));

    // Process checkbox groups (same as radios — don't check visibility)
    const checkboxGroups = {};
    document.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      if (isSiteChrome(cb)) return;
      const groupName = cb.name;
      if (!checkboxGroups[groupName]) {
        checkboxGroups[groupName] = {
          type: 'checkbox',
          name: groupName,
          id: cb.id || '',
          label: findLabel(cb),
          hint: findHint(cb),
          required: cb.required,
          options: [],
          isChoicePoint: true
        };
      }

      let optionLabel = '';
      const specificLabel = document.querySelector(`label[for="${cb.id}"]`);
      if (specificLabel) {
        optionLabel = specificLabel.textContent.trim();
      }

      checkboxGroups[groupName].options.push({
        value: cb.value,
        text: optionLabel || cb.value,
        id: cb.id
      });
    });
    fields.push(...Object.values(checkboxGroups));

    return fields;
  });
}

/**
 * Identify choice points (fields that may cause branching)
 * Returns an array of { fieldName, options[] } for fields that are branching candidates
 */
export function identifyChoicePoints(fields) {
  return fields
    .filter(f => f.isChoicePoint && f.options && f.options.length > 1)
    .map(f => ({
      fieldName: f.name || f.id,
      fieldType: f.type,
      label: f.label,
      options: f.options
        .filter(o => o.value && o.value !== '')
        .map(o => ({
          value: o.value,
          text: o.text
        }))
    }));
}

/**
 * Generate all combinations of choice point selections
 * For fields with options [A, B, C], generates [{field: A}, {field: B}, {field: C}]
 * For multiple choice points, generates the cartesian product
 */
export function generateChoiceCombinations(choicePoints) {
  if (choicePoints.length === 0) return [{}];

  // Limit total combinations to prevent explosion
  const MAX_COMBINATIONS = 50;

  function cartesian(arrays) {
    if (arrays.length === 0) return [{}];

    return arrays.reduce((acc, { fieldName, options }) => {
      const result = [];
      for (const combo of acc) {
        for (const option of options) {
          result.push({ ...combo, [fieldName]: option.value });
          if (result.length >= MAX_COMBINATIONS) return result;
        }
      }
      return result;
    }, [{}]);
  }

  return cartesian(choicePoints);
}
