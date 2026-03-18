import { chromium } from 'playwright';
import { fillFormFields } from './form-filler.js';
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

    // Collected data
    this.pages = new Map();        // pageKey -> page data
    this.edges = [];                // { from, to, label, pathId }
    this.paths = [];                // array of path objects
    this.screenshots = new Map();   // pageKey -> screenshot file path

    this.pathCount = 0;
    this.browser = null;
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
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 }
    });
    const page = await context.newPage();

    try {
      // Navigate to the start URL
      await page.goto(this.startUrl, { waitUntil: 'networkidle', timeout: this.timeout });
      await page.waitForTimeout(this.delay);

      // Replay each step
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];

        // Dismiss cookie banners
        await this.dismissCookieBanner(page);

        // Extract fields on current page for filling
        const rawFields = await extractFormFields(page);
        const fields = this.filterFields(rawFields);

        // Fill form with the recorded choices for this step
        await fillFormFields(page, fields, step.choices || {});
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
      const context = await this.browser.newContext({
        viewport: { width: 1280, height: 900 }
      });
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

        for (let i = 0; i < combinations.length; i++) {
          if (this.pathCount >= this.maxPaths) break;

          const choices = combinations[i];
          const choiceLabel = Object.entries(choices).map(([k, v]) => `${k}=${v}`).join(', ');
          console.log(`\n  🔀 Exploring combination ${i + 1}/${combinations.length}: ${choiceLabel || 'default'}`);

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

            // Fill the form with this combination
            await fillFormFields(branchPage, branchFields, choices);
            await branchPage.waitForTimeout(300);

            // Click continue
            const nextUrl = await this.clickContinue(branchPage);

            if (nextUrl && nextUrl !== currentUrl) {
              const nextPk = this.pageKey(nextUrl);
              this.edges.push({
                from: pk,
                to: nextPk,
                label: choiceLabel || 'continue',
                pathId: `path_${this.pathCount + 1}`
              });

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
        // No choice points — fill and continue in current session
        await fillFormFields(page, fields);
        await page.waitForTimeout(300);

        const nextUrl = await this.clickContinue(page);

        if (nextUrl && nextUrl !== currentUrl) {
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
