export const maxBytes = 5 * 1024 * 1024;
const maxRows = 20001;
const maxColumns = 200;
const maxCells = 500000;

export function sheetLink(input) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Hãy dán đường dẫn đầy đủ từ Google Sheets.");
  }
  const match = url.pathname.match(/^\/spreadsheets\/(?:u\/\d+\/)?d\/(e\/)?([\w-]{10,180})(?:\/|$)/);
  if (url.origin !== "https://docs.google.com" || url.username || url.password || !match) {
    throw new Error("Đường dẫn cần thuộc Google Sheets. Hãy sao chép liên kết chia sẻ từ bảng tính.");
  }
  const gid = new URLSearchParams(url.hash.slice(1)).get("gid") ?? url.searchParams.get("gid") ?? "";
  if (gid && !/^\d{1,16}$/.test(gid)) throw new Error("Mã tab trong liên kết không hợp lệ.");
  const root = `https://docs.google.com/spreadsheets/d/${match[1] ?? ""}${match[2]}`;
  const path = match[1] ? "pub?output=csv&single=true" : "export?format=csv";
  return {
    exportUrl: `${root}/${path}${gid || match[1] ? "&gid=" + (gid || "0") : ""}`,
    name: gid ? `Google Sheets · tab ${gid}` : "Google Sheets",
  };
}

function delimiterFor(text) {
  const separators = [",", ";", "\t"];
  const lines = [];
  let quoted = false;
  let counts = [0, 0, 0];
  let hasContent = false;
  for (let i = 0; i < text.length && lines.length < 12; i++) {
    const char = text[i];
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === "\n" || char === "\r") {
      if (hasContent) lines.push(counts);
      counts = [0, 0, 0];
      hasContent = false;
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else {
      const index = separators.indexOf(char);
      if (index !== -1) counts[index]++;
      if (char !== " ") hasContent = true;
    }
  }
  if (hasContent) lines.push(counts);
  const scores = separators.map((_, column) => {
    const first = lines[0]?.[column] ?? 0;
    return first ? lines.filter(line => line[column] === first).length + 1 : 0;
  });
  return separators[scores.indexOf(Math.max(...scores))];
}

export function parseCSV(input, delimiter) {
  const text = input.replace(/^\uFEFF/, "");
  const separator = delimiter ?? delimiterFor(text);
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  let width = 0;
  const addField = () => {
    row.push(field);
    field = "";
    afterQuote = false;
    if (row.length > maxColumns) throw new Error("Mỗi bảng có thể có tối đa 200 cột.");
  };
  const addRow = () => {
    addField();
    rows.push(row);
    width = Math.max(row.length, width);
    if (rows.length > maxRows || rows.length * width > maxCells) {
      throw new Error("Bảng vượt giới hạn 20.000 dòng dữ liệu hoặc 500.000 ô.");
    }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
        afterQuote = true;
      }
    } else if (char === separator) {
      addField();
    } else if (char === "\n" || char === "\r") {
      addRow();
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else if (char === '"' && !field && !afterQuote) {
      quoted = true;
    } else if (!afterQuote) {
      field += char;
    } else if (char !== " " && char !== "\t") {
      throw new Error("Tệp CSV có giá trị đặt trong dấu ngoặc kép sai định dạng.");
    }
  }
  if (quoted) throw new Error("Tệp CSV có dấu ngoặc kép chưa đóng.");
  if (field || row.length || afterQuote) addRow();
  if (!rows.some(values => values.some(value => value.trim()))) {
    throw new Error("Bảng này hiện chưa có dữ liệu.");
  }
  return rows.map(values => Array.from({ length: width }, (_, i) => values[i] ?? ""));
}

export const isBlank = value => value == null || value.trim() === "";

export function prepare(raw, config, excludedRows = new Set()) {
  const headerIndex = config.headers ? raw.findIndex(row => !row.every(isBlank)) : -1;
  const header = headerIndex >= 0 ? raw[headerIndex] : raw[0].map(() => "");
  const names = new Set();
  const columns = header.map((value, index) => {
    const label = (config.trim ? value.trim() : value) || `Cột ${index + 1}`;
    let name = label;
    for (let suffix = 2; names.has(name); suffix++) name = `${label} (${suffix})`;
    names.add(name);
    return name;
  });
  const seen = new Set();
  const rows = [];
  const audit = { empty: 0, duplicates: 0, incomplete: 0, excluded: 0, trimmed: 0, missing: 0, original: raw.length - Number(headerIndex >= 0) };
  raw.forEach((original, index) => {
    if (index === headerIndex) return;
    if (excludedRows.has(index)) {
      audit.excluded++;
      return;
    }
    if (config.empty && original.every(isBlank)) {
      audit.empty++;
      return;
    }
    const missing = original.filter(isBlank).length;
    if (config.incomplete && missing) {
      audit.incomplete++;
      return;
    }
    const values = config.trim ? original.map(value => value.trim()) : original;
    if (config.duplicates) {
      const key = JSON.stringify(values);
      if (seen.has(key)) {
        audit.duplicates++;
        return;
      }
      seen.add(key);
    }
    audit.trimmed += values.filter((value, i) => value !== original[i]).length;
    audit.missing += missing;
    rows.push(values);
  });
  return { columns, rows, audit };
}

export function toNumber(value, locale) {
  if (isBlank(value)) return null;
  let string = value.trim().replace(/[−]/g, "-");
  const percent = string.endsWith("%");
  if (percent) string = string.slice(0, -1).trimEnd();
  if (/^[+-]?0\d/.test(string)) return null;
  const rules = {
    vi: /^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/,
    en: /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/,
  };
  if (!rules[locale].test(string)) return null;
  string = locale === "vi" ? string.replaceAll(".", "").replace(",", ".") : string.replaceAll(",", "");
  const number = Number(string);
  return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER
    ? number / (percent ? 100 : 1)
    : null;
}

const sum = values => values.reduce((total, value) => total + value, 0);

export function profile(dataset, locale) {
  return dataset.columns.map((name, index) => {
    const values = dataset.rows.map(row => row[index]).filter(value => !isBlank(value));
    const distinct = new Set(values).size;
    const numbers = values.map(value => toNumber(value, locale));
    const numeric = numbers.length > 0 && numbers.every(value => value !== null);
    const total = numeric ? sum(numbers) : null;
    return {
      name, index, numeric, percent: numeric && values.every(value => value.trimEnd().endsWith("%")), distinct,
      missing: dataset.rows.length - values.length,
      total,
      mean: numeric ? total / numbers.length : null,
      min: numeric ? numbers.reduce((min, value) => Math.min(min, value), Infinity) : null,
      max: numeric ? numbers.reduce((max, value) => Math.max(max, value), -Infinity) : null,
    };
  });
}

export function breakdown(dataset, settings) {
  const groups = new Map();
  for (const row of dataset.rows) {
    const label = isBlank(row[settings.group]) ? null : row[settings.group];
    let group = groups.get(label);
    if (!group) {
      group = { label, count: 0, total: 0 };
      groups.set(label, group);
    }
    const value = settings.mode === "count" ? 1 : toNumber(row[settings.metric], settings.locale);
    if (value === null) continue;
    group.count++;
    group.total += value;
  }
  return [...groups.values()]
    .filter(group => group.count)
    .map(group => ({
      label: group.label ?? "(Ô trống)",
      value: settings.mode === "mean" ? group.total / group.count : group.total,
      count: group.count,
    }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, "vi"));
}

export function csvOutput(dataset) {
  const safeCell = value => {
    const dangerous = /^[\s\uFEFF]*[=+\-@＝＋－＠]/u.test(value) && !/^[+-]?\d+(?:[.,]\d+)*%?$/.test(value);
    const safe = dangerous || /^[\r\n\t]/.test(value) ? "'" + value : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  };
  return "\uFEFF" + [dataset.columns, ...dataset.rows].map(row => row.map(safeCell).join(",")).join("\r\n");
}

export const sampleCSV = `Tháng,Khu vực,Kênh,Sản phẩm,Số đơn,Doanh thu
2026-01,Miền Bắc,Website,Gói Starter,42,12600000
2026-01,Miền Nam,Cửa hàng,Gói Pro,28,19600000
2026-01,Miền Trung,Website,Gói Starter,18,5400000
2026-01,Miền Bắc,Đối tác,Gói Pro,21,14700000
2026-02,Miền Bắc,Website,Gói Growth,38,19000000
2026-02,Miền Nam,Cửa hàng,Gói Starter,55,16500000
2026-02,Miền Trung,Đối tác,Gói Pro,19,13300000
2026-02,Miền Nam,Website,Gói Growth,36,18000000
2026-02,Miền Nam,Website,Gói Growth,36,18000000
2026-03,"  Miền Bắc ",Website,Gói Pro,33,23100000
2026-03,Miền Nam,Đối tác,Gói Growth,47,23500000
2026-03,Miền Trung,Cửa hàng,Gói Starter,29,8700000
2026-03,Miền Nam,Website,Gói Pro,42,29400000
2026-03,Miền Bắc,,Gói Growth,31,15500000
,,,,,
2026-04,Miền Bắc,Cửa hàng,Gói Starter,58,17400000
2026-04,Miền Nam,Website,Gói Pro,51,35700000
2026-04,Miền Trung,Đối tác,Gói Growth,32,16000000
2026-04,Miền Nam,Website,Gói Starter,66,19800000
2026-04,Miền Bắc,Đối tác,Gói Pro,25,17500000
2026-04,Miền Nam,Cửa hàng,Gói Growth,46,23000000
2026-04,Miền Trung,Website,Gói Starter,34,10200000`;
