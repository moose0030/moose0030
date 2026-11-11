#!/usr/bin/env node
// Generates contribution heatmap SVGs that merge the public contribution
// calendars of all accounts listed in USERS:
//   contributions.svg     - trailing 365 days (main README image)
//   graphs/<year>.svg     - one per calendar year
// Also rewrites the year list in README.md between the contributions markers.
// Data source: https://github-contributions-api.jogruber.de (no auth required).
// To include private contributions, switch to the GitHub GraphQL API's
// `contributionsCollection.contributionCalendar` with a token per account.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USERS = ["MattPreston-PAS", "MattPreston-ZT", "moose0030"];
const API_BASE = "https://github-contributions-api.jogruber.de/v4";

const CELL = 10;
const GAP = 3;
const STEP = CELL + GAP;
const LEFT = 30; // weekday labels
const TOP = 22; // month labels
const BOTTOM = 28; // caption + legend
const RIGHT = 10;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const fmt = (d) => d.toISOString().slice(0, 10);
const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

async function fetchCalendar(user) {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(user)}`);
  if (!res.ok) throw new Error(`${user}: HTTP ${res.status}`);
  const json = await res.json();
  return json.contributions; // [{ date: "YYYY-MM-DD", count, level }]
}

const results = await Promise.allSettled(USERS.map(fetchCalendar));
const merged = new Map(); // date -> total count

results.forEach((r, i) => {
  if (r.status === "rejected") {
    console.error(`Skipping ${USERS[i]}: ${r.reason.message}`);
    return;
  }
  for (const day of r.value) {
    merged.set(day.date, (merged.get(day.date) ?? 0) + day.count);
  }
});

if (merged.size === 0) {
  console.error("No contribution data fetched — aborting.");
  process.exit(1);
}

// Renders a GitHub-style heatmap for dates in [from, to] (YYYY-MM-DD strings).
// Cells outside the range are left blank so calendar years align correctly.
function renderGraph({ from, to, caption }) {
  const rangeTotal = [...merged.entries()]
    .filter(([date]) => date >= from && date <= to)
    .reduce((sum, [, count]) => sum + count, 0);
  const maxCount = Math.max(0, ...[...merged.entries()]
    .filter(([date]) => date >= from && date <= to)
    .map(([, count]) => count));
  const levelFor = (count) => {
    if (!count) return 0;
    const q = Math.max(1, Math.ceil(maxCount / 4));
    return Math.min(4, Math.ceil(count / q));
  };

  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);
  const start = new Date(fromDate);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay()); // snap to Sunday

  const columns = [];
  const monthLabels = [];
  let prevMonth = null;
  for (let colStart = new Date(start); colStart <= toDate; colStart.setUTCDate(colStart.getUTCDate() + 7)) {
    const cells = [];
    let firstCellDate = null;
    for (let row = 0; row < 7; row++) {
      const d = new Date(colStart);
      d.setUTCDate(d.getUTCDate() + row);
      if (d < fromDate || d > toDate) continue;
      const date = fmt(d);
      if (!firstCellDate) firstCellDate = date;
      cells.push({ row, date, count: merged.get(date) ?? 0 });
    }
    const colIndex = columns.length;
    columns.push(cells);
    if (firstCellDate) {
      const month = Number(firstCellDate.slice(5, 7));
      if (month !== prevMonth) {
        monthLabels.push({ col: colIndex, label: MONTHS[month - 1] });
        prevMonth = month;
      }
    }
  }

  const width = LEFT + columns.length * STEP - GAP + RIGHT;
  const height = TOP + 7 * STEP - GAP + BOTTOM;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="10">
<style>
  text { fill: #7d8590; }
  .c0 { fill: #ebedf0; } .c1 { fill: #9be9a8; } .c2 { fill: #40c463; } .c3 { fill: #30a14e; } .c4 { fill: #216e39; }
  @media (prefers-color-scheme: dark) {
    text { fill: #8b949e; }
    .c0 { fill: #161b22; } .c1 { fill: #0e4429; } .c2 { fill: #006d32; } .c3 { fill: #26a641; } .c4 { fill: #39d353; }
  }
</style>
`;

  for (const { col, label } of monthLabels) {
    svg += `<text x="${LEFT + col * STEP}" y="14">${label}</text>\n`;
  }
  for (const [row, label] of [[1, "Mon"], [3, "Wed"], [5, "Fri"]]) {
    svg += `<text x="0" y="${TOP + row * STEP + CELL - 1}">${label}</text>\n`;
  }
  for (const [colIndex, cells] of columns.entries()) {
    const x = LEFT + colIndex * STEP;
    for (const cell of cells) {
      const y = TOP + cell.row * STEP;
      svg += `<rect class="c${levelFor(cell.count)}" x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2"><title>${cell.count} contribution${cell.count === 1 ? "" : "s"} on ${esc(cell.date)}</title></rect>\n`;
    }
  }

  const captionY = height - 8;
  svg += `<text x="0" y="${captionY}">${esc(caption)}</text>\n`;
  const legendX = width - 130;
  svg += `<text x="${legendX}" y="${captionY}">Less</text>\n`;
  for (let i = 0; i < 5; i++) {
    svg += `<rect class="c${i}" x="${legendX + 28 + i * STEP}" y="${captionY - CELL + 1}" width="${CELL}" height="${CELL}" rx="2"/>\n`;
  }
  svg += `<text x="${legendX + 28 + 5 * STEP + 3}" y="${captionY}">More</text>\n</svg>\n`;

  return { svg, total: rangeTotal, weeks: columns.length, maxCount };
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const today = fmt(new Date());
const currentYear = Number(today.slice(0, 4));

// Trailing 365 days — the main README image.
const cutoff = fmt(new Date(Date.now() - 365 * 86400000));
const main = renderGraph({
  from: cutoff,
  to: today,
  caption: `${[...merged.entries()].filter(([d]) => d >= cutoff).reduce((s, [, c]) => s + c, 0).toLocaleString("en-US")} contributions in the last year across ${USERS.length} accounts`,
});
writeFileSync(join(root, "contributions.svg"), main.svg);
console.log(`contributions.svg: ${main.total} contributions, ${main.weeks} weeks, max ${main.maxCount}/day`);

// One graph per calendar year, from the earliest year with data to now.
const firstYear = Math.min(...[...merged.keys()].map((d) => Number(d.slice(0, 4))));
const graphsDir = join(root, "graphs");
rmSync(graphsDir, { recursive: true, force: true });
mkdirSync(graphsDir, { recursive: true });

const years = [];
for (let year = currentYear; year >= firstYear; year--) {
  const to = year === currentYear ? today : `${year}-12-31`;
  const total = [...merged.entries()]
    .filter(([d]) => d >= `${year}-01-01` && d <= to)
    .reduce((s, [, c]) => s + c, 0);
  const { svg } = renderGraph({
    from: `${year}-01-01`,
    to,
    caption: `${total.toLocaleString("en-US")} contributions in ${year}`,
  });
  writeFileSync(join(graphsDir, `${year}.svg`), svg);
  years.push({ year, total });
}

// Rewrite the year list inside the README markers so new years appear
// automatically when the scheduled workflow runs.
const readmePath = join(root, "README.md");
const START = "<!-- contributions:start -->";
const END = "<!-- contributions:end -->";
// "Pick a year" navbar: each link opens that year's rendered SVG full-size.
// (READMEs can't run JS, so raw-file links are the closest thing to a selector.)
const rawBase = `https://raw.githubusercontent.com/moose0030/moose0030/main/graphs`;
const picker = `**Pick a year:** ${years.map(({ year }) => `[${year}](${rawBase}/${year}.svg)`).join(" · ")}`;

const block = `${picker}\n\n` + years
  .map(({ year, total }) => {
    const open = year === currentYear ? " open" : "";
    return `<details${open}>\n<summary><b>${year}</b> — ${total.toLocaleString("en-US")} contributions</summary>\n\n<img src="graphs/${year}.svg" alt="${year} combined contribution graph" />\n\n</details>`;
  })
  .join("\n\n");

const readme = readFileSync(readmePath, "utf8");
const startIdx = readme.indexOf(START);
const endIdx = readme.indexOf(END);
if (startIdx === -1 || endIdx === -1) {
  console.error("README.md is missing the contributions markers — not updated.");
} else {
  const next = `${readme.slice(0, startIdx + START.length)}\n${block}\n${readme.slice(endIdx)}`;
  writeFileSync(readmePath, next);
  console.log(`README.md updated (${years.length} years)`);
}
