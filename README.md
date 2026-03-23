# Form Journey Mapper

Automatically crawl form-based websites (optimised for GOV.UK transactional services), explore all branching paths, and generate structured documentation including spreadsheets, flowcharts with page screenshots, and a PDF for importing into Mural.

Works with real services, and published prototypes both local and public. 

Made with ai assistance. 

## What it does

1. **Crawls** a form-based website starting from a URL you provide (using Playwright)
2. **Fills forms intelligently** with realistic UK dummy data (names, NI numbers, postcodes, etc.)
3. **Explores all paths** — when it encounters radio buttons, dropdowns, or other choice points, it systematically tries every option to discover all branches
4. **Takes screenshots** of every page in the journey (cookie banners are automatically hidden)
5. **Exports to XLSX** — a structured spreadsheet with pages shown in hierarchy, form fields, journey paths, and connections
6. **Generates a visual flowchart** — an interactive HTML diagram with page screenshots on each node, zoom/pan controls, and SVG export. Also generates a PDF for importing into Mural.

**Note this will submit real forms if it navigates to a submission page** 

## Setup

```bash
# Install dependencies
npm install

# Install Playwright browsers (first time only)
npx playwright install chromium
```

## Usage

### Basic usage
```bash
node src/index.js https://example-service.gov.uk/question1
```

** Note - best results are from inputting the first proper question page of the service you want to screenshot **

### Common flags

```bash
# Limit how deep the crawler goes (default: 30 pages deep)
node src/index.js https://example.gov.uk/apply --max-depth 10

# Limit how many branching paths to explore (default: 100)
node src/index.js https://example.gov.uk/apply --max-paths 20

# Combine both for a quick shallow crawl
node src/index.js https://example.gov.uk/apply --max-depth 5 --max-paths 10

# Exclude common site-wide fields by ID or name (e.g. search boxes, feedback widgets)
node src/index.js https://example.gov.uk/apply --exclude-fields "search-field,feedback-toggle"

# Exclude fields from a file (one ID/name per line, supports # comments)
node src/index.js https://example.gov.uk/apply --exclude-fields-file ./exclude.txt

# Custom output directory
node src/index.js https://example.gov.uk/apply -o ./my-audit

# Run in headed mode (see the browser)
node src/index.js https://example.gov.uk/apply --headed

# Increase timeout for slow pages
node src/index.js https://example.gov.uk/apply --timeout 30000

# Skip specific outputs
node src/index.js https://example.gov.uk/apply --no-xlsx
node src/index.js https://example.gov.uk/apply --no-mermaid

# Dry run — visit only the start page and report what was found (fields, choices, buttons)
node src/index.js https://example.gov.uk/apply --dry-run

# Verbose mode — show every field fill, replay step, and navigation in the terminal
node src/index.js https://example.gov.uk/apply --verbose

# Combine for debugging: see the browser, verbose output, shallow crawl
node src/index.js https://example.gov.uk/apply --headed --verbose --max-depth 3 --max-paths 5

# Password-protected GOV.UK prototype (Heroku or localhost)
node src/index.js https://my-prototype.herokuapp.com/start --password mypassword

# Local prototype on localhost
node src/index.js http://localhost:3000/start --password password

# HTTP Basic Auth protected site
node src/index.js https://staging.example.gov.uk/apply --auth username:password
```

### All options

| Option | Description | Default |
|--------|-------------|---------|
| `-o, --output <dir>` | Output directory | `./output` |
| `-d, --max-depth <n>` | Maximum page depth per path | 30 |
| `-p, --max-paths <n>` | Maximum branching paths to explore | 100 |
| `-t, --timeout <ms>` | Page load timeout (ms) | 15000 |
| `--delay <ms>` | Delay between actions (ms) | 500 |
| `--headed` | Show browser window | false |
| `--verbose` | Show detailed fill, replay, and navigation output | false |
| `--dry-run` | Visit start page only, report fields and choices found | false |
| `--password <password>` | Password for GOV.UK Prototype Kit prototypes | none |
| `--auth <user:pass>` | HTTP Basic Auth credentials (username:password) | none |
| `--exclude-fields <ids>` | Comma-separated field IDs/names to ignore | none |
| `--exclude-fields-file <path>` | File with field IDs/names to ignore (one per line) | none |
| `--no-stay-on-domain` | Allow off-domain links | stays on domain |
| `--no-xlsx` | Skip spreadsheet export | generates xlsx |
| `--no-mermaid` | Skip flowchart/PDF export | generates all |

### Tips for controlling crawl size

- **Start small**: use `--max-depth 5 --max-paths 10` for a first pass to check it's working, then increase
- **Large services**: GOV.UK services with many branching questions can generate hundreds of paths. Use `--max-paths 30` to cap exploration
- **Slow pages**: if pages take a while to load, increase `--timeout 30000` (30 seconds)
- **Exclude noise**: site-wide search boxes, cookie buttons, and feedback widgets can be excluded with `--exclude-fields`

### Key terms

- **Depth** — how many pages deep into the journey a page sits. The start page is depth 0. After clicking Continue once you're at depth 1, after two submits depth 2, and so on. Two pages can be at the same depth but on completely different branches. The `--max-depth` flag limits how many steps the crawler will follow before stopping any given path.

- **Paths** — complete journeys through the form from start to finish. If a form has no branching there's 1 path. If the first page has 2 radio options that lead to different routes, and both eventually reach an end page, that's 2 paths. The spreadsheet's Journey Paths tab lists every path with the choices made at each step. The `--max-paths` flag caps how many total paths the crawler will explore.

- **Connections** — links between two pages. When you fill a form and click Continue, that creates one connection from the current page to the next. If a page has radio buttons with 3 options and each leads to a different page, that's 3 connections from that one page. In the diagram these are the arrows between nodes.

- **Choice points** — form fields where the user picks between options that could lead to different pages (radio buttons, dropdowns, checkbox groups). The crawler detects these and systematically tries each option to discover every possible branch. A page with 0 choice points just gets filled and submitted once.

## Output

Each crawl creates a timestamped subfolder named after the form's title:

```
output/
├── 20260212_143022_apply-for-a-passport/
│   ├── journey-map.xlsx        # Spreadsheet with 4 tabs
│   ├── journey-map.mmd         # Mermaid source
│   ├── journey-map.html        # Interactive viewer with zoom/pan and screenshots
│   ├── journey-map.pdf         # PDF for importing into Mural
│   ├── crawl.log               # Full timestamped log of everything that happened
│   ├── manifest.json           # Machine-readable summary of the run
│   └── screenshots/            # Full-page PNG of every page
│       ├── page-1.png
│       └── ...
├── 20260213_091500_register-to-vote/
│   └── ...
```

### Log file and manifest

Every run produces two support files alongside the outputs:

**`crawl.log`** — a plain-text log with timestamps for every action: page visits, field fills, navigations, warnings, and errors. Useful for understanding exactly what the crawler did, and for sharing with others when something doesn't look right.

**`manifest.json`** — a structured JSON summary containing:
- **Config** — the exact flags and options used for this run
- **Environment** — Node version, OS, architecture, memory
- **Timings** — how long the crawl, spreadsheet export, and diagram generation each took
- **Results summary** — page count, path count, edge count, end pages, choice pages, total fields
- **Pages** — every page discovered with URL, name, field count, choice points, and screenshot filename
- **Paths** — every complete path through the form with the choices made at each step
- **Events** — a chronological log of structured events (page visits, form fills with exact values entered, branch points, replays, navigation, errors)
- **Warnings and errors** — any issues encountered during the crawl
- **Output files** — a list of every file generated with sizes

The manifest is particularly useful for comparing runs — you can diff two `manifest.json` files to see what changed between crawls of the same form.

### Dry run

Use `--dry-run` to visit only the start page without crawling further. This reports what fields, choice points, and buttons were found, so you can check the crawler is detecting the form correctly before committing to a full crawl:

```
$ node src/index.js https://example.gov.uk/apply --dry-run

═══ DRY RUN REPORT ═══

  Page name:     What is your enquiry about?
  Fields found:  1
  Choice points: 1
  Buttons:       Continue

  Fields:
    • [radio] What is your enquiry about? (3 options)

  Choice points (would branch into 3 combinations):
    • enquiry-type: General | Complaint | Freedom of information
```

### Verbose mode

Use `--verbose` to see detailed output in the terminal, including every field that was filled (with the value entered), every replay step when exploring branches, and every navigation. Combine with `--headed` to watch the browser while seeing the fill log:

```bash
node src/index.js https://example.gov.uk/apply --verbose --headed --max-depth 5
```

### Password-protected prototypes

The tool works with GOV.UK Prototype Kit prototypes, including those hosted on Heroku with password protection and those running locally.

**Localhost** — just pass the local URL, no special flags needed:

```bash
node src/index.js http://localhost:3000/start
```

**Prototype Kit password page** — use `--password` to automatically submit the password before crawling. The crawler detects the Prototype Kit's password form, submits the password, captures the auth cookie, and reuses it for every session (including when replaying branches):

```bash
# Heroku-hosted prototype
node src/index.js https://my-prototype.herokuapp.com/start --password mypassword

# Local prototype with password enabled
node src/index.js http://localhost:3000/start --password password
```

**HTTP Basic Auth** — some staging environments use HTTP Basic Auth (the browser popup). Use `--auth` with `username:password` format:

```bash
node src/index.js https://staging.example.gov.uk/apply --auth admin:secretpass
```

Both auth methods can be combined with all other flags. The manifest.json records whether authentication was used (but not the password itself).

### Interactive HTML viewer

The `.html` file is a self-contained diagram with:
- **Page screenshots** embedded on each node card
- **Zoom & pan** — scroll wheel, click-drag, pinch on touch devices, or use the +/−/Fit/1:1 buttons
- **SVG export** — click the ⬇ SVG button to download as a vector image
- **Screenshot gallery** tab — full-size screenshots with lightbox

### PDF for Mural

The `journey-map.pdf` is automatically sized to fit the full diagram and can be imported directly into Mural as an image. The PDF preserves the screenshot thumbnails and colour-coded node borders.

### Spreadsheet tabs

1. **Pages** — Every page discovered, shown in tree hierarchy with indentation. Includes: depth, URL, field count, choice points, whether it's an end page, and what it links to
2. **Form Fields** — Every field on every page: label, name, type, required, options, hints, validation patterns
3. **Journey Paths** — Each complete path through the form with the choices made at each step
4. **Connections** — The from→to relationships between pages with the trigger/label

### Mermaid flowchart

The `.mmd` file is a lightweight left-to-right text representation that can be pasted into any Mermaid-compatible tool (GitHub, Notion, HackMD, etc.).

Node shapes indicate page types:
- 🔷 **Blue hexagons** — Pages with choice points (branching)
- ⬜ **Grey rectangles** — Standard form pages
- 🟢 **Green rounded** — End/confirmation pages

## How form filling works

The tool uses pattern matching on field labels, names, and IDs to determine appropriate dummy data:

| Pattern | Example data |
|---------|-------------|
| First name | "John" |
| Surname | "Smith" |
| Email | "john.smith@example.com" |
| NI number | "AB123456C" |
| Postcode | "SW1A 1AA" |
| Phone | "07123456789" |
| Date of birth | "1985-06-15" |
| Address | "42 Test Street" |

For fields that don't match any pattern, it falls back to generic test data. Custom patterns can be added in `src/form-filler.js`.

## How path exploration works

When the crawler encounters a page with choice points (radio buttons, select dropdowns, checkboxes), it:

1. Identifies all choice-point fields
2. Generates the cartesian product of all options (capped at 50 combinations per page)
3. For each combination, fills the form, submits, and follows the resulting path
4. Tracks visited states to avoid infinite loops
5. Continues until it reaches end pages or hits depth/path limits

## Limitations

- Forms behind authentication are not currently supported
- JavaScript-heavy SPAs with client-side routing may need increased timeouts
- Very complex forms with many choice points can generate a large number of paths — use `--max-paths` to control this
- File upload fields are skipped
- CAPTCHAs will block the crawler
