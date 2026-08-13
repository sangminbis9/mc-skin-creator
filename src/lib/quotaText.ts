/** Gemini quota 리셋 시각 표시용 문자열 (사용자 로컬 시간대). */
export function formatResetTime(resetAtIso: string): string {
  const date = new Date(resetAtIso);
  if (Number.isNaN(date.getTime())) {
    return "제공자 한도 갱신 시각";
  }
  const formatter = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return formatter.format(date);
}
