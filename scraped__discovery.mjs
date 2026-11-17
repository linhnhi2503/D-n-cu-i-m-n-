import { normalize, questionsFrom } from "./business.mjs";

export function proposeScope(business, sources) {
  const questions = questionsFrom(business.questions);
  const columns = sources.flatMap(source => source.dataset.columns.map(normalize));
  const hasDate = columns.some(name => /^(?:thang|ngay|date|month|period)(?: |$)/.test(name));
  const hasCost = columns.some(name => /^(?:chi phi|gia von|cost|cogs)(?: |$)/.test(name));
  const hasRevenue = columns.some(name => /^(?:doanh thu|revenue|net sales)(?: |$)/.test(name));
  const suggestions = [
    hasDate
      ? "So sánh kỳ mới nhất với kỳ trước trên cùng phạm vi và xác định nhóm đóng góp vào thay đổi."
      : "Bổ sung cột ngày hoặc tháng nếu cần đo xu hướng và so sánh theo kỳ.",
    hasCost && hasRevenue
      ? "Xem thêm lợi nhuận hoặc biên lợi nhuận nếu doanh thu và chi phí cùng phạm vi, đơn vị và định nghĩa."
      : "Xác định chỉ số chính và bổ sung các cột cần thiết nếu muốn phân tích chi phí hoặc lợi nhuận.",
  ];
  const followups = [
    hasDate ? "Bạn muốn xem toàn bộ dữ liệu hay tập trung vào tháng hoặc quý nào?" : "Báo cáo cần phản ánh giai đoạn nào? Có nguồn nào chứa ngày hoặc tháng không?",
    "Bạn sẽ dùng báo cáo để ra quyết định gì và chỉ số nào cần ưu tiên?",
    "Bạn muốn so với kỳ trước, mục tiêu hay một nhóm cụ thể? Nếu có mục tiêu, giá trị và đơn vị là gì?",
  ];
  if (sources.length > 1) followups.push("Các bộ dữ liệu có cùng thời gian và đơn vị đo không? Nếu cần đối chiếu giữa các bộ, trường nào liên kết được chúng?");
  return {
    interpretation: "Bạn muốn phân tích " + business.industry.trim() + " qua " + questions.length + " câu hỏi. Trọng tâm đầu tiên là “" + questions[0] + "”.",
    suggestions,
    followups,
  };
}
