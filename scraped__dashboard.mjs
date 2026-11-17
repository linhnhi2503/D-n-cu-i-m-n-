import { normalize } from "./business.mjs";
import { toNumber } from "./data.mjs";

const definitions = [
  { key: "orders", title: "Số đơn hàng", names: /^(?:so (?:luong )?don(?: hang)?|don hang|so giao dich|orders|order count|transactions|number of sales)(?: |$)/ },
  { key: "revenue", title: "Doanh thu", names: /^(?:tong doanh thu|doanh thu|revenue|sales revenue|net sales|total sales)(?: |$)/ },
  { key: "profit", title: "Lợi nhuận", names: /^(?:loi nhuan|gross profit|net profit|profit)(?: |$)/ },
  { key: "cost", title: "Chi phí", names: /^(?:tong chi phi|chi phi|gia von|cost|total cost|expenses|spend|cogs)(?: |$)/ },
];

const excludedMetric = /\b(?:ty le|ti le|rate|margin|trung binh|average|per|tren|phan tram|growth|muc tieu|target|chenh lech)\b/;
const exactDimensions = [
  /^(?:kenh|channel)(?: |$)/, /^(?:chien dich|campaign)(?: |$)/,
  /^(?:khu vuc|region|thi truong|market)(?: |$)/, /^(?:san pham|product|danh muc|category)(?: |$)/,
  /^(?:chi nhanh|branch|cua hang|store)(?: |$)/,
];

function currencyOf(label) {
  if (/\bVND\b|VNĐ|₫|(?:^|[\s(])đồng(?:[\s)]|$)/iu.test(label)) return "VND";
  if (/\bUSD\b|US\$/i.test(label)) return "USD";
  if (/\bEUR\b|€/i.test(label)) return "EUR";
  return "";
}

export function dashboardMetricColumns(columns) {
  return definitions.map(definition => {
    const candidates = columns.filter(column =>
      column.numeric && !column.percent && definition.names.test(normalize(column.name)) &&
      !excludedMetric.test(normalize(column.name)));
    const canonical = candidates.filter(column => /^(?:so don(?: hang)?|(?:tong )?doanh thu|(?:tong )?chi phi|(?:tong )?loi nhuan|orders|order count|revenue|total cost|profit)(?: (?:vnd|usd|eur))?$/.test(normalize(column.name)));
    const column = canonical.length === 1 ? canonical[0] : candidates.length === 1 ? candidates[0] : null;
    return { ...definition, column, ambiguous: candidates.length > 1 && !column };
  });
}

function validMonth(year, month, day = 1) {
  if (year < 1900 || month < 1 || month > 12 || day < 1) return "";
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return "";
  return String(year) + "-" + String(month).padStart(2, "0");
}

function monthOf(value) {
  const input = value.trim();
  const iso = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(input);
  if (iso) return validMonth(+iso[1], +iso[2], iso[3] ? +iso[3] : 1);
  const vi = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input);
  return vi ? validMonth(+vi[3], +vi[2], +vi[1]) : "";
}

function getPeriods({ dataset, columns, analysis }) {
  const date = columns.find(column => /^(?:thang|ngay|ky|date|month|period|order date|ngay ban)(?: |$)/.test(normalize(column.name)));
  if (!date) return { date: null, months: [], byMonth: new Map(), invalidDates: 0 };
  const byMonth = new Map();
  let invalidDates = 0;
  for (const row of dataset.rows) {
    const value = row[date.index];
    // Day/month dates follow the dataset's Vietnamese number/locale setting.
    const month = analysis.locale === "en" && value.includes("/") ? "" : monthOf(value);
    if (!month) {
      invalidDates++;
      continue;
    }
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(row);
  }
  return { date, months: [...byMonth.keys()].sort(), byMonth, invalidDates };
}

function priorMonth(period) {
  const [year, month] = period.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return date.toISOString().slice(0, 7);
}

function totals(rows, column, locale) {
  if (!column) return { value: null, covered: 0 };
  let value = 0;
  let covered = 0;
  for (const row of rows) {
    const number = toNumber(row[column.index], locale);
    if (number === null) continue;
    value += number;
    covered++;
  }
  return { value: covered ? value : null, covered };
}

function groupedTotals(rows, dimension, metric, locale) {
  if (!dimension || !metric) return [];
  const groups = new Map();
  for (const row of rows) {
    const number = toNumber(row[metric.index], locale);
    if (number === null) continue;
    const key = row[dimension.index].trim() || "(Ô trống)";
    groups.set(key, (groups.get(key) ?? 0) + number);
  }
  return [...groups].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

export function buildExecutiveDashboard(source, selectedPeriod) {
  const { dataset, columns, analysis } = source;
  const { locale } = analysis;
  const metrics = dashboardMetricColumns(columns);
  const { date, months, byMonth, invalidDates } = getPeriods(source);
  const period = selectedPeriod === "all" || byMonth.has(selectedPeriod) ? selectedPeriod : months.at(-1) ?? "all";
  const current = period === "all" ? dataset.rows : byMonth.get(period);
  const previousPeriod = period === "all" ? null : priorMonth(period);
  const previous = byMonth.get(previousPeriod) ?? [];
  const kpis = metrics.map(({ key, title, column, ambiguous }) => {
    const now = totals(current, column, locale);
    const before = totals(previous, column, locale);
    const comparable = Boolean(previous.length && now.covered === current.length && before.covered === previous.length);
    return { key, title, column: column?.name ?? null, ambiguous, unit: column && key !== "orders" ? currencyOf(column.name) : "",
      value: now.value, covered: now.covered, previous: before.value,
      delta: comparable ? now.value - before.value : null,
      change: comparable && before.value > 0 ? (now.value - before.value) / before.value : null };
  });
  const findColumn = key => metrics.find(metric => metric.key === key).column;
  const salesColumn = findColumn("revenue");
  const costColumn = findColumn("cost");
  const dimension = exactDimensions.map(pattern =>
    columns.find(column => !column.numeric && column.distinct > 1 && pattern.test(normalize(column.name)))).find(Boolean);

  const series = salesColumn ? months.filter(month => period === "all" || month <= period).slice(-12).map(month => ({
    label: month, ...totals(byMonth.get(month), salesColumn, locale), count: byMonth.get(month).length,
  })) : [];
  const salesGroups = groupedTotals(current, dimension, salesColumn, locale);
  const costGroups = groupedTotals(current, dimension, costColumn, locale);
  const revenue = kpis.find(item => item.key === "revenue");
  const profit = kpis.find(item => item.key === "profit");
  const orders = kpis.find(item => item.key === "orders");
  const margin = revenue.value > 0 && profit.covered === current.length && revenue.covered === current.length && profit.unit === revenue.unit
    ? profit.value / revenue.value : null;
  const orderValue = orders.value > 0 && orders.covered === current.length && revenue.covered === current.length
    ? revenue.value / orders.value : null;
  let drivers = [];
  if (revenue.delta !== null && dimension) {
    const previousGroups = new Map(groupedTotals(previous, dimension, salesColumn, locale).map(group => [group.label, group.value]));
    const currentGroups = new Map(salesGroups.map(group => [group.label, group.value]));
    drivers = [...new Set([...currentGroups.keys(), ...previousGroups.keys()])].map(label => ({
      label, value: (currentGroups.get(label) ?? 0) - (previousGroups.get(label) ?? 0),
    })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  }
  return {
    period, months, previousPeriod: previous.length ? previousPeriod : null, invalidDates,
    dateColumn: date?.name ?? null, rows: current.length, datasetRows: dataset.rows.length,
    kpis, dimension: dimension?.name ?? null, salesGroups, costGroups, series, drivers, margin, orderValue,
  };
}
