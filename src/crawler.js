import { chromium } from 'playwright';
import { fillFormFields, setDateStrategy, getDateStrategyCount, getCurrentDateStrategyName } from './form-filler.js';
import {
  extractPageMetadata,
  extractFormFields,
  identifyChoicePoints,
  generateChoiceCombinations
} from './data-extractor.js';
import path from 'path';
import fs from 'fs';

/**
 * Crawl a form-based website exploring all branching paths.
 *
 * Session-aware: each branch is explored in a fresh browser context,
 * replaying the full path from the start URL so session-based forms
 * (like GOV.UK Forms) work correctly.
 */
export class FormCrawler {
  constructor(options = {}) {
    this.startUrl = options.startUrl;
    this.outputDir = options.outputDir || './output';
    this.maxDepth = options.maxDepth || 30;
    this.maxPaths = options.maxPaths || 100;
    this.timeout = options.timeout || 10000;
    this.headless = options.headless !== false;
    this.delay = options.delay || 500;
    this.stayOnDomain = options.stayOnDomain !== false;
    this.excludeFields = options.excludeFields || new Set();
    this.logger = options.logger || null;
    this.verbose = options.verbose || false;
    this.password = options.password || null;
    this.httpAuth = options.httpAuth || null; // { username, password }

    // Collected data
    this.pages = new Map();        // pageKey -> page data
    this.edges = [];                // { from, to, label, pathId }
    this.paths = [];                // array of path objects
    this.screenshots = new Map();   // pageKey -> screenshot file path

    this.pathCount = 0;
    this.browser = null;
    this.authCookies = [];          // Cookies from initial authentication
  }

  shortPageId(url) {
    try {
      const u = new URL(url);
      return u.pathname.replace(/^\//, '').replace(/\//g, '_') || 'index';
    } catch {
      return url.replace(/[^a-zA-Z0-9]/g, '_');
    }
  }

  pageKey(url) {
    return url.split('?')[0].split('#')[0];
  }

  /**
   * Create a new browser context with auth cookies and HTTP credentials applied
   */
  async createContext() {
    const contextOptions = {
      viewport: { width: 1280, height: 900 }
    };

    // Apply HTTP Basic Auth if configured
    if (this.httpAuth) {
      contextOptions.httpCredentials = this.httpAuth;
    }

    const context = await this.browser.newContext(contextOptions);

    // Inject auth cookies from initial authentication
    if (this.authCookies.length > 0) {
      await context.addCookies(this.authCookies);
    }

    return context;
  }

  /**
   * Authenticate with the target site before crawling.
   * Handles GOV.UK Prototype Kit password pages and HTTP Basic Auth.
   */
  async authenticate() {
    if (!this.password && !this.httpAuth) return;

    if (this.httpAuth) {
      console.log(`  🔑 HTTP Basic Auth configured for user "${this.httpAuth.username}"`);
      // HTTP credentials are applied per-context in createContext(), no upfront step needed.
      // But let's verify the credentials work:
      const context = await this.createContext();
      const page = await context.newPage();
      try {
        await page.goto(this.startUrl, { waitUntil: 'networkidle', timeout: this.timeout });
        console.log(`  ✅ HTTP Auth successful`);
        // Capture any cookies set after auth
        this.authCookies = await context.cookies();
      } catch (err) {
        console.error(`  ❌ HTTP Auth failed: ${err.message}`);
        throw new Error(`Authentication failed: ${err.message}`);
      } finally {
        await context.close();
      }
      return;
    }

    if (this.password) {
      console.log(`  🔑 Authenticating with password...`);
      const context = await this.browser.newContext({
        viewport: { width: 1280, height: 900 }
      });
      const page = await context.newPage();

      try {
        await page.goto(this.startUrl, { waitUntil: 'networkidle', timeout: this.timeout });
        await page.waitForTimeout(this.delay);

        // Try to find and submit password on the GOV.UK Prototype Kit password page
        // The kit uses a simple form with a single password input
        const passwordSubmitted = await page.evaluate((pwd) => {
          // GOV.UK Prototype Kit password page patterns
          const passwordInputSelectors = [
            'input[type="password"]',
            'input[name="password"]',
            '#password'
          ];

          for (const sel of passwordInputSelectors) {
            const input = document.querySelector(sel);
            if (input) {
              // Found a password field — fill it via native input setter
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
              ).set;
              nativeInputValueSetter.call(input, pwd);
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }
          return false;
        }, this.password);

        if (passwordSubmitted) {
          // Use Playwright to fill (more reliable for form state) then submit
          const pwdInput = page.locator('input[type="password"], input[name="password"], #password').first();
          await pwdInput.fill(this.password, { timeout: 3000 });

          // Click the submit button
          const submitBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Continue"), button:has-text("Enter"), button:has-text("Sign in")').first();
          if (await submitBtn.count() > 0) {
            await Promise.all([
              page.waitForLoadState('networkidle', { timeout: this.timeout }).catch(() => {}),
              submitBtn.click()
            ]);
          } else {
            // Fallback: submit the form directly
            await page.locator('form').first().evaluate(form => form.submit());
            await page.waitForLoadState('networkidle', { timeout: this.timeout }).catch(() => {});
          }

          await page.waitForTimeout(this.delay);

          // Check if we got past the password page
          const stillOnPasswordPage = await page.locator('input[type="password"], input[name="password"]').count() > 0;

          if (stillOnPasswordPage) {
            console.error(`  ❌ Password rejected — still on password page`);
            throw new Error('Password authentication failed: password was rejected');
          }

          console.log(`  ✅ Password accepted — authenticated at ${page.url()}`);

          // Capture cookies for reuse in all subsequent contexts
          this.authCookies = await context.cookies();

          if (this.logger) {
            this.logger.event('authentication', {
              method: 'password',
              success: true,
              cookieCount: this.authCookies.length,
              landingUrl: page.url()
            });
          }
        } else {
          console.log(`  ⚠ No password field found on start page — proceeding without auth`);
          if (this.logger) {
            this.logger.event('authentication', {
              method: 'password',
              success: false,
              reason: 'no_password_field'
            });
          }
        }
      } finally {
        await context.close();
      }
    }
  }

  /**
   * Main crawl entry point
   */
  async crawl() {
    console.log(`\n🔍 Starting form journey crawl`);
    console.log(`   URL: ${this.startUrl}`);
    console.log(`   Max depth: ${this.maxDepth}`);
    console.log(`   Max paths: ${this.maxPaths}`);
    console.log(`   Output: ${this.outputDir}\n`);

    fs.mkdirSync(path.join(this.outputDir, 'screenshots'), { recursive: true });

    this.browser = await chromium.launch({
      headless: this.headless,
      channel: 'chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
      // Authenticate if password or HTTP credentials configured
      await this.authenticate();
      // Start exploring with no prior steps (empty replay history)
      await this.explorePath([], 0);

      console.log(`\n✅ Crawl complete!`);
      console.log(`   Pages found: ${this.pages.size}`);
      console.log(`   Paths explored: ${this.pathCount}`);
      console.log(`   Edges: ${this.edges.length}`);
    } finally {
      await this.browser.close();
    }

    return {
      pages: this.pages,
      edges: this.edges,
      paths: this.paths,
      screenshots: this.screenshots
    };
  }

  /**
   * Replay a series of steps from the start URL in a fresh session,
   * then return the page object positioned at the resulting page.
   *
   * Each step is: { url, choices, fields }
   *   - choices: the choice overrides to apply at that step
   *   - fields: the extracted field list for that page (used for filling)
   *
   * Returns { context, page, currentUrl } or null if replay fails.
   */
  async replayPath(steps) {
    const context = await this.createContext();
    const page = await context.newPage();

    try {
      // Navigate to the start URL
      await page.goto(this.startUrl, { waitUntil: 'networkidle', timeout: this.timeout });
      await page.waitForTimeout(this.delay);

      if (this.verbose) {
        console.log(`     ↻ Replaying ${steps.length} step(s) from start...`);
      }

      // Replay each step
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];

        if (this.verbose) {
          const choiceStr = Object.keys(step.choices || {}).length > 0
            ? ` [${Object.values(step.choices).join(', ')}]`
            : '';
          console.log(`       ↻ Step ${i + 1}/${steps.length}: ${step.pageName || page.url()}${choiceStr}`);
        }

        // Dismiss cookie banners
        await this.dismissCookieBanner(page);

        // Extract fields on current page for filling
        const rawFields = await extractFormFields(page);
        const fields = this.filterFields(rawFields);

        // Fill form with the recorded choices for this step
        const filledFields = await fillFormFields(page, fields, step.choices || {});

        if (this.logger && this.verbose) {
          this.logger.event('replay_fill', {
            step: i + 1,
            fieldsAttempted: fields.length,
            fieldsFilled: filledFields.length,
            fills: filledFields.map(f => ({
              label: f.label || f.name || f.id,
              type: f.type,
              value: f.filledValue
            }))
          });
        }
        await page.waitForTimeout(300);

        // Click continue
        const nextUrl = await this.clickContinue(page);
        if (!nextUrl) {
          console.warn(`     ⚠ Replay failed at step ${i + 1}: no navigation after submit`);
          await context.close();
          return null;
        }
        await page.waitForTimeout(this.delay);
      }

      return { context, page, currentUrl: page.url() };
    } catch (err) {
      console.warn(`     ⚠ Replay failed: ${err.message}`);
      await context.close();
      return null;
    }
  }

  /**
   * Explore the form journey from a given point.
   *
   * @param {Array} replaySteps - Steps to replay from start to reach current point
   * @param {number} depth - Current depth in the form journey
   */
  async explorePath(replaySteps, depth) {
    if (depth > this.maxDepth) {
      console.log(`  ⚠ Max depth (${this.maxDepth}) reached, stopping this path`);
      return;
    }

    if (this.pathCount >= this.maxPaths) {
      console.log(`  ⚠ Max paths (${this.maxPaths}) reached, stopping exploration`);
      return;
    }

    // Open a fresh session and replay to reach the current point
    let session;
    if (replaySteps.length === 0) {
      // First page - just navigate to start
      const context = await this.createContext();
      const page = await context.newPage();
      await page.goto(this.startUrl, { waitUntil: 'networkidle', timeout: this.timeout });
      await page.waitForTimeout(this.delay);
      session = { context, page, currentUrl: page.url() };
    } else {
      session = await this.replayPath(replaySteps);
      if (!session) return;
    }

    const { context, page, currentUrl } = session;

    try {
      // Check domain constraint
      if (this.stayOnDomain) {
        const startDomain = new URL(this.startUrl).hostname;
        const currentDomain = new URL(currentUrl).hostname;
        if (currentDomain !== startDomain) {
          console.log(`  ↩ Left domain (${currentDomain}), stopping this path`);
          return;
        }
      }

      // Dismiss cookie banners
      await this.dismissCookieBanner(page);

      // Extract page data
      const metadata = await extractPageMetadata(page);
      const rawFields = await extractFormFields(page);
      const fields = this.filterFields(rawFields);
      const choicePoints = identifyChoicePoints(fields);

      const pk = this.pageKey(currentUrl);
      const pid = this.shortPageId(currentUrl);

      console.log(`  📄 [depth ${depth}] ${metadata.pageName || currentUrl}`);
      console.log(`     Fields: ${fields.length}, Choice points: ${choicePoints.length}`);

      // Log structured event
      if (this.logger) {
        this.logger.event('page_visit', {
          depth,
          url: currentUrl,
          pageName: metadata.pageName,
          h1: metadata.h1,
          fieldCount: fields.length,
          choicePointCount: choicePoints.length,
          fields: fields.map(f => ({
            type: f.type, name: f.name, id: f.id,
            label: (f.label || '').substring(0, 80),
            required: f.required,
            optionCount: f.options?.length || 0,
            isChoicePoint: f.isChoicePoint || false
          })),
          buttons: metadata.buttons.map(b => b.text)
        });
      }

      // Take screenshot
      if (!this.screenshots.has(pk)) {
        const screenshotPath = path.join(this.outputDir, 'screenshots', `${pid}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        this.screenshots.set(pk, screenshotPath);
        console.log(`     📸 Screenshot saved`);
      }

      // Store page data
      if (!this.pages.has(pk)) {
        this.pages.set(pk, {
          id: pid,
          url: currentUrl,
          pageName: metadata.pageName,
          h1: metadata.h1,
          title: metadata.title,
          caption: metadata.caption,
          fields: fields,
          buttons: metadata.buttons,
          links: metadata.links,
          choicePoints: choicePoints,
          isEndPage: false
        });
      }

      // Check if this is an end page
      const hasForm = fields.length > 0;
      const hasContinueButton = metadata.buttons.some(b =>
        /continue|next|submit|save|send|confirm|start now|start application/i.test(b.text)
      );

      if (!hasForm && !hasContinueButton) {
        console.log(`     🏁 End page (no form or continue button)`);
        this.pages.get(pk).isEndPage = true;

        if (this.logger) {
          this.logger.event('end_page', { depth, url: currentUrl, pageName: metadata.pageName });
        }

        this.paths.push({
          id: `path_${++this.pathCount}`,
          steps: this.buildPathSteps(replaySteps, currentUrl, metadata.pageName, {})
        });
        return;
      }

      // --- Branching logic ---
      if (choicePoints.length > 0) {
        const combinations = generateChoiceCombinations(choicePoints);
        console.log(`     🔀 ${combinations.length} choice combination(s) to explore`);

        if (this.logger) {
          this.logger.event('branch_point', {
            depth, url: currentUrl, pageName: metadata.pageName,
            choicePoints: choicePoints.map(cp => ({
              name: cp.name,
              options: cp.options.map(o => o.text || o.value)
            })),
            combinationCount: combinations.length
          });
        }

        for (let i = 0; i < combinations.length; i++) {
          if (this.pathCount >= this.maxPaths) break;

          const choices = combinations[i];
          const choiceLabel = Object.values(choices).join(', ');
          const choiceLabelFull = Object.entries(choices).map(([k, v]) => `${k}=${v}`).join(', ');
          console.log(`\n  🔀 Exploring combination ${i + 1}/${combinations.length}: ${choiceLabelFull || 'default'}`);

          if (this.logger) {
            this.logger.event('explore_combination', {
              depth, url: currentUrl,
              combinationIndex: i + 1,
              totalCombinations: combinations.length,
              choices
            });
          }

          // For the FIRST combination, reuse the current session to save time.
          // For subsequent combinations, we need a fresh session and full replay.
          let branchPage, branchContext;

          if (i === 0) {
            // Reuse current page - it's already at the right place with a fresh session
            branchPage = page;
            branchContext = context;
          } else {
            // Fresh session: replay all steps to get back to this page
            const freshSession = await this.replayPath(replaySteps);
            if (!freshSession) {
              console.warn(`     ⚠ Could not replay to branch point for combination ${i + 1}`);
              if (this.logger) {
                this.logger.event('replay_failed', { depth, url: currentUrl, combinationIndex: i + 1 });
              }
              continue;
            }
            branchPage = freshSession.page;
            branchContext = freshSession.context;

            // Dismiss cookie banner on replayed page
            await this.dismissCookieBanner(branchPage);
          }

          try {
            // Re-extract fields on the (possibly replayed) page
            const branchRawFields = await extractFormFields(branchPage);
            const branchFields = this.filterFields(branchRawFields);

            // Fill and submit with date retry logic
            const { nextUrl, filledFields } = await this.fillAndSubmitWithRetry(
              branchPage, branchFields, choices,
              { depth, pageName: metadata.pageName, combination: i + 1 }
            );

            if (this.logger && filledFields.length > 0) {
              this.logger.event('form_fill', {
                depth,
                url: currentUrl,
                pageName: metadata.pageName,
                combination: i + 1,
                fieldsAttempted: branchFields.length,
                fieldsFilled: filledFields.length,
                fills: filledFields.map(f => ({
                  label: f.label || f.name || f.id,
                  type: f.type,
                  value: f.filledValue
                }))
              });
            }

            if (nextUrl) {
              const nextPk = this.pageKey(nextUrl);
              this.edges.push({
                from: pk,
                to: nextPk,
                label: choiceLabel || 'continue',
                pathId: `path_${this.pathCount + 1}`
              });

              if (this.logger) {
                this.logger.event('navigation', {
                  depth,
                  from: currentUrl,
                  to: nextUrl,
                  trigger: choiceLabel || 'continue'
                });
              }

              // Build new replay steps: all previous steps + this choice
              const newReplaySteps = [...replaySteps, { choices, url: currentUrl, pageName: metadata.pageName }];

              // Recurse — this will open its own fresh session
              // Close current branch session first to free resources
              if (i > 0) {
                await branchContext.close();
              }

              await this.explorePath(newReplaySteps, depth + 1);
            } else {
              console.log(`     ⚠ No navigation after submit for combination ${i + 1}`);
              // Take error screenshot
              const errorScreenshot = path.join(this.outputDir, 'screenshots', `${pid}_error_${i}.png`);
              await branchPage.screenshot({ path: errorScreenshot, fullPage: true });

              if (this.logger) {
                this.logger.event('no_navigation', {
                  depth,
                  url: currentUrl,
                  pageName: metadata.pageName,
                  combination: i + 1,
                  errorScreenshot: `${pid}_error_${i}.png`
                });
              }

              if (i > 0) {
                await branchContext.close();
              }
            }
          } catch (err) {
            console.warn(`     ⚠ Error exploring combination ${i + 1}: ${err.message}`);
            if (i > 0) {
              await branchContext.close();
            }
          }
        }
      } else {
        // No choice points — fill and submit with date retry logic
        const { nextUrl, filledFields } = await this.fillAndSubmitWithRetry(
          page, fields, {},
          { depth, pageName: metadata.pageName }
        );

        if (this.logger && filledFields.length > 0) {
          this.logger.event('form_fill', {
            depth,
            url: currentUrl,
            pageName: metadata.pageName,
            fieldsAttempted: fields.length,
            fieldsFilled: filledFields.length,
            fills: filledFields.map(f => ({
              label: f.label || f.name || f.id,
              type: f.type,
              value: f.filledValue
            }))
          });
        }

        if (nextUrl) {
          const nextPk = this.pageKey(nextUrl);
          this.edges.push({
            from: pk,
            to: nextPk,
            label: 'continue',
            pathId: `path_${this.pathCount + 1}`
          });

          // Continue with one extra replay step (no choices)
          const newReplaySteps = [...replaySteps, { choices: {}, url: currentUrl, pageName: metadata.pageName }];
          await this.explorePath(newReplaySteps, depth + 1);
        } else {
          console.log(`     🏁 No next page found, treating as end`);
          this.pages.get(pk).isEndPage = true;
          this.paths.push({
            id: `path_${++this.pathCount}`,
            steps: this.buildPathSteps(replaySteps, currentUrl, metadata.pageName, {})
          });
        }
      }
    } catch (err) {
      console.warn(`  ❌ Error at depth ${depth}: ${err.message}`);
    } finally {
      await context.close();
    }
  }

  /**
   * Build a path steps array for recording completed paths
   */
  buildPathSteps(replaySteps, currentUrl, pageName, choices) {
    const steps = replaySteps.map((step) => ({
      url: step.url || 'unknown',
      pageName: step.pageName || 'Unknown step',
      choices: step.choices
    }));
    steps.push({ url: currentUrl, pageName, choices });
    return steps;
  }

  /**
   * Filter out excluded fields
   */
  filterFields(rawFields) {
    return rawFields.filter(f => {
      const fieldId = f.id || '';
      const fieldName = f.name || '';
      return !this.excludeFields.has(fieldId) && !this.excludeFields.has(fieldName);
    });
  }

  /**
   * Dismiss cookie banners before screenshots
   */
  async dismissCookieBanner(page) {
    await page.evaluate(() => {
      // Try clicking Accept / Hide buttons first
      const btnSelectors = [
        'button[data-accept-cookies="true"]',
        '.govuk-cookie-banner button',
        'button.cookie-banner__button--accept',
        '.gem-c-cookie-banner__button',
        'button[data-hide-cookie-banner]',
        '.js-cookie-banner-hide'
      ];
      for (const sel of btnSelectors) {
        const btn = document.querySelector(sel);
        if (btn) { btn.click(); break; }
      }

      // Force-hide common cookie banners
      const selectors = [
        '.govuk-cookie-banner', '#global-cookie-message', '.gem-c-cookie-banner',
        '.cookie-banner', '[data-module="cookie-banner"]', '#cookie-banner',
        '.js-cookie-banner',
        '#cookie-consent', '.cookie-consent', '.cc-banner', '.cc-window',
        '#onetrust-banner-sdk', '.onetrust-pc-dark-filter',
        '#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay'
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => { el.style.display = 'none'; });
      }
    }).catch(() => { /* ignore */ });

    await page.waitForTimeout(300);
  }

  /**
   * Check if the page is showing validation errors (GOV.UK error summary)
   */
  async hasValidationErrors(page) {
    return await page.evaluate(() => {
      // GOV.UK error summary component
      const errorSummary = document.querySelector('.govuk-error-summary, .error-summary, [role="alert"]');
      if (errorSummary) {
        const errorText = errorSummary.textContent || '';
        return {
          hasErrors: true,
          errorText: errorText.trim().substring(0, 500),
          isDateRelated: /date|day|month|year|must be|between|after|before|in the past|in the future|valid|range/i.test(errorText)
        };
      }

      // Also check for inline field errors
      const fieldErrors = document.querySelectorAll('.govuk-error-message, .field-validation-error, .error-message');
      if (fieldErrors.length > 0) {
        const errorText = Array.from(fieldErrors).map(e => e.textContent.trim()).join('; ');
        return {
          hasErrors: true,
          errorText: errorText.substring(0, 500),
          isDateRelated: /date|day|month|year|must be|between|after|before|in the past|in the future|valid|range/i.test(errorText)
        };
      }

      return { hasErrors: false, errorText: '', isDateRelated: false };
    }).catch(() => ({ hasErrors: false, errorText: '', isDateRelated: false }));
  }

  /**
   * Fill a form and submit, retrying with different date strategies if validation fails.
   * Returns { nextUrl, filledFields } or { nextUrl: null } if all retries fail.
   */
  async fillAndSubmitWithRetry(page, fields, choices = {}, context = {}) {
    const maxDateRetries = getDateStrategyCount();

    for (let attempt = 0; attempt < maxDateRetries; attempt++) {
      setDateStrategy(attempt);

      if (attempt > 0) {
        console.log(`     🔄 Retrying with date strategy: ${getCurrentDateStrategyName()} (attempt ${attempt + 1}/${maxDateRetries})`);

        if (this.logger) {
          this.logger.event('date_retry', {
            attempt: attempt + 1,
            strategy: getCurrentDateStrategyName(),
            url: page.url(),
            ...context
          });
        }

        // Re-extract fields since the page may have re-rendered with error state
        const rawFields = await extractFormFields(page);
        fields = this.filterFields(rawFields);
      }

      const filledFields = await fillFormFields(page, fields, choices);
      await page.waitForTimeout(300);

      if (this.verbose && filledFields.length > 0) {
        for (const f of filledFields) {
          console.log(`       ✏️  [${f.type}] ${f.label || f.name || f.id} → "${f.filledValue}"`);
        }
      }

      const currentUrl = page.url();
      const nextUrl = await this.clickContinue(page);

      if (nextUrl && nextUrl !== currentUrl) {
        // Success — reset strategy to default for next page
        setDateStrategy(0);
        return { nextUrl, filledFields };
      }

      // Check if we got validation errors
      const validation = await this.hasValidationErrors(page);

      if (validation.hasErrors) {
        console.log(`     ⚠ Validation error: ${validation.errorText.substring(0, 120)}`);

        if (this.logger) {
          this.logger.event('validation_error', {
            attempt: attempt + 1,
            strategy: getCurrentDateStrategyName(),
            isDateRelated: validation.isDateRelated,
            errorText: validation.errorText,
            url: currentUrl,
            ...context
          });
        }

        // If it's not date-related, no point trying more date strategies
        if (!validation.isDateRelated && attempt > 0) {
          console.log(`     ⚠ Non-date validation error — stopping retries`);
          break;
        }

        // Continue to next strategy
        continue;
      }

      // No navigation and no visible errors — probably just a reload
      break;
    }

    // Reset date strategy for next page
    setDateStrategy(0);
    return { nextUrl: null, filledFields: [] };
  }

  /**
   * Find and click the continue/submit button, return the new URL
   */
  async clickContinue(page) {
    const currentUrl = page.url();

    const selectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      '.govuk-button:not(.govuk-button--secondary)',
      'button.govuk-button',
      'a.govuk-button',
      'button:has-text("Continue")',
      'button:has-text("Next")',
      'button:has-text("Submit")',
      'button:has-text("Save and continue")',
      'button:has-text("Send")',
      'button:has-text("Confirm")',
      'a:has-text("Start now")',
      'a:has-text("Start application")',
      'a:has-text("Continue")',
      'form button',
      'form input[type="submit"]'
    ];

    for (const selector of selectors) {
      try {
        const button = page.locator(selector).first();
        if (await button.count() > 0 && await button.isVisible()) {
          await Promise.all([
            page.waitForLoadState('networkidle', { timeout: this.timeout }).catch(() => {}),
            button.click()
          ]);

          await page.waitForTimeout(this.delay);
          const newUrl = page.url();

          if (newUrl !== currentUrl) {
            return newUrl;
          }
        }
      } catch {
        // Try next selector
      }
    }

    return null;
  }
}
