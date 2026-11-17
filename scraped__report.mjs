import { evidenceText, normalize } from "./business.mjs";
import { breakdown, isBlank } from "./data.mjs";
import { buildExecutiveDashboard } from "./dashboard.mjs";

export const priorityNames = { high: "Cao", medium: "Vừa", low: "Thấp" };

export function reportTopic(facts, index) {
  if (!facts.length) return "Chuyên đề " + (index + 1) + " · Dữ liệu cần bổ sung";
  const metrics = [...new Set(facts.map(fact => fact.metric))];
  if (metrics.length > 1) {
    return metrics.slice(0, 2).join(" và ") + (metrics.length > 2 ? " · " + metrics.length + " chỉ số" : "");
  }
  const group = facts[0].group;
  const sharedGrouping = facts.every(fact => fact.groupCount && fact.group === group);
  return metrics[0] + (sharedGrouping ? " theo " + group : "");
}

export function reportNarrative(business, evidence, sources, ai) {
  const leadingFacts = evidence.flatMap(({ facts }) => facts.slice(0, 1));
  const gaps = evidence.filter(({ facts, caveats }) => !facts.length || caveats.length);
  const money = new Intl.NumberFormat("vi-VN", { maximumSignificantDigits: 9 });
  const percent = new Intl.NumberFormat("vi-VN", { style: "percent", maximumFractionDigits: 1 });
  const periodFindings = sources.flatMap(source => {
    const data = buildExecutiveDashboard(source);
    const revenue = data.kpis.find(item => item.key === "revenue");
    const driver = data.drivers[0];
    if (revenue.delta == null) return [];
    const unit = revenue.unit ? " " + revenue.unit : "";
    const direction = revenue.delta > 0 ? "tăng" : revenue.delta < 0 ? "giảm" : "bằng";
    const change = revenue.change == null ? "" : " (" + percent.format(Math.abs(revenue.change)) + ")";
    return [source.name + " · Doanh thu " + data.period + " " + direction + " so với " + data.previousPeriod +
      (revenue.delta === 0 ? "." : " " + money.format(Math.abs(revenue.delta)) + unit + change + ".") +
      (driver && driver.value ? " Nhóm “" + driver.label + "” thay đổi nhiều nhất theo độ lớn, " +
        (driver.value > 0 ? "tăng " : "giảm ") + money.format(Math.abs(driver.value)) + unit + "." : "")];
  }).slice(0, 3);
  const recommendations = [];
  if (gaps.length) {
    recommendations.push({
      action: "Bổ sung dữ liệu cho các chuyên đề còn thiếu chỉ số",
      reason: gaps.length + " chuyên đề cần thêm dữ liệu hoặc cần xác định rõ phạm vi so sánh.",
      measure: "Tỷ lệ chuyên đề có đủ dữ liệu để kết luận.",
      priority: "high",
    });
  }
  const incomplete = sources.filter(source => source.dataset.audit.missing > 0);
  if (incomplete.length) {
    recommendations.push({
      action: "Rà soát các cột còn thiếu trước kỳ báo cáo tiếp theo",
      reason: incomplete.map(source => source.name).join(", ") + " có ô trống sau làm sạch.",
      measure: "Tỷ lệ ô có dữ liệu ở từng cột dùng để tính chỉ số.",
      priority: "medium",
    });
  }
  const groupedFact = leadingFacts.find(fact => fact.groupCount);
  if (groupedFact) {
    recommendations.push({
      action: "Theo dõi " + groupedFact.metric + " theo " + groupedFact.group + " ở kỳ tiếp theo",
      reason: "“" + groupedFact.top + "” đang ở một đầu bảng xếp hạng trong " + groupedFact.source + ". So sánh các kỳ có cùng phạm vi trước khi phân bổ nguồn lực.",
      measure: groupedFact.metric + " theo từng nhóm và mức thay đổi giữa hai kỳ tương đương.",
      priority: "medium",
    });
  }
  if (!recommendations.length) {
    recommendations.push({
      action: "Thiết lập kỳ đối chiếu cho các chỉ số trong báo cáo",
      reason: "Một lần tổng hợp chỉ phản ánh phạm vi của dữ liệu hiện tại. Hai kỳ tương đương giúp theo dõi sự thay đổi.",
      measure: "Giá trị chỉ số theo kỳ và độ phủ dữ liệu mỗi kỳ.",
      priority: "medium",
    });
  }

  return {
    summary: ai?.note || (leadingFacts.length
      ? leadingFacts.slice(0, 2).map(evidenceText).join("\n\n")
      : "Báo cáo tổng hợp dữ liệu hiện có của lĩnh vực " + business.industry + ". Cần xác định tên chỉ số hoặc bổ sung nguồn trước khi đưa ra kết luận."),
    conclusions: ai?.conclusions?.length ? ai.conclusions : [
      ...leadingFacts.map(evidenceText),
      ...periodFindings,
      ...(gaps.length ? [gaps.length + " chuyên đề còn giới hạn về dữ liệu hoặc cách so sánh."] : []),
    ],
    recommendations: ai?.recommendations?.length ? ai.recommendations : recommendations,
    limitations: [...new Set([
      ...gaps.flatMap(({ caveats }) => caveats),
      ...(ai?.limitations ?? []),
    ])],
  };
}

export function timeSeries(source) {
  const { dataset, analysis, columns } = source;
  const metric = columns[analysis.metric];
  const time = columns.find(column => /^(?:thang|ngay|nam|month|date|year)(?: |$)/.test(normalize(column.name)));
  if (!time || (analysis.mode !== "count" && time.index === metric?.index)) return null;

  const periods = dataset.rows.map(row => row[time.index].trim());
  const present = periods.filter(value => !isBlank(value));
  const isoMonth = /^\d{4}-(?:0[1-9]|1[0-2])$/;
  const isoDate = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
  if (!present.length || (!present.every(value => isoMonth.test(value)) && !present.every(value => isoDate.test(value)))) return null;

  const periodRows = dataset.rows.flatMap((row, index) => {
    const period = periods[index];
    return period ? [period === row[time.index] ? row : row.with(time.index, period)] : [];
  });
  const groups = breakdown({ ...dataset, rows: periodRows }, { ...analysis, group: time.index })
    .sort((a, b) => a.label.localeCompare(b.label));
  if (groups.length < 2) return null;
  return { groups: groups.slice(-12), count: groups.length, missing: dataset.rows.length - periodRows.length, column: time.name };
}
