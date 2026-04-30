#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { FormCrawler } from './crawler.js';
import { exportToXlsx } from './xlsx-exporter.js';
import { generateMermaid } from './mermaid-generator.js';
import { RunLogger } from './logger.js';
import path from 'path';
import fs from 'fs';

const program = new Command();

program
  .name('form-mapper')
  .description('Crawl form-based websites, map all journeys, export to XLSX and Mermaid flowcharts')
  .version('1.1.0');

program
  .argument('<url>', 'Starting URL of the form journey')
  .option('-o, --output <dir>', 'Output directory', './output')
  .option('-d, --max-depth <n>', 'Maximum page depth to crawl', v => parseInt(v, 10), 30)
  .option('-p, --max-paths <n>', 'Maximum number of paths to explore', v => parseInt(v, 10), 100)
  .option('-t, --timeout <ms>', 'Page load timeout in milliseconds', v => parseInt(v, 10), 15000)
  .option('--delay <ms>', 'Delay between page actions in milliseconds', v => parseInt(v, 10), 500)
  .option('--headed', 'Run browser in headed mode (visible)', false)
  .option('--exclude-fields <ids>', 'Comma-separated list of field IDs or names to exclude')
  .option('--exclude-fields-file <path>', 'Path to a text file with one field ID/name per line to exclude')
  .option('--no-stay-on-domain', 'Allow crawling to follow links off the starting domain')
  .option('--no-xlsx', 'Skip XLSX export')
  .option('--no-mermaid', 'Skip Mermaid diagram generation')
  .option('--dry-run', 'Visit the start page only, report what was found, then exit', false)
  .option('--verbose', 'Show detailed output including every field fill and replay step', false)
  .option('--password <password>', 'Password for GOV.UK Prototype Kit password-protected prototypes')
  .option('--auth <user:pass>', 'HTTP Basic Auth credentials (username:password)')
  .option('--pause-for-login', 'Open browser for manual login before crawling (for One Login, MFA etc)', false)
  .action(async (url, options) => {

    // Initialise logger — starts capturing all console output immediately
    const logger = new RunLogger();
    logger.startTimer('total');

    console.log(chalk.bold.blue('\n╔══════════════════════════════════════╗'));
    console.log(chalk.bold.blue('║    Form Journey Mapper v1.1.0        ║'));
    console.log(chalk.bold.blue('╚══════════════════════════════════════╝\n'));

    // Validate URL
    try {
      new URL(url);
    } catch {
      console.error(chalk.red(`❌ Invalid URL: ${url}`));
      process.exit(1);
    }

    // Build excluded fields set
    const excludeFields = new Set();
    if (options.excludeFields) {
      options.excludeFields.split(',').map(s => s.trim()).filter(Boolean).forEach(id => excludeFields.add(id));
    }
    if (options.excludeFieldsFile) {
      try {
        const content = fs.readFileSync(path.resolve(options.excludeFieldsFile), 'utf-8');
        content.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')).forEach(id => excludeFields.add(id));
      } catch (err) {
        console.error(chalk.red(`❌ Could not read exclude fields file: ${err.message}`));
        process.exit(1);
      }
    }
    if (excludeFields.size > 0) {
      console.log(chalk.grey(`  Excluding ${excludeFields.size} field(s): ${[...excludeFields].join(', ')}`));
    }

    // Parse HTTP Basic Auth credentials
    let httpAuth = null;
    if (options.auth) {
      const parts = options.auth.split(':');
      if (parts.length < 2) {
        console.error(chalk.red(`❌ --auth must be in format username:password`));
        process.exit(1);
      }
      httpAuth = { username: parts[0], password: parts.slice(1).join(':') };
    }

    // Record config in logger
    logger.setConfig({
      startUrl: url,
      maxDepth: options.maxDepth,
      maxPaths: options.maxPaths,
      timeout: options.timeout,
      delay: options.delay,
      headed: !!options.headed,
      verbose: !!options.verbose,
      stayOnDomain: options.stayOnDomain,
      xlsx: options.xlsx !== false,
      mermaid: options.mermaid !== false,
      dryRun: !!options.dryRun,
      excludeFields: excludeFields,
      passwordProtected: !!options.password,
      httpAuth: !!httpAuth,
      pauseForLogin: !!options.pauseForLogin
    });

    // Resolve output directory
    const outputDir = path.resolve(options.output);
    fs.mkdirSync(outputDir, { recursive: true });

    // Run crawler
    const crawler = new FormCrawler({
      startUrl: url,
      outputDir: outputDir,
      maxDepth: options.dryRun ? 0 : options.maxDepth,
      maxPaths: options.dryRun ? 1 : options.maxPaths,
      timeout: options.timeout,
      headless: !options.headed,
      delay: options.delay,
      stayOnDomain: options.stayOnDomain,
      excludeFields: excludeFields,
      logger: logger,
      verbose: !!options.verbose,
      password: options.password || null,
      httpAuth: httpAuth,
      pauseForLogin: !!options.pauseForLogin
    });

    try {
      logger.startTimer('crawl');
      const crawlData = await crawler.crawl();
      const crawlDuration = logger.stopTimer('crawl');
      console.log(chalk.grey(`  Crawl completed in ${formatDuration(crawlDuration)}`));

      // Dry run — just report what was found on the start page
      if (options.dryRun) {
        console.log(chalk.bold.yellow('\n═══ DRY RUN REPORT ═══\n'));
        const firstPage = crawlData.pages.values().next().value;
        if (firstPage) {
          console.log(`  Page name:     ${firstPage.pageName}`);
          console.log(`  H1:            ${firstPage.h1}`);
          console.log(`  URL:           ${firstPage.url}`);
          console.log(`  Fields found:  ${firstPage.fields.length}`);
          console.log(`  Choice points: ${firstPage.choicePoints.length}`);
          console.log(`  Buttons:       ${firstPage.buttons.map(b => b.text).join(', ')}`);
          if (firstPage.fields.length > 0) {
            console.log(`\n  Fields:`);
            for (const f of firstPage.fields) {
              const opts = f.options ? ` (${f.options.length} options)` : '';
              console.log(`    • [${f.type}] ${f.label || f.name || f.id || 'unnamed'}${opts}${f.required ? ' *required' : ''}`);
            }
          }
          if (firstPage.choicePoints.length > 0) {
            console.log(`\n  Choice points (would branch into ${firstPage.choicePoints.reduce((s, cp) => s * cp.options.length, 1)} combinations):`);
            for (const cp of firstPage.choicePoints) {
              console.log(`    • ${cp.name}: ${cp.options.map(o => o.text || o.value).join(' | ')}`);
            }
          }
        }
        console.log(chalk.grey('\n  (Use without --dry-run to crawl the full journey)\n'));
        logger.stopTimer('total');
        return;
      }

      // Build timestamped output subfolder
      const firstPage = crawlData.pages.values().next().value;
      const formTitle = firstPage?.h1 || firstPage?.pageName || firstPage?.title || 'untitled';
      const slug = formTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
      const timestamp = new Date().toISOString()
        .replace(/T/, '_')
        .replace(/[:.]/g, '')
        .slice(0, 15);
      const runFolder = `${timestamp}_${slug}`;
      const runDir = path.join(outputDir, runFolder);

      // Move screenshots into the run directory
      const oldScreenshotDir = path.join(outputDir, 'screenshots');
      const newScreenshotDir = path.join(runDir, 'screenshots');
      fs.mkdirSync(newScreenshotDir, { recursive: true });

      if (fs.existsSync(oldScreenshotDir)) {
        for (const file of fs.readdirSync(oldScreenshotDir)) {
          fs.renameSync(
            path.join(oldScreenshotDir, file),
            path.join(newScreenshotDir, file)
          );
        }
        fs.rmdirSync(oldScreenshotDir);
      }

      // Update screenshot paths
      for (const [key, screenshotPath] of crawlData.screenshots) {
        const filename = path.basename(screenshotPath);
        crawlData.screenshots.set(key, path.join(newScreenshotDir, filename));
      }

      crawlData.formTitle = formTitle;

      // Tell logger where to write
      logger.setRunDir(runDir);

      // Export XLSX
      if (options.xlsx !== false) {
        console.log(chalk.yellow('\n📊 Generating spreadsheet...'));
        logger.startTimer('xlsx');
        await exportToXlsx(crawlData, runDir);
        logger.stopTimer('xlsx');
      }

      // Generate diagram + PDF
      if (options.mermaid !== false) {
        console.log(chalk.yellow('\n🔀 Generating flowchart and PDF...'));
        logger.startTimer('diagram');
        await generateMermaid(crawlData, runDir);
        logger.stopTimer('diagram');
      }

      // Write log file and manifest
      logger.stopTimer('total');
      const { logPath, manifestPath } = await logger.writeOutputs(crawlData);

      // Summary (after logger.writeOutputs restores console)
      console.log(chalk.bold.green('\n════════════════════════════════════════'));
      console.log(chalk.bold.green('  ✅  Journey mapping complete!'));
      console.log(chalk.bold.green('════════════════════════════════════════\n'));
      console.log(`  📁 Output directory: ${chalk.cyan(runDir)}`);
      console.log(`  📄 Pages discovered: ${chalk.cyan(crawlData.pages.size)}`);
      console.log(`  🔀 Paths explored:   ${chalk.cyan(crawlData.paths.length)}`);
      console.log(`  🔗 Connections:      ${chalk.cyan(crawlData.edges.length)}`);
      console.log(`  📸 Screenshots:      ${chalk.cyan(crawlData.screenshots.size)}`);

      if (logger.warnings.length > 0) {
        console.log(`  ⚠️  Warnings:        ${chalk.yellow(logger.warnings.length)}`);
      }
      if (logger.errors.length > 0) {
        console.log(`  ❌ Errors:           ${chalk.red(logger.errors.length)}`);
      }

      console.log('');
      console.log(`  Files generated:`);

      const files = fs.readdirSync(runDir).filter(f => !fs.statSync(path.join(runDir, f)).isDirectory());
      files.forEach(f => console.log(`    ${chalk.grey('→')} ${f}`));

      if (fs.existsSync(newScreenshotDir)) {
        const screenshots = fs.readdirSync(newScreenshotDir);
        console.log(`    ${chalk.grey('→')} screenshots/ (${screenshots.length} files)`);
      }

      console.log('');
      console.log(`  ${chalk.grey('Log:      ' + path.basename(logPath))}`);
      console.log(`  ${chalk.grey('Manifest: ' + path.basename(manifestPath))}`);
      console.log('');

    } catch (err) {
      logger.stopTimer('total');
      console.error(chalk.red(`\n❌ Crawl failed: ${err.message}`));
      console.error(err.stack);

      // Still try to write logs even on failure
      if (logger.runDir) {
        try {
          await logger.writeOutputs(null);
          console.error(chalk.grey(`  Log saved to: ${logger.runDir}/crawl.log`));
        } catch { /* can't write logs either */ }
      }

      process.exit(1);
    }
  });

program.parse();

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}
