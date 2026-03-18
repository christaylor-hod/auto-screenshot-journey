import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Logger for Form Journey Mapper runs.
 *
 * Captures all console output to a log file, tracks structured events
 * (page visits, form fills, errors, timings), and writes a JSON manifest
 * summarising the run for debugging and support.
 */
export class RunLogger {
  constructor() {
    this.entries = [];          // All log lines with timestamps
    this.events = [];           // Structured events (page visits, fills, errors)
    this.warnings = [];         // Warnings only
    this.errors = [];           // Errors only
    this.timings = {};          // Named timers: { name: { start, end, duration } }
    this.config = {};           // Run configuration
    this.environment = {};      // System/environment info
    this.runDir = null;         // Set once run folder is created

    // Capture environment info upfront
    this.environment = {
      nodeVersion: process.version,
      platform: os.platform(),
      arch: os.arch(),
      osRelease: os.release(),
      cpus: os.cpus().length,
      totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
      freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
      cwd: process.cwd(),
      argv: process.argv.slice(2).join(' ')
    };

    // Intercept console methods to capture all output
    this._originalConsoleLog = console.log;
    this._originalConsoleWarn = console.warn;
    this._originalConsoleError = console.error;

    console.log = (...args) => {
      this._capture('INFO', args);
      this._originalConsoleLog.apply(console, args);
    };
    console.warn = (...args) => {
      this._capture('WARN', args);
      const msg = args.map(a => String(a)).join(' ');
      this.warnings.push({ time: new Date().toISOString(), message: msg });
      this._originalConsoleWarn.apply(console, args);
    };
    console.error = (...args) => {
      this._capture('ERROR', args);
      const msg = args.map(a => String(a)).join(' ');
      this.errors.push({ time: new Date().toISOString(), message: msg });
      this._originalConsoleError.apply(console, args);
    };
  }

  /**
   * Store the run configuration for the manifest
   */
  setConfig(config) {
    this.config = { ...config };
    // Sanitise: convert Sets to arrays for JSON
    if (this.config.excludeFields instanceof Set) {
      this.config.excludeFields = [...this.config.excludeFields];
    }
  }

  /**
   * Record a structured event
   */
  event(type, data) {
    this.events.push({
      time: new Date().toISOString(),
      elapsed: this._elapsed(),
      type,
      ...data
    });
  }

  /**
   * Start a named timer
   */
  startTimer(name) {
    this.timings[name] = { start: Date.now(), end: null, durationMs: null };
  }

  /**
   * Stop a named timer and return duration in ms
   */
  stopTimer(name) {
    if (this.timings[name]) {
      this.timings[name].end = Date.now();
      this.timings[name].durationMs = this.timings[name].end - this.timings[name].start;
      return this.timings[name].durationMs;
    }
    return 0;
  }

  /**
   * Set the run directory — log file and manifest will be written here
   */
  setRunDir(dir) {
    this.runDir = dir;
  }

  /**
   * Write the log file and JSON manifest to the run directory.
   * Call this at the very end of the run.
   */
  async writeOutputs(crawlData) {
    if (!this.runDir) return;

    // --- Plain text log ---
    const logPath = path.join(this.runDir, 'crawl.log');
    const logContent = this.entries.map(e => e.line).join('\n') + '\n';
    fs.writeFileSync(logPath, logContent);

    // --- JSON manifest ---
    const manifestPath = path.join(this.runDir, 'manifest.json');

    const pagesummary = [];
    if (crawlData?.pages) {
      for (const [url, pd] of crawlData.pages) {
        pagesummary.push({
          url: pd.url,
          pageName: pd.pageName,
          h1: pd.h1,
          fieldCount: pd.fields.length,
          choicePointCount: pd.choicePoints.length,
          isEndPage: pd.isEndPage,
          screenshotFile: crawlData.screenshots.has(url)
            ? path.basename(crawlData.screenshots.get(url))
            : null
        });
      }
    }

    const pathsSummary = (crawlData?.paths || []).map(p => ({
      id: p.id,
      stepCount: p.steps.length,
      steps: p.steps.map(s => ({
        url: s.url,
        pageName: s.pageName,
        choices: s.choices
      }))
    }));

    const edgesSummary = (crawlData?.edges || []).map(e => ({
      from: e.from,
      to: e.to,
      label: e.label
    }));

    // Dedupe edges for summary
    const uniqueEdges = [...new Set(edgesSummary.map(e => `${e.from} → ${e.to} [${e.label}]`))];

    const manifest = {
      version: '1.1.0',
      generatedAt: new Date().toISOString(),
      config: this.config,
      environment: this.environment,
      timings: Object.fromEntries(
        Object.entries(this.timings).map(([k, v]) => [k, {
          durationMs: v.durationMs,
          durationFormatted: v.durationMs ? formatDuration(v.durationMs) : null
        }])
      ),
      results: {
        pagesDiscovered: pagesummary.length,
        pathsExplored: pathsSummary.length,
        edgesFound: uniqueEdges.length,
        screenshotsTaken: crawlData?.screenshots?.size || 0,
        endPages: pagesummary.filter(p => p.isEndPage).length,
        choicePages: pagesummary.filter(p => p.choicePointCount > 0).length,
        totalFields: pagesummary.reduce((sum, p) => sum + p.fieldCount, 0)
      },
      warnings: this.warnings,
      errors: this.errors,
      pages: pagesummary,
      paths: pathsSummary,
      edges: uniqueEdges,
      events: this.events,
      outputFiles: listFilesRecursive(this.runDir)
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // Restore console
    this._restore();

    return { logPath, manifestPath };
  }

  // ── Internal helpers ──

  _capture(level, args) {
    // Strip chalk ANSI codes for the log file
    const plain = args.map(a => String(a).replace(/\x1b\[[0-9;]*m/g, '')).join(' ');
    const timestamp = new Date().toISOString();
    this.entries.push({
      time: timestamp,
      level,
      line: `[${timestamp}] [${level}] ${plain}`
    });
  }

  _elapsed() {
    if (this.timings.total?.start) {
      return `${Date.now() - this.timings.total.start}ms`;
    }
    return null;
  }

  _restore() {
    console.log = this._originalConsoleLog;
    console.warn = this._originalConsoleWarn;
    console.error = this._originalConsoleError;
  }
}

/**
 * Format milliseconds into a human-readable string
 */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

/**
 * List all files in a directory recursively, returning relative paths
 */
function listFilesRecursive(dir, basePath = '') {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const relPath = basePath ? `${basePath}/${entry}` : entry;
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...listFilesRecursive(fullPath, relPath));
      } else {
        results.push({
          path: relPath,
          sizeBytes: stat.size,
          sizeFormatted: formatFileSize(stat.size)
        });
      }
    }
  } catch { /* ignore */ }
  return results;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
