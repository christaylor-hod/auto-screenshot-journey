#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { FormCrawler } from './crawler.js';
import { exportToXlsx } from './xlsx-exporter.js';
import { generateMermaid } from './mermaid-generator.js';
import path from 'path';
import fs from 'fs';

const program = new Command();

program
  .name('form-mapper')
  .description('Crawl form-based websites, map all journeys, export to XLSX and Mermaid flowcharts')
  .version('1.0.0');

program
  .argument('<url>', 'Starting URL of the form journey')
  .option('-o, --output <dir>', 'Output directory', './output')
  .option('-d, --max-depth <n>', 'Maximum page depth to crawl', parseInt, 30)
  .option('-p, --max-paths <n>', 'Maximum number of paths to explore', parseInt, 100)
  .option('-t, --timeout <ms>', 'Page load timeout in milliseconds', parseInt, 15000)
  .option('--delay <ms>', 'Delay between page actions in milliseconds', parseInt, 500)
  .option('--headed', 'Run browser in headed mode (visible)', false)
  .option('--exclude-fields <ids>', 'Comma-separated list of field IDs or names to exclude (e.g. "search,feedback,cookie-consent")')
  .option('--exclude-fields-file <path>', 'Path to a text file with one field ID/name per line to exclude')
  .option('--no-stay-on-domain', 'Allow crawling to follow links off the starting domain')
  .option('--no-xlsx', 'Skip XLSX export')
  .option('--no-mermaid', 'Skip Mermaid diagram generation')
  .action(async (url, options) => {
    console.log(chalk.bold.blue('\n╔══════════════════════════════════════╗'));
    console.log(chalk.bold.blue('║    Form Journey Mapper v1.0.0        ║'));
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

    // Resolve output directory
    const outputDir = path.resolve(options.output);
    fs.mkdirSync(outputDir, { recursive: true });

    // Run crawler
    const crawler = new FormCrawler({
      startUrl: url,
      outputDir: outputDir,
      maxDepth: options.maxDepth,
      maxPaths: options.maxPaths,
      timeout: options.timeout,
      headless: !options.headed,
      delay: options.delay,
      stayOnDomain: options.stayOnDomain,
      excludeFields: excludeFields
    });

    try {
      const crawlData = await crawler.crawl();

      // Build timestamped output subfolder using the form title
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
        .slice(0, 15); // e.g. 20260212_143022
      const runFolder = `${timestamp}_${slug}`;
      const runDir = path.join(outputDir, runFolder);

      // Move screenshots into the run directory
      const oldScreenshotDir = path.join(outputDir, 'screenshots');
      const newScreenshotDir = path.join(runDir, 'screenshots');
      fs.mkdirSync(newScreenshotDir, { recursive: true });

      // Move all screenshots
      if (fs.existsSync(oldScreenshotDir)) {
        for (const file of fs.readdirSync(oldScreenshotDir)) {
          fs.renameSync(
            path.join(oldScreenshotDir, file),
            path.join(newScreenshotDir, file)
          );
        }
        fs.rmdirSync(oldScreenshotDir);
      }

      // Update screenshot paths in crawlData so exporters use relative paths
      for (const [key, screenshotPath] of crawlData.screenshots) {
        const filename = path.basename(screenshotPath);
        crawlData.screenshots.set(key, path.join(newScreenshotDir, filename));
      }

      // Store form title in crawlData for use by exporters
      crawlData.formTitle = formTitle;

      // Export to XLSX
      if (options.xlsx !== false) {
        console.log(chalk.yellow('\n📊 Generating spreadsheet...'));
        await exportToXlsx(crawlData, runDir);
      }

      // Generate Mermaid diagram
      if (options.mermaid !== false) {
        console.log(chalk.yellow('\n🔀 Generating Mermaid flowchart and PDF...'));
        await generateMermaid(crawlData, runDir);
      }

      // Summary
      console.log(chalk.bold.green('\n════════════════════════════════════════'));
      console.log(chalk.bold.green('  ✅  Journey mapping complete!'));
      console.log(chalk.bold.green('════════════════════════════════════════\n'));
      console.log(`  📁 Output directory: ${chalk.cyan(runDir)}`);
      console.log(`  📄 Pages discovered: ${chalk.cyan(crawlData.pages.size)}`);
      console.log(`  🔀 Paths explored:   ${chalk.cyan(crawlData.paths.length)}`);
      console.log(`  🔗 Connections:      ${chalk.cyan(crawlData.edges.length)}`);
      console.log(`  📸 Screenshots:      ${chalk.cyan(crawlData.screenshots.size)}`);
      console.log('');
      console.log(`  Files generated:`);

      const files = fs.readdirSync(runDir).filter(f => !fs.statSync(path.join(runDir, f)).isDirectory());
      files.forEach(f => console.log(`    ${chalk.grey('→')} ${f}`));

      if (fs.existsSync(newScreenshotDir)) {
        const screenshots = fs.readdirSync(newScreenshotDir);
        console.log(`    ${chalk.grey('→')} screenshots/ (${screenshots.length} files)`);
      }

      console.log('');

    } catch (err) {
      console.error(chalk.red(`\n❌ Crawl failed: ${err.message}`));
      console.error(err.stack);
      process.exit(1);
    }
  });

program.parse();
