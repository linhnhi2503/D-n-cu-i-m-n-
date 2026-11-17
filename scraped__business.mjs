import { breakdown } from "./data.mjs";

const metricNames = [
  { terms: /doanh thu|revenue|sales amount/, column: /doanh thu|revenue|sales amount/, additive: true },
  { terms: /loi nhuan|profit/, column: /loi nhuan|profit/, additive: true },
  { terms: /chi phi|chi tieu|cost|spend|expense/, column: /chi phi|chi tieu|cost|spend|expense/, additive: true },
  { terms: /so don|don hang|orders/, column: /so don|order count|orders/, additive: true },
  { terms: /luot nhap|click/, column: /luot nhap|click/, additive: true },
  { terms: /luot hien thi|impression/, column: /luot hien thi|impression/, additive: true },
  { terms: /chuyen doi|conversion/, column: /chuyen doi|conversion/, additive: true },
  { terms: /ton kho|inventory|stock/, column: /ton kho|inventory|stock/, additive: false },
  { terms: /thoi gian|duration|latency/, column: /thoi gian|duration|latency/, additive: false },
];
const dimensions = [
  /kenh|channel/, /khu vuc|region|market|tinh thanh/, /san pham|product|sku/,
  /chien dich|campaign/, /thang|ngay|tuan|quy|nam|month|date|week|quarter|year/,
  /khach hang|customer/, /chi nhanh|cua hang|branch|store/,
];

export const normalize = value => value.toLowerCase().normalize("NFD")
  .replace(/\p{Diacritic}/gu, "").replace(/đ/g, "d").replace(/[^a-z0-9]+/g, " ").trim();

export function questionsFrom(text) {
  return (text.match(/[^?\n]+[?]?/g) ?? []).map(question => question.trim()).filter(Boolean);
}

function matchesName(name, text) {
  return name.length >= 3 && (" " + text + " ").includes(" " + name + " ");
}

function relatedMetrics(question, columns) {
  const wanted = metricNames.filter(metric => metric.terms.test(question));
  const matched = columns.filter(column => column.numeric).flatMap(column => {
    const name = normalize(column.name);
    const known = wanted.find(metric => metric.column.test(name));
    const exact = matchesName(name, question);
    return exact || known ? [{ column, name, known, exact }] : [];
  });
  // Prioritize metrics named in the question. Counts and rates have distinct units.
  const requestsRate = /ty le|ti le|rate|phan tram|bao nhieu phan tram/.test(question);
  return matched.filter(({ column, name }) => {
    const rateColumn = column.percent || /ty le|ti le|rate|phan tram|ctr|cvr|cpc|cpa|roas/.test(name);
    return requestsRate ? rateColumn : !rateColumn || matchesName(name, question);
  }).sort((a, b) => Number(b.exact) - Number(a.exact)).slice(0, 2);
}

function groupingPhrase(question) {
  const explicit = /\b(?:theo|by)\s+(.+)/.exec(question);
  if (explicit) return explicit[1];
  return /\b(kenh|khu vuc|san pham|chien dich|thang|ngay|tuan|quy|nam|chi nhanh|cua hang)\b(?:\s+ban)?\s+nao\b/.exec(question)?.[1]
    ?? /\bwhich\s+(channel|region|product|campaign|month|branch|store)\b/.exec(question)?.[1];
}

function groupFor(phrase, columns, metric) {
  if (!phrase) return null;
  const eligible = columns.filter(column => column.index !== metric.index && column.distinct > 1);
  const exact = eligible.find(column => matchesName(normalize(column.name), phrase));
  if (exact) return exact;
  const dimension = dimensions.find(pattern => pattern.test(phrase));
  return dimension ? eligible.find(column => dimension.test(normalize(column.name))) : null;
}

export function collectBusinessEvidence(sources, questions) {
  return questions.map(question => {
    const query = normalize(question);
    const grouping = groupingPhrase(query);
    const average = /trung binh|binh quan|average|mean/.test(query);
    const order = /\b(thap nhat|nho nhat|lowest|smallest)\b/.test(query) ? "last" : "first";
    const complex = /xu huong|tang truong|trend|growth|nguyen nhan|vi sao|tai sao|du bao|forecast|tuong quan|correlation/.test(query);
    const facts = sources.flatMap((source, index) => {
      const { columns, dataset, analysis } = source;
      const sourceLabel = "Bộ " + (index + 1) + " — " + source.name;
      return relatedMetrics(query, columns).map(({ column, known }) => {
        const isRate = column.percent || /ty le|ti le|rate|phan tram|ctr|cvr|cpc|cpa|roas/.test(normalize(column.name));
        const mode = !average && !isRate && known?.additive ? "sum" : "mean";
        const group = groupFor(grouping, columns, column);
        const leaders = group && !complex ? breakdown(dataset, { ...analysis, group: group.index, metric: column.index, mode }) : [];
        const first = order === "last" ? leaders.at(-1) : leaders[0];
        return {
          source: sourceLabel, metric: column.name, percent: column.percent, mode,
          value: mode === "sum" ? column.total : column.mean,
          nonempty: dataset.rows.length - column.missing,
          rows: dataset.rows.length,
          group: group?.name, top: first?.label, topValue: first?.value, groupCount: leaders.length, order,
          groups: order === "last" ? leaders.slice(-8).reverse() : leaders.slice(0, 8),
        };
      });
    });
    const caveats = [];
    if (complex) caveats.push("Các chỉ số hiện có mang tính mô tả. Cần phân tích thêm để đánh giá xu hướng, mối liên hệ hoặc nguyên nhân.");
    if (grouping && facts.length && facts.every(fact => !fact.groupCount)) {
      caveats.push("Chưa xác định được phân nhóm phù hợp trong các bộ dữ liệu.");
    }
    if (!facts.length) caveats.push("Chưa đủ dữ liệu để tính chỉ số. Cần xác định cột tương ứng, công thức tính hoặc nguồn bổ sung.");
    return { question, facts, caveats };
  });
}

const numbers = new Intl.NumberFormat("vi-VN", { maximumSignificantDigits: 10 });
const percentages = new Intl.NumberFormat("vi-VN", { style: "percent", maximumSignificantDigits: 8 });

export function evidenceText(fact) {
  const format = value => (fact.percent ? percentages : numbers).format(value);
  const mode = fact.mode === "sum" ? "tổng" : "trung bình";
  const metric = fact.groupCount
    ? 'Nhóm “' + fact.top + '” có ' + mode + ' “' + fact.metric + '” ' +
      (fact.order === "last" ? "thấp nhất" : "cao nhất") + " trong " + fact.groupCount +
      ' nhóm theo “' + fact.group + '” (' + format(fact.topValue) + ")."
    : mode[0].toUpperCase() + mode.slice(1) + ' “' + fact.metric + '” là ' + format(fact.value) + ".";
  return fact.source + " · " + metric + " Cột này có số liệu ở " + numbers.format(fact.nonempty) +
    "/" + numbers.format(fact.rows) + " dòng.";
}
